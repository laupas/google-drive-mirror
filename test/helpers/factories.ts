/**
 * Test factories: build valid domain objects with sensible defaults, so that
 * each test in its arrange block only overrides the fields relevant to it.
 */

import { LocalFile } from "../../src/reconciler";
import { DriveFile, SyncStateEntry } from "../../src/types";

/** Local file with defaults; overrides via Partial. */
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
 * A Drive file plus vault-relative path. The path is NOT a field of
 * DriveFile (in real code the path comes from drive.pathOf / the map key),
 * but is carried along for tests so mapByPath can index by it.
 */
export type DriveFileWithPath = DriveFile & { path: string };

/** Drive file with defaults; overrides via Partial (incl. path). */
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
 * Base/sync-state entry with defaults; overrides via Partial.
 * Default: file last existed on BOTH sides (local & remote), not a folder.
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

/** Builds a Map<string, T> from objects with a `path` field. */
export function mapByPath<T extends { path: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.path, i]));
}
