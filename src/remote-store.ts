import { DriveFile } from "./types";

/**
 * A lean remote-file record as stored during a listing. Keeps only the fields
 * the reconciler / engine actually read (see mapRawFile audit): path is the
 * key, plus driveId/md5/size/mtime. mimeType is NOT stored (the google-apps
 * filter is applied before storing).
 */
export interface RemoteRecord {
  path: string;
  id: string;
  md5?: string;
  size?: number;
  mtimeMs: number;
}

/** Rebuilds a (lean) DriveFile from a stored record, for the reconciler. */
export function recordToDriveFile(r: RemoteRecord): DriveFile {
  return {
    id: r.id,
    name: "",
    mimeType: "",
    modifiedTimeMs: r.mtimeMs,
    md5Checksum: r.md5,
    size: r.size,
    relativePath: r.path,
  };
}

/**
 * Storage for the fetched Drive listing DURING one sync run — deliberately
 * abstracted so the heavy remote set can live OUTSIDE the JS heap (IndexedDB on
 * mobile), instead of a big in-memory Map that OOM-killed the iOS WebView at
 * reconcile time on large Drives.
 *
 * Duplicate paths: `put` must MERGE with any existing record at the same path
 * via `resolveDup` (Drive allows several files with the same name in a folder).
 * The engine's dedup rule is applied through that resolver so the store always
 * holds the single resolved record per path (or marks it ambiguous).
 *
 * All methods are async (IndexedDB is async). Cleared at the start/end of a run.
 */
export interface RemoteStore {
  /** Removes all records (call at run start and end). */
  clear(): Promise<void>;
  /**
   * Insert or merge a record at its path. `onCollision` is called when a record
   * already exists at that path, and returns the resolution: the record to keep,
   * or `null` to mark the path AMBIGUOUS (excluded from both sides). Once
   * ambiguous, a path stays ambiguous.
   */
  put(rec: RemoteRecord): Promise<void>;
  /** The resolved record at a path, or undefined (absent or ambiguous). */
  get(path: string): Promise<RemoteRecord | undefined>;
  /** Whether a NON-ambiguous record exists at the path. */
  has(path: string): Promise<boolean>;
  /** Whether a path was seen but marked ambiguous (dup with differing content). */
  isAmbiguous(path: string): Promise<boolean>;
  /** All ambiguous paths (for the "skip both sides" handling + logging). */
  ambiguousPaths(): Promise<string[]>;
  /** Number of resolved (non-ambiguous) records. */
  count(): Promise<number>;
  /**
   * Iterate resolved records in batches of `batchSize`. Each batch is an array
   * of records; the callback is awaited before the next batch. Ambiguous paths
   * are NOT yielded.
   */
  forEachBatch(
    batchSize: number,
    fn: (batch: RemoteRecord[]) => Promise<void>
  ): Promise<void>;
  /**
   * Is there at least one resolved record whose path lies strictly below
   * `folderPath` (i.e. starts with `folderPath + "/"`)? Used by the
   * deleteRemoteFolder subtree-safety net.
   */
  hasSubtreeFiles(folderPath: string): Promise<boolean>;
  /** Release any resources (close the DB). */
  dispose(): Promise<void>;
}

/**
 * The dedup rule shared by all RemoteStore implementations. Given the existing
 * record at a path and a new one, decide what to keep:
 *  - identical content (same, present md5) -> keep the smallest driveId
 *  - differing/unknown content -> ambiguous (null)
 * Returns `{ keep }` or `{ ambiguous: true }`.
 */
export function resolveDuplicate(
  existing: RemoteRecord,
  incoming: RemoteRecord
): { keep?: RemoteRecord; ambiguous?: boolean } {
  const a = existing.md5;
  const b = incoming.md5;
  if (a && b && a === b) {
    // identical content -> deterministic smallest id
    return { keep: existing.id <= incoming.id ? existing : incoming };
  }
  return { ambiguous: true };
}

/**
 * In-memory RemoteStore — used on desktop (no memory pressure) and in tests
 * (Node has no IndexedDB). Same semantics as the IndexedDB implementation.
 */
export class InMemoryRemoteStore implements RemoteStore {
  private map = new Map<string, RemoteRecord>();
  private ambiguous = new Set<string>();

  async clear(): Promise<void> {
    this.map.clear();
    this.ambiguous.clear();
  }

  async put(rec: RemoteRecord): Promise<void> {
    if (this.ambiguous.has(rec.path)) return; // stays ambiguous
    const existing = this.map.get(rec.path);
    if (!existing) {
      this.map.set(rec.path, rec);
      return;
    }
    const res = resolveDuplicate(existing, rec);
    if (res.ambiguous) {
      this.map.delete(rec.path);
      this.ambiguous.add(rec.path);
    } else if (res.keep) {
      this.map.set(rec.path, res.keep);
    }
  }

  async get(path: string): Promise<RemoteRecord | undefined> {
    return this.map.get(path);
  }

  async has(path: string): Promise<boolean> {
    return this.map.has(path);
  }

  async isAmbiguous(path: string): Promise<boolean> {
    return this.ambiguous.has(path);
  }

  async ambiguousPaths(): Promise<string[]> {
    return [...this.ambiguous];
  }

  async count(): Promise<number> {
    return this.map.size;
  }

  async forEachBatch(
    batchSize: number,
    fn: (batch: RemoteRecord[]) => Promise<void>
  ): Promise<void> {
    let batch: RemoteRecord[] = [];
    for (const rec of this.map.values()) {
      batch.push(rec);
      if (batch.length >= batchSize) {
        await fn(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await fn(batch);
  }

  async hasSubtreeFiles(folderPath: string): Promise<boolean> {
    const prefix = folderPath + "/";
    for (const path of this.map.keys()) {
      if (path.startsWith(prefix)) return true;
    }
    return false;
  }

  async dispose(): Promise<void> {
    await this.clear();
  }
}
