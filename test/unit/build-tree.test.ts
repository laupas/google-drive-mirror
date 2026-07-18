/**
 * Unit-Tests für buildTree() — baut aus flachen Sync-State-Einträgen die
 * Baumstruktur für den Sync-Baum in den Settings.
 */

import { describe, it, expect } from "vitest";
import { buildTree } from "../../src/settings-tab";
import { baseEntry } from "../helpers/factories";

describe("buildTree", () => {
  it("verschachtelt Dateien unter ihren Ordnern", () => {
    // Arrange
    const entries = [
      baseEntry({ path: "sub", isFolder: true }),
      baseEntry({ path: "sub/a.md", isFolder: false }),
      baseEntry({ path: "top.md", isFolder: false }),
    ];

    // Act
    const root = buildTree(entries);

    // Assert
    const names = root.children.map((c) => c.name).sort();
    expect(names).toEqual(["sub", "top.md"]);
    const sub = root.children.find((c) => c.name === "sub")!;
    expect(sub.isFolder).toBe(true);
    expect(sub.children.map((c) => c.name)).toEqual(["a.md"]);
  });

  it("erzeugt Zwischenordner ohne eigenen State-Eintrag als Struktur-Ordner", () => {
    // Arrange: nur die Datei, kein Ordner-Eintrag für "a/b".
    const entries = [baseEntry({ path: "a/b/deep.md", isFolder: false })];

    // Act
    const root = buildTree(entries);

    // Assert: a -> b -> deep.md, a und b sind Ordner (isFolder default true).
    const a = root.children.find((c) => c.name === "a")!;
    expect(a.isFolder).toBe(true);
    const b = a.children.find((c) => c.name === "b")!;
    expect(b.isFolder).toBe(true);
    const file = b.children.find((c) => c.name === "deep.md")!;
    expect(file.isFolder).toBe(false);
    expect(file.path).toBe("a/b/deep.md");
  });

  it("übernimmt keptRemoteOnly auf den Blatt-Knoten", () => {
    // Arrange
    const entries = [
      baseEntry({ path: "keep.md", isFolder: false, keptRemoteOnly: true }),
      baseEntry({ path: "normal.md", isFolder: false }),
    ];

    // Act
    const root = buildTree(entries);

    // Assert
    const keep = root.children.find((c) => c.name === "keep.md")!;
    const normal = root.children.find((c) => c.name === "normal.md")!;
    expect(keep.keptRemoteOnly).toBe(true);
    expect(normal.keptRemoteOnly).toBe(false);
  });
});
