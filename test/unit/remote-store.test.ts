/**
 * Unit tests for InMemoryRemoteStore — the per-run remote-listing store. The
 * IndexedDB implementation mirrors these exact semantics (dedup on put,
 * ambiguous handling, subtree query, batched iteration), so this covers the
 * shared contract. Format: AAA.
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryRemoteStore,
  RemoteRecord,
  resolveDuplicate,
} from "../../src/remote-store";

function rec(path: string, id: string, md5?: string): RemoteRecord {
  return { path, id, md5, size: 1, mtimeMs: 1 };
}

describe("resolveDuplicate", () => {
  it("keeps the smallest id when content (md5) is identical", () => {
    expect(resolveDuplicate(rec("a", "d2", "m"), rec("a", "d1", "m")).keep?.id).toBe("d1");
    expect(resolveDuplicate(rec("a", "d1", "m"), rec("a", "d2", "m")).keep?.id).toBe("d1");
  });

  it("marks ambiguous when md5 differs or is missing", () => {
    expect(resolveDuplicate(rec("a", "d1", "m1"), rec("a", "d2", "m2")).ambiguous).toBe(true);
    expect(resolveDuplicate(rec("a", "d1"), rec("a", "d2")).ambiguous).toBe(true);
  });
});

describe("InMemoryRemoteStore", () => {
  it("stores and retrieves a record by path", async () => {
    const s = new InMemoryRemoteStore();
    await s.put(rec("sub/a.md", "d1", "m1"));
    expect((await s.get("sub/a.md"))?.id).toBe("d1");
    expect(await s.has("sub/a.md")).toBe(true);
    expect(await s.count()).toBe(1);
  });

  it("dedups identical-content dups to the smallest id", async () => {
    const s = new InMemoryRemoteStore();
    await s.put(rec("a.md", "d2", "same"));
    await s.put(rec("a.md", "d1", "same"));
    expect((await s.get("a.md"))?.id).toBe("d1");
    expect(await s.count()).toBe(1);
    expect(await s.isAmbiguous("a.md")).toBe(false);
  });

  it("marks differing-content dups ambiguous and excludes them", async () => {
    const s = new InMemoryRemoteStore();
    await s.put(rec("a.md", "d1", "m1"));
    await s.put(rec("a.md", "d2", "m2"));
    expect(await s.get("a.md")).toBeUndefined();
    expect(await s.has("a.md")).toBe(false);
    expect(await s.isAmbiguous("a.md")).toBe(true);
    expect(await s.ambiguousPaths()).toEqual(["a.md"]);
    expect(await s.count()).toBe(0); // not counted
  });

  it("stays ambiguous once ambiguous, even if a later dup matches", async () => {
    const s = new InMemoryRemoteStore();
    await s.put(rec("a.md", "d1", "m1"));
    await s.put(rec("a.md", "d2", "m2")); // -> ambiguous
    await s.put(rec("a.md", "d3", "m1")); // must NOT un-ambiguate
    expect(await s.isAmbiguous("a.md")).toBe(true);
    expect(await s.get("a.md")).toBeUndefined();
  });

  it("hasSubtreeFiles detects descendants by path prefix", async () => {
    const s = new InMemoryRemoteStore();
    await s.put(rec("folder/deep/x.md", "d1", "m"));
    await s.put(rec("other.md", "d2", "m"));
    expect(await s.hasSubtreeFiles("folder")).toBe(true);
    expect(await s.hasSubtreeFiles("folder/deep")).toBe(true);
    expect(await s.hasSubtreeFiles("nope")).toBe(false);
    // A folder path is not its own descendant.
    await s.put(rec("exact", "d3", "m"));
    expect(await s.hasSubtreeFiles("exact")).toBe(false);
  });

  it("hasSubtreeFiles ignores ambiguous records", async () => {
    const s = new InMemoryRemoteStore();
    await s.put(rec("f/a.md", "d1", "m1"));
    await s.put(rec("f/a.md", "d2", "m2")); // ambiguous -> excluded
    expect(await s.hasSubtreeFiles("f")).toBe(false);
  });

  it("forEachBatch yields every non-ambiguous record in batches", async () => {
    const s = new InMemoryRemoteStore();
    for (let n = 0; n < 25; n++) await s.put(rec(`f${n}.md`, `d${n}`, "m"));
    await s.put(rec("dup.md", "da", "m1"));
    await s.put(rec("dup.md", "db", "m2")); // ambiguous -> not yielded

    const seen: string[] = [];
    let batches = 0;
    await s.forEachBatch(10, async (batch) => {
      batches++;
      for (const r of batch) seen.push(r.path);
    });

    expect(seen).toHaveLength(25);
    expect(seen).not.toContain("dup.md");
    expect(batches).toBe(3); // 10 + 10 + 5
  });

  it("clear empties the store", async () => {
    const s = new InMemoryRemoteStore();
    await s.put(rec("a.md", "d1", "m"));
    await s.clear();
    expect(await s.count()).toBe(0);
    expect(await s.get("a.md")).toBeUndefined();
  });
});
