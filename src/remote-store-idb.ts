import {
  RemoteRecord,
  RemoteStore,
  resolveDuplicate,
} from "./remote-store";

/**
 * IndexedDB-backed RemoteStore. Keeps the fetched Drive listing OUTSIDE the JS
 * heap so a large listing doesn't OOM-kill the iOS WebView at reconcile time.
 *
 * One object store keyed by `path`. A record carries an `ambiguous` flag (dup
 * with differing content -> excluded from both sides). Range queries drive the
 * subtree check. All ops are async.
 *
 * A run uses a UNIQUE database name (per target + run token) and deletes it on
 * dispose, so a crash can't leave stale data mistaken for a real listing.
 */
interface StoredRecord extends RemoteRecord {
  /** true = seen but ambiguous (dup, differing content) — excluded both sides. */
  ambiguous?: boolean;
}

const STORE = "remote";

// Resolve the IndexedDB globals via globalThis. Bare `indexedDB` references
// don't reliably resolve to a polyfilled global in the Node test environment;
// going through globalThis works both in the WebView and under fake-indexeddb.
function idb(): IDBFactory {
  const g = globalThis as unknown as { indexedDB?: IDBFactory };
  if (!g.indexedDB) throw new Error("indexedDB unavailable");
  return g.indexedDB;
}
function idbKeyRange(): typeof IDBKeyRange {
  return (globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange })
    .IDBKeyRange;
}

/** True when IndexedDB is available in the current runtime. */
export function indexedDbAvailable(): boolean {
  return (
    typeof (globalThis as unknown as { indexedDB?: unknown }).indexedDB !==
    "undefined"
  );
}

export class IndexedDbRemoteStore implements RemoteStore {
  private db: IDBDatabase | null = null;

  private constructor(private dbName: string) {}

  /** Opens (creating) the per-run database. */
  static async open(dbName: string): Promise<IndexedDbRemoteStore> {
    const store = new IndexedDbRemoteStore(dbName);
    store.db = await store.openDb();
    return store;
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = idb().open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "path" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }


  async clear(): Promise<void> {
    if (!this.db) throw new Error("RemoteStore not open");
    await new Promise<void>((resolve, reject) => {
      const req = this.db!.transaction(STORE, "readwrite")
        .objectStore(STORE)
        .clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async put(rec: RemoteRecord): Promise<void> {
    // The read-modify-write MUST stay within a single transaction with NO await
    // between the get and the put: an IndexedDB transaction auto-commits as soon
    // as control returns to the event loop with no pending request on it, so an
    // `await` mid-transaction yields "without an in-progress transaction". We
    // therefore issue the follow-up put synchronously inside the get's success
    // callback (same tick, same transaction).
    if (!this.db) throw new Error("RemoteStore not open");
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getReq = store.get(rec.path);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredRecord | undefined;
        let toStore: StoredRecord | null = null;
        if (existing?.ambiguous) {
          toStore = null; // stays ambiguous, no write
        } else if (!existing) {
          toStore = { ...rec };
        } else {
          const res = resolveDuplicate(existing, rec);
          if (res.ambiguous) toStore = { ...existing, ambiguous: true };
          else if (res.keep) toStore = { ...res.keep };
        }
        if (toStore === null) {
          resolve();
          return;
        }
        // Same transaction, synchronous — still in-progress.
        const putReq = store.put(toStore);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve();
      };
    });
  }

  /**
   * Fetch one raw record in a self-contained transaction. The request is issued
   * inside the promise executor (synchronous with tx creation), never after an
   * await — so the transaction can't auto-commit before the request runs
   * ("without an in-progress transaction"). All single-record reads go through
   * this rather than the tx()+reqP two-step, which was fragile on WebKit.
   */
  private rawGet(path: string): Promise<StoredRecord | undefined> {
    if (!this.db) throw new Error("RemoteStore not open");
    return new Promise((resolve, reject) => {
      const req = this.db!.transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(path);
      req.onsuccess = () => resolve(req.result as StoredRecord | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async get(path: string): Promise<RemoteRecord | undefined> {
    const r = await this.rawGet(path);
    return r && !r.ambiguous ? this.strip(r) : undefined;
  }

  async has(path: string): Promise<boolean> {
    return (await this.get(path)) !== undefined;
  }

  async isAmbiguous(path: string): Promise<boolean> {
    const r = await this.rawGet(path);
    return !!r?.ambiguous;
  }

  async ambiguousPaths(): Promise<string[]> {
    const out: string[] = [];
    await this.cursorEach((r) => {
      if (r.ambiguous) out.push(r.path);
    });
    return out;
  }

  async count(): Promise<number> {
    // Count only non-ambiguous. IndexedDB .count() includes ambiguous, so walk.
    let n = 0;
    await this.cursorEach((r) => {
      if (!r.ambiguous) n++;
    });
    return n;
  }

  async forEachBatch(
    batchSize: number,
    fn: (batch: RemoteRecord[]) => Promise<void>
  ): Promise<void> {
    // Collect keys first (cheap: strings), then fetch+process in batches so we
    // never hold more than one batch of full records, and the callback's async
    // work isn't done inside a live cursor transaction.
    const keys: string[] = [];
    await this.cursorEach((r) => {
      if (!r.ambiguous) keys.push(r.path);
    });
    let batch: RemoteRecord[] = [];
    for (const key of keys) {
      const rec = await this.get(key);
      if (!rec) continue;
      batch.push(rec);
      if (batch.length >= batchSize) {
        await fn(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await fn(batch);
  }

  async hasSubtreeFiles(folderPath: string): Promise<boolean> {
    if (!this.db) throw new Error("RemoteStore not open");
    const prefix = folderPath + "/";
    // Key range [prefix, prefix + ￿) covers all descendants by path order.
    const range = idbKeyRange().bound(prefix, prefix + "￿", false, true);
    return new Promise((resolve, reject) => {
      const req = this.db!.transaction(STORE, "readonly")
        .objectStore(STORE)
        .openCursor(range);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(false);
          return;
        }
        const r = cursor.value as StoredRecord;
        if (!r.ambiguous) {
          resolve(true);
          return;
        }
        cursor.continue();
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    await new Promise<void>((resolve) => {
      const req = idb().deleteDatabase(this.dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve(); // best-effort
      req.onblocked = () => resolve();
    });
  }

  private strip(r: StoredRecord): RemoteRecord {
    return {
      path: r.path,
      id: r.id,
      md5: r.md5,
      size: r.size,
      mtimeMs: r.mtimeMs,
    };
  }

  private cursorEach(fn: (r: StoredRecord) => void): Promise<void> {
    if (!this.db) throw new Error("RemoteStore not open");
    return new Promise((resolve, reject) => {
      const req = this.db!.transaction(STORE, "readonly")
        .objectStore(STORE)
        .openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        fn(cursor.value as StoredRecord);
        cursor.continue();
      };
    });
  }
}
