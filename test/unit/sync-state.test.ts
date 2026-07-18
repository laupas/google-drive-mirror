/**
 * Unit-Tests für SyncStateStore — den persistenten "Base"-Speicher.
 * Format: AAA. Der Store hält seinen Zustand in einer eigenen Datei
 * (sync-state.json) via PluginStorage — hier über einen In-Memory-Fake.
 */

import { describe, it, expect } from "vitest";
import { SyncStateStore } from "../../src/sync-state";
import { baseEntry } from "../helpers/factories";
import { FakeStorage } from "../helpers/fake-storage";

/** Frischer Store über einen leeren In-Memory-Storage je Test. */
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
