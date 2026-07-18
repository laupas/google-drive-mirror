/**
 * Integrationstests für SyncEngine.sync() — das Zusammenspiel von
 * collectLocal() (Hash-Erhebung), Drive-Listing, reconcile() und
 * applyAction() gegen einen In-Memory-Vault und einen Fake-Drive-Client.
 *
 * Diese Tests prüfen beobachtbares Verhalten über die öffentliche sync()-API:
 * Welche Drive-Operationen laufen, wie ändert sich der Vault, was steht danach
 * in der Sync-Base. Damit sind auch die (privaten) Filter extensionAllowed /
 * isGoogleAppsFile / inScope indirekt abgedeckt.
 *
 * Format: AAA.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncEngine } from "../../src/sync-engine";
import { SyncStateStore } from "../../src/sync-state";
import { SyncStatus } from "../../src/sync-status";
import {
  DEFAULT_SETTINGS,
  PluginSettings,
  SyncStateEntry,
} from "../../src/types";
import { FakeVault } from "../helpers/fake-vault";
import { FakeDriveClient } from "../helpers/fake-drive";
import { FakeStorage } from "../helpers/fake-storage";
import { md5Hex } from "../helpers/md5";

/** Optionen für setup(): Settings + eine vorbelegte Sync-Base. */
interface SetupOptions extends Partial<PluginSettings> {
  /** Vorbelegte Base-Einträge (früher settings.syncState). */
  syncState?: Record<string, SyncStateEntry>;
}

/** Baut Engine + Fakes; gibt alle Teile für Arrange/Assert zurück. */
function setup(opts: SetupOptions = {}) {
  const { syncState, ...settingsOverrides } = opts;
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    driveFolderId: "root",
    ...settingsOverrides,
  };
  const vault = new FakeVault();
  const drive = new FakeDriveClient();
  const storage = new FakeStorage();
  const store = new SyncStateStore(storage.asStorage(), () => "test-scope");
  // Vorbelegte Base direkt in den Store legen.
  if (syncState) {
    for (const entry of Object.values(syncState)) store.set(entry);
  }
  const status = new SyncStatus(); // echte, UI-freie Status-/Log-Instanz
  const engine = new SyncEngine(
    vault as never,
    drive.asClient(),
    store,
    settings,
    status
  );
  return { engine, vault, drive, store, storage, settings, status };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SyncEngine.sync — Vorbedingungen", () => {
  it("gibt null zurück und macht nichts, wenn kein Drive-Ordner konfiguriert ist", async () => {
    // Arrange
    const { engine, drive } = setup({ driveFolderId: "" });

    // Act
    const summary = await engine.sync(false);

    // Assert
    expect(summary).toBeNull();
    expect(drive.calls.createFile).toEqual([]);
  });

  it("überspringt parallele Läufe (zweiter Aufruf während des ersten -> null)", async () => {
    // Arrange
    const { engine, vault } = setup();
    vault.seed("a.md", "inhalt");

    // Act: zwei Läufe gleichzeitig starten.
    const [first, second] = await Promise.all([
      engine.sync(false),
      engine.sync(false),
    ]);

    // Assert: genau einer läuft, der andere wird übersprungen.
    const results = [first, second];
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe("SyncEngine.sync — Upload (neue lokale Datei)", () => {
  it("lädt eine neue lokale Datei hoch und legt einen Base-Eintrag an", async () => {
    // Arrange
    const { engine, vault, drive, store } = setup();
    vault.seed("neu.md", "hallo welt");

    // Act
    const summary = await engine.sync(false);

    // Assert
    expect(summary?.uploaded).toBe(1);
    expect(drive.calls.createFile).toEqual([{ path: "neu.md" }]);
    expect(store.get("neu.md")).toBeDefined();
  });
});

describe("SyncEngine.sync — Download (neue remote Datei)", () => {
  it("lädt eine rein remote existierende Datei in den Vault und legt Base an", async () => {
    // Arrange
    const { engine, vault, drive, store } = setup();
    drive.seed({ path: "remote.md", content: "remote inhalt", md5: "r1" });

    // Act
    const summary = await engine.sync(false);

    // Assert
    expect(summary?.downloaded).toBe(1);
    expect(vault.has("remote.md")).toBe(true);
    expect(vault.read("remote.md")).toBe("remote inhalt");
    expect(store.get("remote.md")).toBeDefined();
  });
});

describe("SyncEngine.sync — Google-Apps-Dateien werden gefiltert", () => {
  it("überspringt eine Google-Docs-Datei (vnd.google-apps.*) komplett", async () => {
    // Arrange
    const { engine, vault, drive } = setup();
    drive.seed({
      path: "doc",
      content: "egal",
      md5: "g1",
      mimeType: "application/vnd.google-apps.document",
    });

    // Act
    const summary = await engine.sync(false);

    // Assert: kein Download, keine lokale Datei.
    expect(summary?.downloaded).toBe(0);
    expect(drive.calls.downloadFile).toEqual([]);
    expect(vault.has("doc")).toBe(false);
  });
});

describe("SyncEngine.sync — Dateiendungs-Whitelist", () => {
  it("lädt nur erlaubte Endungen hoch (allowedExtensions='md')", async () => {
    // Arrange
    const { engine, vault, drive } = setup({ allowedExtensions: "md" });
    vault.seed("erlaubt.md", "text");
    vault.seed("verboten.png", "binary");

    // Act
    const summary = await engine.sync(false);

    // Assert
    expect(summary?.uploaded).toBe(1);
    expect(drive.calls.createFile).toEqual([{ path: "erlaubt.md" }]);
  });

  it("behandelt die Whitelist case-insensitive und mit optionalem Punkt", async () => {
    // Arrange
    const { engine, vault, drive } = setup({ allowedExtensions: ".MD, PNG" });
    vault.seed("a.md", "text");
    vault.seed("b.PNG", "img");
    vault.seed("c.txt", "no");

    // Act
    await engine.sync(false);

    // Assert
    const paths = drive.calls.createFile.map((c) => c.path).sort();
    expect(paths).toEqual(["a.md", "b.PNG"]);
  });
});

describe("SyncEngine.sync — Scope auf Unterordner (localFolder)", () => {
  it("synct nur Dateien innerhalb von localFolder und strippt das Präfix im Drive-Pfad", async () => {
    // Arrange
    const { engine, vault, drive } = setup({ localFolder: "sync" });
    vault.seed("sync/drin.md", "im scope");
    vault.seed("aussen.md", "out of scope");

    // Act
    const summary = await engine.sync(false);

    // Assert: nur die Datei im Ordner, und ihr Pfad ist relativ zum Ordner.
    expect(summary?.uploaded).toBe(1);
    expect(drive.calls.createFile).toEqual([{ path: "drin.md" }]);
  });

  it("schreibt einen remote Download an den korrekten absoluten Vault-Pfad (Präfix vorangestellt)", async () => {
    // Arrange: Remote-Pfad ist sync-relativ (so wie beim Upload gespeichert).
    const { engine, vault, drive } = setup({ localFolder: "sync" });
    drive.seed({ path: "drin.md", content: "runtergeladen", md5: "r1" });

    // Act
    await engine.sync(false);

    // Assert: landet unter sync/drin.md im Vault.
    expect(vault.has("sync/drin.md")).toBe(true);
    expect(vault.read("sync/drin.md")).toBe("runtergeladen");
  });
});

describe("SyncEngine.sync — Löschung remote propagieren", () => {
  it("löscht lokal, wenn die Datei remote gelöscht wurde und lokal unverändert ist", async () => {
    // Arrange: Base kennt die Datei, lokal noch da, remote weg.
    const md5 = md5Hex("stabiler inhalt");
    const { engine, vault, store } = setup({
      syncState: {
        "x.md": {
          path: "x.md",
          local: true,
          remote: true,
          isFolder: false,
          driveId: "d-x",
          md5,
          size: 14,
          localMtime: 1_000,
          remoteMtime: 1_000,
        },
      },
    });
    vault.seed("x.md", "stabiler inhalt");
    // Drive leer -> remote gelöscht.

    // Act
    const summary = await engine.sync(false);

    // Assert
    expect(summary?.deletedLocal).toBe(1);
    expect(vault.has("x.md")).toBe(false);
    expect(store.get("x.md")).toBeUndefined();
  });
});

describe("SyncEngine.sync — Do not delete in Google Drive (neverDeleteRemote)", () => {
  it("behält die Drive-Datei bei lokaler Löschung und setzt Base auf nur-remote", async () => {
    // Arrange: Datei war beidseitig, lokal jetzt weg, remote unverändert.
    const content = "bleibt in drive";
    const md5 = md5Hex(content);
    const { engine, drive, store } = setup({
      neverDeleteRemote: true,
      syncState: {
        "keep.md": {
          path: "keep.md",
          local: true,
          remote: true,
          isFolder: false,
          driveId: "d-keep",
          md5,
          size: content.length,
          localMtime: 1_000,
          remoteMtime: 1_000,
        },
      },
    });
    // Lokal fehlt die Datei; in Drive ist sie noch da.
    drive.seed({ path: "keep.md", content, md5, id: "d-keep" });

    // Act
    const summary = await engine.sync(false);

    // Assert: KEINE Drive-Löschung; Base auf nur-remote mit keptRemoteOnly.
    expect(drive.calls.trashFile).toEqual([]);
    expect(summary?.deletedRemote).toBe(0);
    const entry = store.get("keep.md");
    expect(entry).toMatchObject({
      local: false,
      remote: true,
      keptRemoteOnly: true,
    });
  });

  it("holt eine nur-remote-Datei NICHT als Zombie zurück (local=false verhindert Download)", async () => {
    // Arrange: Base sagt local=false, remote=true; Datei in Drive vorhanden.
    const content = "nur remote";
    const md5 = md5Hex(content);
    const { engine, vault, drive } = setup({
      neverDeleteRemote: true,
      syncState: {
        "keep.md": {
          path: "keep.md",
          local: false,
          remote: true,
          keptRemoteOnly: true,
          isFolder: false,
          driveId: "d-keep",
          md5,
          size: content.length,
          localMtime: 0,
          remoteMtime: 1_000,
        },
      },
    });
    drive.seed({ path: "keep.md", content, md5, id: "d-keep" });

    // Act
    const summary = await engine.sync(false);

    // Assert: kein Download, Datei bleibt lokal abwesend.
    expect(summary?.downloaded).toBe(0);
    expect(drive.calls.downloadFile).toEqual([]);
    expect(vault.has("keep.md")).toBe(false);
  });
});

describe("SyncEngine.sync — Fehler werden gesammelt, nicht geworfen", () => {
  it("sammelt einen Download-Fehler in summary.errors und läuft weiter", async () => {
    // Arrange
    const { engine, drive } = setup();
    drive.seed({ path: "kaputt.md", content: "x", md5: "r1", id: "d-boom" });
    vi.spyOn(drive, "downloadFile").mockRejectedValue(new Error("Netzwerk weg"));

    // Act
    const summary = await engine.sync(false);

    // Assert
    expect(summary?.errors.length).toBe(1);
    expect(summary?.errors[0]).toMatch(/Netzwerk weg/);
    expect(summary?.downloaded).toBe(0);
  });
});

describe("SyncEngine.sync — keine Änderungen", () => {
  it("macht bei identischem Stand (lokal == remote == base) keine Drive-Schreiboperation", async () => {
    // Arrange
    const content = "unveraendert";
    const md5 = md5Hex(content);
    const { engine, vault, drive } = setup({
      syncState: {
        "s.md": {
          path: "s.md",
          local: true,
          remote: true,
          isFolder: false,
          driveId: "d-s",
          md5,
          size: content.length,
          localMtime: 1_000,
          remoteMtime: 1_000,
        },
      },
    });
    vault.seed("s.md", content);
    drive.seed({ path: "s.md", content, md5, id: "d-s" });

    // Act
    const summary = await engine.sync(false);

    // Assert
    expect(summary).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
    });
    expect(drive.calls.createFile).toEqual([]);
    expect(drive.calls.updateFile).toEqual([]);
  });
});

describe("SyncEngine.sync — Checkpoint-Speichern bei großen Läufen", () => {
  it("speichert den State alle 50 Aktionen zwischen (plus einmal am Ende)", async () => {
    // Arrange: 120 neue lokale Dateien -> 120 Uploads.
    const { engine, vault, storage } = setup();
    for (let i = 0; i < 120; i++) vault.seed(`f${i}.md`, `inhalt-${i}`);

    // Act
    const summary = await engine.sync(false);

    // Assert: 120 Uploads, und sync-state.json wurde 3× geschrieben
    // (Checkpoint nach 50 und 100, plus finaler Save am Laufende).
    expect(summary?.uploaded).toBe(120);
    expect(storage.writeCount("sync-state.json")).toBe(3);
  });

  it("ein Checkpoint enthält bereits die abgeschlossenen Übertragungen", async () => {
    // Arrange: genau 50 Uploads -> genau 1 Checkpoint (+ finaler Save).
    const { engine, vault, storage } = setup();
    for (let i = 0; i < 50; i++) vault.seed(`g${i}.md`, `x${i}`);

    // Act
    await engine.sync(false);

    // Assert: nach 50 Aktionen 1 Checkpoint + 1 finaler Save = 2 Writes; der
    // persistierte State enthält alle 50 Einträge (local & remote true).
    expect(storage.writeCount("sync-state.json")).toBe(2);
    const persisted = storage.peek("sync-state.json") as {
      entries: Record<string, { local: boolean; remote: boolean }>;
    };
    expect(Object.keys(persisted.entries)).toHaveLength(50);
    expect(persisted.entries["g0.md"]).toMatchObject({ local: true, remote: true });
  });
});

describe("SyncEngine.sync — Pfad-Kollision: doppelte Drive-Dateinamen", () => {
  it("überspringt den Pfad komplett, wenn zwei Drive-Dateien mit gleichem Pfad UNTERSCHIEDLICHEN Inhalt haben", async () => {
    // Arrange: zwei Drive-Dateien, gleicher Pfad, verschiedene md5.
    const { engine, drive, vault, store } = setup();
    drive.seed({ path: "dup.md", content: "version A", md5: "hA", id: "d-A" });
    drive.seed({ path: "dup.md", content: "version B", md5: "hB", id: "d-B" });

    // Act
    const summary = await engine.sync(false);

    // Assert: nichts heruntergeladen, keine Base, ein Fehler gemeldet.
    expect(drive.calls.downloadFile).toEqual([]);
    expect(vault.has("dup.md")).toBe(false);
    expect(store.get("dup.md")).toBeUndefined();
    expect(summary?.errors.some((e) => e.includes("dup.md"))).toBe(true);
  });

  it("wählt bei INHALTSGLEICHEN Duplikaten (gleicher md5) deterministisch eine und synct normal", async () => {
    // Arrange: zwei Drive-Dateien, gleicher Pfad, gleicher md5.
    const { engine, drive, vault } = setup();
    drive.seed({ path: "dup.md", content: "same", md5: "hSame", id: "d-2" });
    drive.seed({ path: "dup.md", content: "same", md5: "hSame", id: "d-1" });

    // Act
    const summary = await engine.sync(false);

    // Assert: genau ein Download (die kleinste ID "d-1"), kein Fehler.
    expect(summary?.downloaded).toBe(1);
    expect(drive.calls.downloadFile).toEqual(["d-1"]);
    expect(vault.read("dup.md")).toBe("same");
    expect(summary?.errors ?? []).toEqual([]);
  });
});

describe("SyncEngine.sync — Schutz vor Remote-Teilbaum-Verlust", () => {
  it("löscht einen Drive-Ordner NICHT, wenn er noch Drive-Dateien enthält (auch wenn er lokal fehlt)", async () => {
    // Arrange: Drive hat Ordner "sub" mit einer Datei "sub/keep.md". Die Base
    // sagt: "sub" war zuletzt lokal+remote da. Lokal fehlt "sub" nun komplett
    // (z.B. transienter Ordner-Enumerierungs-Aussetzer). Ohne Schutz würde
    // reconcileFolders deleteRemoteFolder("sub") -> trasht den ganzen Teilbaum.
    const { engine, drive, store } = setup();
    const subId = await drive.createFolderPath("root", "sub");
    // Datei liegt remote unter sub/ und existiert auch lokal nicht -> bleibt
    // remote (Base kennt sie nicht -> gilt als Neuzugang -> Download, kein Delete).
    drive.seed({ path: "sub/keep.md", content: "wichtig", md5: "k1", id: "d-keep" });
    // Ordner-Base: sub war lokal+remote vorhanden.
    store.set({
      path: "sub",
      local: true,
      remote: true,
      isFolder: true,
      driveId: subId,
      md5: "",
      size: 0,
      localMtime: 0,
      remoteMtime: 0,
    });

    // Act
    const summary = await engine.sync(false);

    // Assert: KEIN trashFolder; stattdessen ein Fehler/Hinweis, dass der Ordner
    // noch Dateien enthält.
    expect(drive.calls.trashFolder).toEqual([]);
    expect(
      summary?.errors.some((e) => e.includes("sub") && e.includes("files"))
    ).toBe(true);
  });
});

describe("SyncEngine.sync — lokale Ordner aus Datei-Elternketten abgeleitet", () => {
  it("erkennt einen befüllten lokalen Ordner als vorhanden, auch wenn getAllLoadedFiles() leer ist", async () => {
    // Arrange: lokale Datei in Unterordner; getAllLoadedFiles() ist im Fake leer.
    // Der Ordner "sub" muss trotzdem als lokal vorhanden gelten (aus der
    // Elternkette von "sub/a.md" abgeleitet) und daher in Drive angelegt werden.
    const { engine, vault, drive } = setup();
    vault.seed("sub/a.md", "inhalt");

    // Act
    await engine.sync(false);

    // Assert: Ordner "sub" wurde in Drive angelegt (aus der Elternkette).
    expect(drive.calls.createFolderPath.map((c) => c.path)).toContain("sub");
  });
});
