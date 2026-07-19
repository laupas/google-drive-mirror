/**
 * Unit tests for reconcileFolders() — the folder variant of the reconciler.
 *
 * Core rule (as with files): a folder is only deleted when the base attests
 * that it existed on that side (b.local resp. b.remote). Otherwise it
 * counts as a new addition and is created on the opposite side.
 */

import { describe, it, expect } from "vitest";
import { reconcileFolders } from "../../src/reconciler";
import { SyncStateEntry, FolderAction } from "../../src/types";
import { baseEntry } from "../helpers/factories";

/** Convenient call: local folders as an array, remote as [path, id][]. */
function run(
  local: string[],
  remote: [string, string][],
  base: SyncStateEntry[],
  opts: { neverDeleteRemote?: boolean } = {}
): FolderAction[] {
  return reconcileFolders({
    local: new Set(local),
    remote: new Map(remote),
    base: new Map(base.map((b) => [b.path, b])),
    neverDeleteRemote: opts.neverDeleteRemote,
  });
}

/** Folder base entry (isFolder=true) with chosen flags. */
function folderBase(
  path: string,
  local: boolean,
  remote: boolean,
  keptRemoteOnly = false
): SyncStateEntry {
  return baseEntry({
    path,
    isFolder: true,
    local,
    remote,
    keptRemoteOnly,
    md5: "",
    driveId: "",
  });
}

describe("reconcileFolders — Neuzugänge", () => {
  it("legt einen nur lokal existierenden Ordner in Drive an", () => {
    const actions = run(["sub"], [], []);
    expect(actions).toEqual([{ type: "createRemoteFolder", path: "sub" }]);
  });

  it("legt einen nur remote existierenden Ordner lokal an", () => {
    const actions = run([], [["sub", "d1"]], []);
    expect(actions).toEqual([{ type: "createLocalFolder", path: "sub" }]);
  });

  it("macht noop, wenn der Ordner auf beiden Seiten existiert", () => {
    const actions = run(["sub"], [["sub", "d1"]], []);
    expect(actions).toEqual([{ type: "noopFolder", path: "sub" }]);
  });
});

describe("reconcileFolders — echte Löschungen (Base bezeugt Existenz)", () => {
  it("löscht in Drive, wenn Ordner laut Base beidseitig war und lokal fehlt", () => {
    const base = [folderBase("sub", true, true)];
    const actions = run([], [["sub", "d1"]], base);
    expect(actions).toEqual([
      { type: "deleteRemoteFolder", path: "sub", driveId: "d1" },
    ]);
  });

  it("löscht lokal, wenn Ordner laut Base beidseitig war und remote fehlt", () => {
    const base = [folderBase("sub", true, true)];
    const actions = run(["sub"], [], base);
    expect(actions).toEqual([{ type: "deleteLocalFolder", path: "sub" }]);
  });
});

describe("reconcileFolders — Löschschutz (Base bezeugt Existenz NICHT)", () => {
  it("legt lokal an statt zu löschen, wenn Ordner laut Base nie lokal war", () => {
    // remote present, local missing, but b.local=false -> new addition, no delete.
    const base = [folderBase("sub", false, true)];
    const actions = run([], [["sub", "d1"]], base);
    expect(actions).toEqual([{ type: "createLocalFolder", path: "sub" }]);
  });

  it("legt in Drive an statt zu löschen, wenn Ordner laut Base nie remote war", () => {
    const base = [folderBase("sub", true, false)];
    const actions = run(["sub"], [], base);
    expect(actions).toEqual([{ type: "createRemoteFolder", path: "sub" }]);
  });

  it("REGRESSION: kopierte Ordner-Base darf Drive-Ordner nicht löschen", () => {
    // New, empty vault; Drive has folders; base only knows them as remote.
    const base = [
      folderBase("a", false, true),
      folderBase("a/b", false, true),
    ];
    const actions = run([], [["a", "d1"], ["a/b", "d2"]], base);
    expect(actions.some((x) => x.type.startsWith("delete"))).toBe(false);
    expect(actions).toEqual(
      expect.arrayContaining([
        { type: "createLocalFolder", path: "a" },
        { type: "createLocalFolder", path: "a/b" },
      ])
    );
  });
});

describe("reconcileFolders — beidseitig verschwunden", () => {
  it("erzeugt keine Aktion, wenn ein Base-Ordner auf beiden Seiten fehlt", () => {
    const base = [folderBase("gone", true, true)];
    const actions = run([], [], base);
    expect(actions).toEqual([]);
  });
});

describe("reconcileFolders — Do not delete in Google Drive", () => {
  it("behält den Drive-Ordner statt ihn zu löschen (keepRemoteFolder)", () => {
    // Arrange: folder was on both sides, now gone locally.
    const base = [folderBase("sub", true, true)];

    // Act
    const actions = run([], [["sub", "d1"]], base, { neverDeleteRemote: true });

    // Assert
    expect(actions).toEqual([
      { type: "keepRemoteFolder", path: "sub", driveId: "d1" },
    ]);
  });

  it("löscht den Drive-Ordner weiterhin, wenn das Flag AUS ist", () => {
    const base = [folderBase("sub", true, true)];
    const actions = run([], [["sub", "d1"]], base, { neverDeleteRemote: false });
    expect(actions).toEqual([
      { type: "deleteRemoteFolder", path: "sub", driveId: "d1" },
    ]);
  });

  it("holt einen keptRemoteOnly-Ordner NICHT als Zombie lokal zurück", () => {
    // Arrange: base says local=false, remote=true, keptRemoteOnly; only in Drive.
    const base = [folderBase("sub", false, true, true)];

    // Act
    const actions = run([], [["sub", "d1"]], base, { neverDeleteRemote: true });

    // Assert: no createLocalFolder.
    expect(actions).toEqual([{ type: "noopFolder", path: "sub" }]);
  });
});
