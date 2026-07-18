/**
 * Test-Factories: bauen valide Domänenobjekte mit sinnvollen Defaults, sodass
 * jeder Test im Arrange-Block nur die für ihn relevanten Felder überschreibt.
 */

import { LocalFile } from "../../src/reconciler";
import { DriveFile, SyncStateEntry } from "../../src/types";

/** Lokale Datei mit Defaults; Überschreibungen via Partial. */
export function localFile(overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    path: "note.md",
    md5: "hash-local",
    size: 100,
    mtimeMs: 1_000,
    ...overrides,
  };
}

/**
 * Eine Drive-Datei plus vault-relativer Pfad. Der Pfad ist KEIN Feld von
 * DriveFile (den Pfad liefert im echten Code drive.pathOf / der Map-Key),
 * wird für Tests aber mitgeführt, damit mapByPath danach indizieren kann.
 */
export type DriveFileWithPath = DriveFile & { path: string };

/** Drive-Datei mit Defaults; Überschreibungen via Partial (inkl. path). */
export function driveFile(
  overrides: Partial<DriveFileWithPath> = {}
): DriveFileWithPath {
  return {
    path: "note.md",
    id: "drive-id-1",
    name: "note.md",
    mimeType: "text/markdown",
    modifiedTimeMs: 1_000,
    md5Checksum: "hash-remote",
    size: 100,
    trashed: false,
    ...overrides,
  };
}

/**
 * Base-/Sync-State-Eintrag mit Defaults; Überschreibungen via Partial.
 * Default: Datei existierte zuletzt auf BEIDEN Seiten (local & remote), kein Ordner.
 */
export function baseEntry(overrides: Partial<SyncStateEntry> = {}): SyncStateEntry {
  return {
    path: "note.md",
    local: true,
    remote: true,
    isFolder: false,
    driveId: "drive-id-1",
    md5: "hash-base",
    size: 100,
    localMtime: 1_000,
    remoteMtime: 1_000,
    ...overrides,
  };
}

/** Baut eine Map<string, T> aus Objekten mit `path`-Feld. */
export function mapByPath<T extends { path: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.path, i]));
}
