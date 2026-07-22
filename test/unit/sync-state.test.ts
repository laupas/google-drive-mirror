/**
 * Unit tests for SyncStateStore — the persistent "base" store.
 * Format: AAA. The store keeps its state in its own file
 * (sync-state.json) via PluginStorage — here through an in-memory fake.
 */

import { describe, it, expect } from "vitest";
import {
  SyncStateStore,
  isStateFile,
  stateFileName,
} from "../../src/sync-state";
import { baseEntry } from "../helpers/factories";
import { FakeStorage } from "../helpers/fake-storage";

/** Fresh store over an empty in-memory storage per test. */
function freshStore(): { store: SyncStateStore; storage: FakeStorage } {
  const storage = new FakeStorage();
  const store = new SyncStateStore(storage.asStorage(), () => "test-scope");
  return { store, storage };
}

describe("SyncStateStore.get", () => {
  it("liefert undefined für einen unbekannten Pfad", () => {
    // Arrange
    const { store } = freshStore();

    // Act
    const result = store.get("fehlt.md");

    // Assert
    expect(result).toBeUndefined();
  });

  it("liefert den gesetzten Eintrag für einen bekannten Pfad", () => {
    // Arrange
    const { store } = freshStore();
    const entry = baseEntry({ path: "a.md" });
    store.set(entry);

    // Act
    const result = store.get("a.md");

    // Assert
    expect(result).toEqual(entry);
  });
});

describe("SyncStateStore.set", () => {
  it("macht den Eintrag unter seinem Pfad abrufbar", () => {
    // Arrange
    const { store } = freshStore();
    const entry = baseEntry({ path: "b.md" });

    // Act
    store.set(entry);

    // Assert
    expect(store.get("b.md")).toEqual(entry);
  });

  it("persistiert den Eintrag beim save() in sync-state.json", async () => {
    // Arrange
    const { store, storage } = freshStore();
    const entry = baseEntry({ path: "b.md" });

    // Act
    store.set(entry);
    await store.save();

    // Assert
    const file = storage.peek("sync-state.json") as {
      entries: Record<string, unknown>;
    };
    expect(file.entries["b.md"]).toEqual(entry);
  });

  it("überschreibt einen bestehenden Eintrag am selben Pfad", () => {
    // Arrange
    const { store } = freshStore();
    store.set(baseEntry({ path: "b.md", md5: "old" }));

    // Act
    store.set(baseEntry({ path: "b.md", md5: "new" }));

    // Assert
    expect(store.get("b.md")?.md5).toBe("new");
  });
});

describe("SyncStateStore.delete", () => {
  it("entfernt einen bestehenden Eintrag", () => {
    // Arrange
    const { store } = freshStore();
    store.set(baseEntry({ path: "c.md" }));

    // Act
    store.delete("c.md");

    // Assert
    expect(store.get("c.md")).toBeUndefined();
  });

  it("ist ein No-Op (kein Fehler) für einen unbekannten Pfad", () => {
    // Arrange
    const { store } = freshStore();

    // Act & Assert
    expect(() => store.delete("fehlt.md")).not.toThrow();
  });
});

describe("SyncStateStore.knownPaths", () => {
  it("liefert ein leeres Array bei leerem State", () => {
    // Arrange
    const { store } = freshStore();

    // Act
    const paths = store.knownPaths();

    // Assert
    expect(paths).toEqual([]);
  });

  it("liefert alle gesetzten Pfade", () => {
    // Arrange
    const { store } = freshStore();
    store.set(baseEntry({ path: "a.md" }));
    store.set(baseEntry({ path: "b.md" }));

    // Act
    const paths = store.knownPaths();

    // Assert
    expect(paths.sort()).toEqual(["a.md", "b.md"]);
  });
});

describe("SyncStateStore.all", () => {
  it("liefert alle Einträge als Array", () => {
    // Arrange
    const { store } = freshStore();
    const a = baseEntry({ path: "a.md" });
    const b = baseEntry({ path: "b.md" });
    store.set(a);
    store.set(b);

    // Act
    const all = store.all();

    // Assert
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([a, b]));
  });
});

describe("Per-Ziel State-Dateien", () => {
  it("stateFileName bildet den Ziel-Dateinamen", () => {
    expect(stateFileName("abc")).toBe("sync-state-abc.json");
  });

  it("isStateFile erkennt per-Ziel-Dateien, nicht die Legacy-Datei", () => {
    expect(isStateFile("sync-state-abc.json")).toBe(true);
    expect(isStateFile("sync-state.json")).toBe(false);
    expect(isStateFile("data.json")).toBe(false);
  });

  it("schreibt in die injizierte Datei und destroy() entfernt sie", async () => {
    // Arrange
    const storage = new FakeStorage();
    const store = new SyncStateStore(
      storage.asStorage(),
      () => "scope",
      stateFileName("t1")
    );
    store.set(baseEntry({ path: "a.md" }));

    // Act
    await store.save();

    // Assert: written to the per-target file, not the legacy one.
    expect(storage.peek("sync-state-t1.json")).toBeDefined();
    expect(storage.peek("sync-state.json")).toBeUndefined();

    // Act: destroy removes the file.
    await store.destroy();
    expect(storage.peek("sync-state-t1.json")).toBeUndefined();
  });

  it("verwirft eine Base mit nicht passender scopeId (Löschschutz)", async () => {
    // Arrange: file on disk carries a foreign scopeId.
    const storage = new FakeStorage();
    await storage.writeJson(stateFileName("t1"), {
      version: 1,
      scopeId: "OTHER-SCOPE",
      lastSyncMs: 123,
      entries: { "x.md": baseEntry({ path: "x.md" }) },
    });
    const store = new SyncStateStore(
      storage.asStorage(),
      () => "MY-SCOPE",
      stateFileName("t1")
    );

    // Act
    await store.load();

    // Assert: foreign base discarded (no entries), no stale lastSyncMs.
    expect(store.all()).toEqual([]);
    expect(store.getLastSyncMs()).toBe(0);
  });
});

describe("SyncStateStore.byDriveId", () => {
  it("findet den Eintrag mit passender Drive-ID", () => {
    // Arrange
    const { store } = freshStore();
    store.set(baseEntry({ path: "a.md", driveId: "id-A" }));
    store.set(baseEntry({ path: "b.md", driveId: "id-B" }));

    // Act
    const result = store.byDriveId("id-B");

    // Assert
    expect(result?.path).toBe("b.md");
  });

  it("liefert undefined, wenn keine Drive-ID passt", () => {
    // Arrange
    const { store } = freshStore();
    store.set(baseEntry({ path: "a.md", driveId: "id-A" }));

    // Act
    const result = store.byDriveId("nicht-da");

    // Assert
    expect(result).toBeUndefined();
  });
});

describe("SyncStateStore — fetch spill (temp JSONL)", () => {
  async function collect(
    store: SyncStateStore
  ): Promise<Array<{ p: string; i: string }>> {
    const out: Array<{ p: string; i: string }> = [];
    for await (const rec of store.spillRead()) out.push(rec);
    return out;
  }

  it("round-trips appended records in order", async () => {
    // Arrange
    const { store } = freshStore();
    await store.spillBegin();

    // Act
    await store.spillAppend({ p: "a.md", i: "id-a", m: "m1", s: 10, t: 1 });
    await store.spillAppend({ p: "sub/b.md", i: "id-b", m: "m2", s: 20, t: 2 });
    await store.spillFlush();
    const recs = await collect(store);

    // Assert
    expect(recs.map((r) => r.p)).toEqual(["a.md", "sub/b.md"]);
    expect(recs[1]).toEqual({ p: "sub/b.md", i: "id-b", m: "m2", s: 20, t: 2 });
  });

  it("flushes automatically past the batch size (500) without losing records", async () => {
    // Arrange
    const { store } = freshStore();
    await store.spillBegin();

    // Act: more than one batch.
    for (let n = 0; n < 1201; n++) {
      await store.spillAppend({ p: `f${n}.md`, i: `id-${n}`, t: n });
    }
    const recs = await collect(store);

    // Assert: every record survived across the auto-flush boundaries.
    expect(recs).toHaveLength(1201);
    expect(recs[0].p).toBe("f0.md");
    expect(recs[1200].p).toBe("f1200.md");
  });

  it("spillBegin discards a stale spill from a previous run", async () => {
    // Arrange
    const { store } = freshStore();
    await store.spillBegin();
    await store.spillAppend({ p: "old.md", i: "old", t: 1 });
    await store.spillFlush();

    // Act: a new run starts fresh.
    await store.spillBegin();
    await store.spillAppend({ p: "new.md", i: "new", t: 2 });
    const recs = await collect(store);

    // Assert: only the new run's records remain.
    expect(recs.map((r) => r.p)).toEqual(["new.md"]);
  });

  it("spillDiscard removes the temp file (read yields nothing)", async () => {
    // Arrange
    const { store } = freshStore();
    await store.spillBegin();
    await store.spillAppend({ p: "a.md", i: "id-a", t: 1 });
    await store.spillFlush();

    // Act
    await store.spillDiscard();
    const recs = await collect(store);

    // Assert
    expect(recs).toEqual([]);
  });

  it("reading an empty/never-written spill yields nothing", async () => {
    // Arrange
    const { store } = freshStore();

    // Act
    const recs = await collect(store);

    // Assert
    expect(recs).toEqual([]);
  });
});
