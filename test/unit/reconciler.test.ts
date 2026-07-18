/**
 * Unit-Tests für reconcile() — die reine 3-Wege-Merge-Funktion.
 *
 * Jeder der 11 dokumentierten Fälle aus reconciler.ts hat mindestens einen
 * Test, dazu Grenzfälle (mtime-Gleichstand, fehlende md5Checksum, contentEqual).
 * Format: strikt AAA (Arrange / Act / Assert).
 */

import { describe, it, expect } from "vitest";
import { reconcile, LocalFile } from "../../src/reconciler";
import { SyncStateEntry, SyncAction } from "../../src/types";
import {
  localFile,
  driveFile,
  baseEntry,
  mapByPath,
  DriveFileWithPath,
} from "../helpers/factories";

/** Bequemer Aufruf mit Arrays statt Maps. */
function run(
  local: LocalFile[],
  remote: DriveFileWithPath[],
  base: SyncStateEntry[],
  opts: { neverDeleteRemote?: boolean } = {}
): SyncAction[] {
  return reconcile({
    local: mapByPath(local),
    remote: mapByPath(remote),
    base: mapByPath(base),
    neverDeleteRemote: opts.neverDeleteRemote,
  });
}

describe("reconcile — Fall 1: nirgends bekannt", () => {
  it("erzeugt keine Aktion, wenn ein Pfad nirgends existiert", () => {
    // Arrange
    const local: LocalFile[] = [];
    const remote: DriveFileWithPath[] = [];
    const base: SyncStateEntry[] = [];

    // Act
    const actions = run(local, remote, base);

    // Assert
    expect(actions).toEqual([]);
  });
});

describe("reconcile — Fall 2: neu lokal (nur lokal, keine Base)", () => {
  it("lädt eine rein lokal existierende Datei hoch", () => {
    // Arrange
    const local = [localFile({ path: "new.md" })];

    // Act
    const actions = run(local, [], []);

    // Assert
    expect(actions).toEqual([{ type: "upload", path: "new.md" }]);
  });
});

describe("reconcile — Fall 3: neu remote (nur remote, keine Base)", () => {
  it("lädt eine rein remote existierende Datei herunter", () => {
    // Arrange
    const remote = [driveFile({ path: "remote.md", id: "d1" })];

    // Act
    const actions = run([], remote, []);

    // Assert
    expect(actions).toEqual([
      { type: "download", path: "remote.md", driveId: "d1" },
    ]);
  });
});

describe("reconcile — Fall 4: beidseitig neu ohne Base (Kollision)", () => {
  it("macht noop, wenn beide Seiten identischen Inhalt haben (gleicher md5)", () => {
    // Arrange
    const local = [localFile({ path: "same.md", md5: "identical" })];
    const remote = [
      driveFile({ path: "same.md", md5Checksum: "identical" }),
    ];

    // Act
    const actions = run(local, remote, []);

    // Assert
    expect(actions).toEqual([{ type: "noop", path: "same.md" }]);
  });

  it("meldet Konflikt mit lokalem Gewinner, wenn lokale mtime neuer ist", () => {
    // Arrange
    const local = [
      localFile({ path: "c.md", md5: "L", mtimeMs: 2_000 }),
    ];
    const remote = [
      driveFile({ path: "c.md", id: "d1", md5Checksum: "R", modifiedTimeMs: 1_000 }),
    ];

    // Act
    const actions = run(local, remote, []);

    // Assert
    expect(actions).toEqual([
      { type: "conflict", path: "c.md", driveId: "d1", winner: "local" },
    ]);
  });

  it("meldet Konflikt mit remote Gewinner, wenn remote mtime neuer ist", () => {
    // Arrange
    const local = [
      localFile({ path: "c.md", md5: "L", mtimeMs: 1_000 }),
    ];
    const remote = [
      driveFile({ path: "c.md", id: "d1", md5Checksum: "R", modifiedTimeMs: 2_000 }),
    ];

    // Act
    const actions = run(local, remote, []);

    // Assert
    expect(actions).toEqual([
      { type: "conflict", path: "c.md", driveId: "d1", winner: "remote" },
    ]);
  });

  it("wählt bei mtime-Gleichstand lokal als Gewinner (>= zugunsten lokal)", () => {
    // Arrange
    const local = [localFile({ path: "c.md", md5: "L", mtimeMs: 5_000 })];
    const remote = [
      driveFile({ path: "c.md", id: "d1", md5Checksum: "R", modifiedTimeMs: 5_000 }),
    ];

    // Act
    const actions = run(local, remote, []);

    // Assert
    expect(actions).toEqual([
      { type: "conflict", path: "c.md", driveId: "d1", winner: "local" },
    ]);
  });
});

describe("reconcile — Fall 5: beidseitig gelöscht", () => {
  it("erzeugt keine Aktion, wenn Datei aus Base auf beiden Seiten verschwunden ist", () => {
    // Arrange
    const base = [baseEntry({ path: "gone.md" })];

    // Act
    const actions = run([], [], base);

    // Assert: nichts zu tun; der verwaiste Base-Eintrag wird von der Engine entfernt.
    expect(actions).toEqual([]);
  });
});

describe("reconcile — Fall 6: lokal gelöscht", () => {
  it("propagiert lokale Löschung nach Drive, wenn remote unverändert (md5 == base)", () => {
    // Arrange
    const remote = [
      driveFile({ path: "del.md", id: "d1", md5Checksum: "base-hash" }),
    ];
    const base = [baseEntry({ path: "del.md", md5: "base-hash", driveId: "d1" })];

    // Act
    const actions = run([], remote, base);

    // Assert
    expect(actions).toEqual([
      { type: "deleteRemote", path: "del.md", driveId: "d1" },
    ]);
  });

  it("holt Datei zurück (download), wenn remote nach dem Sync geändert wurde (Löschung verliert)", () => {
    // Arrange
    const remote = [
      driveFile({ path: "del.md", id: "d1", md5Checksum: "changed-remote" }),
    ];
    const base = [baseEntry({ path: "del.md", md5: "base-hash", driveId: "d1" })];

    // Act
    const actions = run([], remote, base);

    // Assert
    expect(actions).toEqual([
      { type: "download", path: "del.md", driveId: "d1" },
    ]);
  });
});

describe("reconcile — Fall 7: remote gelöscht", () => {
  it("propagiert remote Löschung nach lokal, wenn lokal unverändert (md5 == base)", () => {
    // Arrange
    const local = [localFile({ path: "del.md", md5: "base-hash" })];
    const base = [baseEntry({ path: "del.md", md5: "base-hash" })];

    // Act
    const actions = run(local, [], base);

    // Assert
    expect(actions).toEqual([{ type: "deleteLocal", path: "del.md" }]);
  });

  it("lädt Datei hoch, wenn lokal nach dem Sync geändert wurde (Löschung verliert)", () => {
    // Arrange
    const local = [localFile({ path: "del.md", md5: "changed-local" })];
    const base = [baseEntry({ path: "del.md", md5: "base-hash" })];

    // Act
    const actions = run(local, [], base);

    // Assert
    expect(actions).toEqual([{ type: "upload", path: "del.md" }]);
  });
});

describe("reconcile — Fall 8: keine Seite geändert", () => {
  it("macht noop, wenn lokal und remote gleich der Base sind", () => {
    // Arrange
    const local = [localFile({ path: "stable.md", md5: "same" })];
    const remote = [driveFile({ path: "stable.md", md5Checksum: "same" })];
    const base = [baseEntry({ path: "stable.md", md5: "same" })];

    // Act
    const actions = run(local, remote, base);

    // Assert
    expect(actions).toEqual([{ type: "noop", path: "stable.md" }]);
  });
});

describe("reconcile — Fall 9: nur lokal geändert", () => {
  it("lädt hoch, wenn nur der lokale md5 von der Base abweicht", () => {
    // Arrange
    const local = [localFile({ path: "edit.md", md5: "new-local" })];
    const remote = [driveFile({ path: "edit.md", md5Checksum: "base-hash" })];
    const base = [baseEntry({ path: "edit.md", md5: "base-hash" })];

    // Act
    const actions = run(local, remote, base);

    // Assert
    expect(actions).toEqual([{ type: "upload", path: "edit.md" }]);
  });
});

describe("reconcile — Fall 10: nur remote geändert", () => {
  it("lädt herunter, wenn nur der remote md5 von der Base abweicht", () => {
    // Arrange
    const local = [localFile({ path: "edit.md", md5: "base-hash" })];
    const remote = [
      driveFile({ path: "edit.md", id: "d9", md5Checksum: "new-remote" }),
    ];
    const base = [baseEntry({ path: "edit.md", md5: "base-hash" })];

    // Act
    const actions = run(local, remote, base);

    // Assert
    expect(actions).toEqual([
      { type: "download", path: "edit.md", driveId: "d9" },
    ]);
  });
});

describe("reconcile — Fall 11: beide geändert", () => {
  it("macht noop, wenn beide Seiten zufällig auf denselben Inhalt geändert wurden", () => {
    // Arrange
    const local = [localFile({ path: "edit.md", md5: "converged" })];
    const remote = [driveFile({ path: "edit.md", md5Checksum: "converged" })];
    const base = [baseEntry({ path: "edit.md", md5: "old-base" })];

    // Act
    const actions = run(local, remote, base);

    // Assert
    expect(actions).toEqual([{ type: "noop", path: "edit.md" }]);
  });

  it("meldet Konflikt (lokal gewinnt), wenn beide unterschiedlich geändert und lokal neuer ist", () => {
    // Arrange
    const local = [
      localFile({ path: "edit.md", md5: "L", mtimeMs: 3_000 }),
    ];
    const remote = [
      driveFile({ path: "edit.md", id: "dX", md5Checksum: "R", modifiedTimeMs: 2_000 }),
    ];
    const base = [baseEntry({ path: "edit.md", md5: "old-base" })];

    // Act
    const actions = run(local, remote, base);

    // Assert
    expect(actions).toEqual([
      { type: "conflict", path: "edit.md", driveId: "dX", winner: "local" },
    ]);
  });

  it("meldet Konflikt (remote gewinnt), wenn beide unterschiedlich geändert und remote neuer ist", () => {
    // Arrange
    const local = [
      localFile({ path: "edit.md", md5: "L", mtimeMs: 2_000 }),
    ];
    const remote = [
      driveFile({ path: "edit.md", id: "dX", md5Checksum: "R", modifiedTimeMs: 3_000 }),
    ];
    const base = [baseEntry({ path: "edit.md", md5: "old-base" })];

    // Act
    const actions = run(local, remote, base);

    // Assert
    expect(actions).toEqual([
      { type: "conflict", path: "edit.md", driveId: "dX", winner: "remote" },
    ]);
  });
});

describe("reconcile — Grenzfälle: fehlende md5Checksum auf Drive-Seite", () => {
  it("behandelt fehlenden remote md5 mit unveränderter mtime/Größe als NOOP (kein Download-Loop)", () => {
    // Arrange: Drive-Datei ohne md5Checksum, aber mtime+Größe = Base.
    // Ohne Fallback würde (undefined !== base.md5) jeden Lauf einen Download
    // auslösen -> Endlos-Loop. Der mtime/Größen-Fallback verhindert das.
    const local = [localFile({ path: "x.md", md5: "base-hash" })];
    const remote = [
      driveFile({
        path: "x.md",
        id: "d1",
        md5Checksum: undefined,
        modifiedTimeMs: 1_000,
        size: 100,
      }),
    ];
    const base = [
      baseEntry({ path: "x.md", md5: "base-hash", remoteMtime: 1_000, size: 100 }),
    ];

    // Act
    const actions = run(local, remote, base);

    // Assert: nichts geändert -> noop.
    expect(actions).toEqual([{ type: "noop", path: "x.md" }]);
  });

  it("behandelt fehlenden remote md5 mit neuerer mtime als Änderung -> Download", () => {
    // Arrange: kein md5, aber Drive-mtime neuer als Base -> remote geändert.
    const local = [localFile({ path: "x.md", md5: "base-hash" })];
    const remote = [
      driveFile({
        path: "x.md",
        id: "d1",
        md5Checksum: undefined,
        modifiedTimeMs: 5_000,
        size: 100,
      }),
    ];
    const base = [
      baseEntry({ path: "x.md", md5: "base-hash", remoteMtime: 1_000, size: 100 }),
    ];

    // Act
    const actions = run(local, remote, base);

    // Assert: remote neuer, lokal unverändert -> Fall 10 (download).
    expect(actions).toEqual([
      { type: "download", path: "x.md", driveId: "d1" },
    ]);
  });

  it("meldet Konflikt bei beidseitiger Änderung ohne remote md5 (contentEqual=false)", () => {
    // Arrange: lokal geändert UND Drive-mtime neuer als Base -> beide geändert.
    const local = [localFile({ path: "x.md", md5: "L", mtimeMs: 5_000 })];
    const remote = [
      driveFile({
        path: "x.md",
        id: "d1",
        md5Checksum: undefined,
        modifiedTimeMs: 4_000,
        size: 200,
      }),
    ];
    const base = [
      baseEntry({ path: "x.md", md5: "old-base", remoteMtime: 1_000, size: 100 }),
    ];

    // Act
    const actions = run(local, remote, base);

    // Assert: beide geändert, contentEqual=false -> Konflikt, lokal jünger gewinnt.
    expect(actions).toEqual([
      { type: "conflict", path: "x.md", driveId: "d1", winner: "local" },
    ]);
  });

  it("propagiert lokale Löschung auch ohne remote md5, wenn Drive unverändert (Löschung gewinnt nicht durch fehlenden Hash)", () => {
    // Arrange: lokal gelöscht (b.local=true), Drive unverändert (mtime/size=Base),
    // aber kein md5. Ohne Fallback wäre remoteChanged fälschlich true und die
    // Löschung würde durch einen Download rückgängig gemacht.
    const remote = [
      driveFile({
        path: "del.md",
        id: "d1",
        md5Checksum: undefined,
        modifiedTimeMs: 1_000,
        size: 100,
      }),
    ];
    const base = [
      baseEntry({
        path: "del.md",
        local: true,
        remote: true,
        md5: "base-hash",
        remoteMtime: 1_000,
        size: 100,
        driveId: "d1",
      }),
    ];

    // Act: lokal fehlt.
    const actions = run([], remote, base);

    // Assert: echte lokale Löschung wird propagiert -> deleteRemote.
    expect(actions).toEqual([
      { type: "deleteRemote", path: "del.md", driveId: "d1" },
    ]);
  });
});

describe("reconcile — Löschschutz über local/remote-Flags", () => {
  it("lädt herunter statt zu löschen, wenn die Datei laut Base nie lokal war (b.local=false)", () => {
    // Arrange: Datei in Drive, fehlt lokal, Base sagt: war nur remote (local=false).
    // Das ist der Kern-Schutz: eine Datei, die lokal nie existierte, darf nicht
    // als "lokal gelöscht" gelten und die Drive-Datei löschen.
    const remote = [driveFile({ path: "only-remote.md", id: "d1", md5Checksum: "h" })];
    const base = [
      baseEntry({ path: "only-remote.md", local: false, remote: true, md5: "h", driveId: "d1" }),
    ];

    // Act
    const actions = run([], remote, base);

    // Assert: download, NICHT deleteRemote.
    expect(actions).toEqual([
      { type: "download", path: "only-remote.md", driveId: "d1" },
    ]);
  });

  it("lädt hoch statt lokal zu löschen, wenn die Datei laut Base nie remote war (b.remote=false)", () => {
    // Arrange
    const local = [localFile({ path: "only-local.md", md5: "h" })];
    const base = [
      baseEntry({ path: "only-local.md", local: true, remote: false, md5: "h" }),
    ];

    // Act
    const actions = run(local, [], base);

    // Assert: upload, NICHT deleteLocal.
    expect(actions).toEqual([{ type: "upload", path: "only-local.md" }]);
  });

  it("REGRESSION: kopierte Base (nie in diesem Vault verarbeitet) darf Drive nicht leeren", () => {
    // Arrange: Simuliert den echten Bug — neuer, leerer Vault; Drive voll.
    // Die Base kennt die Datei zwar, aber sie wurde in DIESEM Vault nie lokal
    // verarbeitet (b.local=false). Erwartung: herunterladen, NICHT löschen.
    const remote = [
      driveFile({ path: "a.md", id: "d1", md5Checksum: "x" }),
      driveFile({ path: "sub/b.md", id: "d2", md5Checksum: "y" }),
    ];
    const base = [
      baseEntry({ path: "a.md", local: false, remote: true, md5: "x", driveId: "d1" }),
      baseEntry({ path: "sub/b.md", local: false, remote: true, md5: "y", driveId: "d2" }),
    ];

    // Act
    const actions = run([], remote, base);

    // Assert: ausschließlich Downloads, keine einzige Löschung.
    expect(actions).toEqual(
      expect.arrayContaining([
        { type: "download", path: "a.md", driveId: "d1" },
        { type: "download", path: "sub/b.md", driveId: "d2" },
      ])
    );
    expect(actions.some((a) => a.type === "deleteRemote")).toBe(false);
    expect(actions).toHaveLength(2);
  });

  it("propagiert eine echte Löschung: war beidseitig (local & remote), jetzt lokal weg", () => {
    // Arrange: Datei war laut Base auf beiden Seiten, Inhalt unverändert.
    const remote = [driveFile({ path: "del.md", id: "d1", md5Checksum: "base-hash" })];
    const base = [
      baseEntry({ path: "del.md", local: true, remote: true, md5: "base-hash", driveId: "d1" }),
    ];

    // Act
    const actions = run([], remote, base);

    // Assert: jetzt IST es eine echte Löschung -> deleteRemote.
    expect(actions).toEqual([
      { type: "deleteRemote", path: "del.md", driveId: "d1" },
    ]);
  });
});

describe("reconcile — mehrere Pfade in einem Lauf", () => {
  it("verarbeitet unabhängige Pfade zu je eigener Aktion", () => {
    // Arrange
    const local = [
      localFile({ path: "up.md", md5: "new" }),      // Fall 2: upload
      localFile({ path: "keep.md", md5: "same" }),   // Fall 8: noop
    ];
    const remote = [
      driveFile({ path: "keep.md", md5Checksum: "same" }),
      driveFile({ path: "down.md", id: "dD", md5Checksum: "r" }), // Fall 3: download
    ];
    const base = [baseEntry({ path: "keep.md", md5: "same" })];

    // Act
    const actions = run(local, remote, base);

    // Assert: Reihenfolge ist nicht garantiert (Set-Iteration) -> unsortiert vergleichen.
    expect(actions).toEqual(
      expect.arrayContaining([
        { type: "upload", path: "up.md" },
        { type: "noop", path: "keep.md" },
        { type: "download", path: "down.md", driveId: "dD" },
      ])
    );
    expect(actions).toHaveLength(3);
  });
});

describe("reconcile — neverDeleteRemote (Do not delete in Google Drive)", () => {
  it("ersetzt deleteRemote durch keepRemoteDropLocal, wenn das Flag aktiv ist", () => {
    // Arrange: Datei war beidseitig, jetzt lokal weg, remote unverändert.
    const remote = [
      driveFile({ path: "del.md", id: "d1", md5Checksum: "base-hash" }),
    ];
    const base = [baseEntry({ path: "del.md", md5: "base-hash", driveId: "d1" })];

    // Act
    const actions = run([], remote, base, { neverDeleteRemote: true });

    // Assert: KEINE Drive-Löschung, sondern nur-remote-Markierung.
    expect(actions).toEqual([
      { type: "keepRemoteDropLocal", path: "del.md", driveId: "d1" },
    ]);
  });

  it("löscht remote weiterhin, wenn das Flag AUS ist (Standardverhalten)", () => {
    // Arrange
    const remote = [
      driveFile({ path: "del.md", id: "d1", md5Checksum: "base-hash" }),
    ];
    const base = [baseEntry({ path: "del.md", md5: "base-hash", driveId: "d1" })];

    // Act
    const actions = run([], remote, base, { neverDeleteRemote: false });

    // Assert
    expect(actions).toEqual([
      { type: "deleteRemote", path: "del.md", driveId: "d1" },
    ]);
  });

  it("holt trotz Flag zurück (download), wenn remote nach dem Sync geändert wurde", () => {
    // Arrange: remote geändert -> Änderung schlägt Löschung, unabhängig vom Flag.
    const remote = [
      driveFile({ path: "del.md", id: "d1", md5Checksum: "changed-remote" }),
    ];
    const base = [baseEntry({ path: "del.md", md5: "base-hash", driveId: "d1" })];

    // Act
    const actions = run([], remote, base, { neverDeleteRemote: true });

    // Assert: download, nicht keepRemoteDropLocal.
    expect(actions).toEqual([
      { type: "download", path: "del.md", driveId: "d1" },
    ]);
  });

  it("betrifft NICHT die lokale Löschung (remote gelöscht -> weiterhin deleteLocal)", () => {
    // Arrange: Datei war beidseitig, jetzt remote weg, lokal unverändert.
    const local = [localFile({ path: "del.md", md5: "base-hash" })];
    const base = [baseEntry({ path: "del.md", md5: "base-hash" })];

    // Act: Flag schützt nur Drive, nicht die lokale Seite.
    const actions = run(local, [], base, { neverDeleteRemote: true });

    // Assert
    expect(actions).toEqual([{ type: "deleteLocal", path: "del.md" }]);
  });
});
