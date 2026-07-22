/**
 * Tests for IndexedDbRemoteStore against a real IndexedDB implementation
 * (fake-indexeddb polyfill). These exercise the transaction semantics that the
 * in-memory store can't — in particular the read-modify-write in put(), which
 * must stay within ONE transaction (an await between get and put auto-commits
 * the transaction → "without an in-progress transaction"). Format: AAA.
 */

import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";
import { describe, it, expect, beforeEach } from "vitest";
import { RemoteRecord } from "../../src/remote-store";

// Install a fresh fake IndexedDB on the global before the store module reads it.
// (Relying on "fake-indexeddb/auto" didn't populate globalThis under this vitest
// node environment, so set the globals explicitly.)
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    new IDBFactory();
  (globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange =
    FakeIDBKeyRange;
});

// Import AFTER the globals may exist; the store resolves indexedDB lazily via
// globalThis at call time, so a normal top-of-file import is fine.
import { IndexedDbRemoteStore } from "../../src/remote-store-idb";

function rec(path: string, id: string, md5?: string): RemoteRecord {
  return { path, id, md5, size: 1, mtimeMs: 1 };
}

let dbCounter = 0;
async function freshStore(): Promise<IndexedDbRemoteStore> {
  // Unique DB name per test so they don't share state.
  dbCounter++;
  return IndexedDbRemoteStore.open(`test-remote-${dbCounter}`);
}

describe("IndexedDbRemoteStore (real IndexedDB via fake-indexeddb)", () => {
  it("put then get round-trips (single-transaction read-modify-write)", async () => {
    const s = await freshStore();
    await s.put(rec("a.md", "d1", "m1"));
    expect((await s.get("a.md"))?.id).toBe("d1");
    expect(await s.has("a.md")).toBe(true);
    expect(await s.count()).toBe(1);
    await s.dispose();
  });

  it("put over an existing record (get-then-put in one tx) does not throw", async () => {
    // This is the exact pattern that broke with an await between get and put:
    // "Attempt to get a record from database without an in-progress transaction".
    const s = await freshStore();
    await s.put(rec("a.md", "d2", "same"));
    await s.put(rec("a.md", "d1", "same")); // dup, identical -> smallest id
    expect((await s.get("a.md"))?.id).toBe("d1");
    expect(await s.count()).toBe(1);
    await s.dispose();
  });

  it("marks differing-content dups ambiguous and excludes them", async () => {
    const s = await freshStore();
    await s.put(rec("a.md", "d1", "m1"));
    await s.put(rec("a.md", "d2", "m2"));
    expect(await s.get("a.md")).toBeUndefined();
    expect(await s.isAmbiguous("a.md")).toBe(true);
    expect(await s.ambiguousPaths()).toEqual(["a.md"]);
    expect(await s.count()).toBe(0);
    await s.dispose();
  });

  it("stays ambiguous once ambiguous", async () => {
    const s = await freshStore();
    await s.put(rec("a.md", "d1", "m1"));
    await s.put(rec("a.md", "d2", "m2")); // ambiguous
    await s.put(rec("a.md", "d3", "m1")); // must not un-ambiguate
    expect(await s.isAmbiguous("a.md")).toBe(true);
    await s.dispose();
  });

  it("hasSubtreeFiles detects descendants and ignores the folder itself", async () => {
    const s = await freshStore();
    await s.put(rec("folder/deep/x.md", "d1", "m"));
    await s.put(rec("exact", "d2", "m"));
    expect(await s.hasSubtreeFiles("folder")).toBe(true);
    expect(await s.hasSubtreeFiles("folder/deep")).toBe(true);
    expect(await s.hasSubtreeFiles("exact")).toBe(false);
    expect(await s.hasSubtreeFiles("nope")).toBe(false);
    await s.dispose();
  });

  it("hasSubtreeFiles ignores ambiguous records", async () => {
    const s = await freshStore();
    await s.put(rec("f/a.md", "d1", "m1"));
    await s.put(rec("f/a.md", "d2", "m2")); // ambiguous
    expect(await s.hasSubtreeFiles("f")).toBe(false);
    await s.dispose();
  });

  it("forEachBatch yields every non-ambiguous record in batches", async () => {
    const s = await freshStore();
    for (let n = 0; n < 25; n++) await s.put(rec(`f${n}.md`, `d${n}`, "m"));
    await s.put(rec("dup.md", "da", "m1"));
    await s.put(rec("dup.md", "db", "m2")); // ambiguous

    const seen: string[] = [];
    let batches = 0;
    await s.forEachBatch(10, async (batch) => {
      batches++;
      for (const r of batch) seen.push(r.path);
    });

    expect(seen).toHaveLength(25);
    expect(seen).not.toContain("dup.md");
    expect(batches).toBe(3);
    await s.dispose();
  });

  it("clear empties the store", async () => {
    const s = await freshStore();
    await s.put(rec("a.md", "d1", "m"));
    await s.clear();
    expect(await s.count()).toBe(0);
    expect(await s.get("a.md")).toBeUndefined();
    await s.dispose();
  });

  it("handles a large put run without transaction errors", async () => {
    // Regression guard for the transaction-lifetime bug at scale.
    const s = await freshStore();
    for (let n = 0; n < 500; n++) {
      await s.put(rec(`bulk/f${n}.md`, `d${n}`, `m${n}`));
    }
    expect(await s.count()).toBe(500);
    await s.dispose();
  });
});
