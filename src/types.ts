/**
 * Central type definitions for the Google Drive sync plugin.
 */

/**
 * One configured sync target: a pairing of a Google Drive folder with a local
 * vault (sub)folder plus its own filters and deletion behavior. A plugin can
 * hold MANY targets (each syncing an independent scope). One target may be a
 * whole-vault sync (`localFolder === ""`); such a target automatically excludes
 * the local folders of all OTHER targets so a subfolder is never synced into
 * two Drives at once (see `excludeFolders`).
 *
 * All targets share the SAME OAuth account (the global credentials on
 * `PluginSettings`). Each target keeps its OWN sync base in a separate file
 * (`sync-state-<id>.json`) so a deletion in one scope never leaks into another.
 */
export interface SyncTarget {
  /** Stable identity (used for the per-target state file and the scope ID). */
  id: string;
  /** Human-readable name shown in the settings UI. */
  name: string;

  /** Google Drive folder ID that serves as the sync root for this target. */
  driveFolderId: string;
  /** Display name of the Drive folder (UI only). */
  driveFolderName: string;
  /**
   * ID of the Shared Drive, if the root folder lives in one.
   * Empty = regular "My Drive". Controls the Shared Drive parameters of the list API.
   */
  driveSharedId: string;

  /** Vault-relative subfolder that is synced ("" = whole vault). */
  localFolder: string;

  /**
   * Comma-separated list of allowed file extensions (without dot), e.g.
   * "md, png, jpg, pdf". Empty = all extensions allowed.
   * Google Editors files (Docs/Sheets/…) are always ignored regardless,
   * since they have no downloadable binary content.
   */
  allowedExtensions: string;

  /**
   * Comma-separated list of ignore patterns (blacklist), complementary to
   * `allowedExtensions`. Allows plain extensions (`tmp`, `.tmp`) as well as
   * glob patterns (`*.log`, `temp/*`, `**\/drafts\/**`). Empty = ignore nothing.
   * Applies on BOTH sides (local + Drive), so an ignored file is not
   * misinterpreted as "deleted on one side". See `src/ignore.ts`.
   */
  ignorePatterns: string;

  /**
   * Comma-separated list of vault-relative folders to exclude from this target,
   * on top of the automatic exclusion of other targets' local folders. Matched
   * against the sync-relative path like a folder prefix (an entry `drafts`
   * excludes `drafts` and everything under `drafts/`). Applies on BOTH sides
   * (local + Drive, files + folders) so an excluded path is never seen as
   * "deleted on one side". Empty = exclude nothing extra.
   */
  excludeFolders: string;

  /**
   * "Do not delete in Google Drive". When true, a LOCAL deletion is not
   * propagated to Drive — the Drive file is kept and the base entry
   * is set to `local=false, remote=true` (the file does not return locally as a
   * zombie). Via the "Drive only" tree in the settings the
   * `local=false` flag can be removed so the file is downloaded again.
   * Default: false.
   */
  neverDeleteRemote: boolean;
}

/** Persistent plugin settings (stored in data.json). */
export interface PluginSettings {
  /** OAuth client ID of the user's own Google Cloud app ("Desktop app" client). */
  clientId: string;
  /** OAuth client secret of the user's own Google Cloud app. */
  clientSecret: string;
  /**
   * Long-lived refresh token from which access tokens are derived. Obtained by
   * signing in on desktop; on mobile it is pasted in from the desktop token
   * (mobile can't run the interactive redirect flow).
   */
  refreshToken: string;

  /**
   * Configured sync targets. Each has its own Drive folder + local scope +
   * filters and its own sync base file. All share the global OAuth account.
   */
  targets: SyncTarget[];

  /** Automatic sync active? */
  autoSyncEnabled: boolean;
  /** Poll interval for Drive changes in seconds. */
  pollIntervalSeconds: number;
  /** Delay after a local change before upload (debounce) in ms. */
  localDebounceMs: number;

  /**
   * Retention duration for log entries in hours. Older entries are
   * removed automatically. 0 = never delete automatically.
   */
  logRetentionHours: number;

  /**
   * Verbose debug logging in the developer console. Off by default,
   * so the console only shows errors (Obsidian guideline).
   */
  debugLogging: boolean;

  /**
   * How many Drive folders are listed in parallel DURING THE FETCH PHASE ON
   * MOBILE. Each concurrent request holds a parsed response page (up to 1000
   * file records) in memory; too many at once on a large Drive pushes the iOS
   * WebView past its memory limit and the OS silently kills it ("Fetching
   * Google Drive" crash). Lower = safer but slower fetch; higher = faster fetch
   * but more memory. Desktop is unaffected (fixed higher value, no memory
   * pressure). Default 4.
   */
  mobileListConcurrency: number;
}

/**
 * State of a file (or folder) at the last successful sync —
 * the "memory" between two runs.
 *
 * Core of the deletion safety: `local`/`remote` remember on which side the
 * file ACTUALLY existed at the last processing. A deletion is only
 * propagated if the file was previously on BOTH sides (local && remote)
 * and is now missing on one — then it is a real deletion, not a new addition.
 */
export interface SyncStateEntry {
  /** Vault-relative path (key, plain text — also serves as ID). */
  path: string;
  /** Did the file exist locally at the last processing? */
  local: boolean;
  /** Did the file exist in Drive at the last processing? */
  remote: boolean;
  /** true if this entry describes a folder (no hash/mtime). */
  isFolder: boolean;
  /** Google Drive file ID (empty for a pure folder placeholder without a Drive counterpart). */
  driveId: string;
  /** MD5 hash of the content at the last sync (empty for folders). */
  md5: string;
  /** Size in bytes at the last sync. */
  size: number;
  /** Local mtime at the last sync (ms). */
  localMtime: number;
  /** Drive modifiedTime at the last sync (ms). */
  remoteMtime: number;
  /**
   * true if the file is DELIBERATELY kept in Drive only: deleted locally,
   * but not removed from Drive because of "Do not delete in Google Drive" and
   * intentionally NOT restored locally. Distinguishes this case from
   * a foreign/copied base (local=false), which very much should be
   * downloaded. Reset via the "Drive only" tree in the settings.
   */
  keptRemoteOnly?: boolean;
}

/** A Google Drive folder with a vault-relative path (from the recursive listFiles). */
export interface DriveFolder {
  id: string;
  relativePath: string;
}

/** A Google Drive file entry (subset of the API fields). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** ms since epoch. */
  modifiedTimeMs: number;
  md5Checksum?: string;
  size?: number;
  trashed: boolean;
  parents?: string[];
  /**
   * Path relative to the sync root folder, derived from the folder chain
   * (e.g. "sub/note.md"). Set by the recursive listFiles().
   */
  relativePath?: string;
}

/** Result categories of the reconciler for a single file. */
export type SyncAction =
  | { type: "upload"; path: string } // local -> Drive (new or changed)
  | { type: "download"; path: string; driveId: string } // Drive -> local
  | { type: "deleteLocal"; path: string } // deleted in Drive -> delete locally
  | { type: "deleteRemote"; path: string; driveId: string } // deleted locally -> delete in Drive
  // Do NOT propagate a local deletion to Drive (setting "Do not delete in
  // Google Drive"). No Drive operation; the engine sets the base entry to
  // local=false, remote=true, so the file stays in Drive and does not return
  // locally as a zombie.
  | { type: "keepRemoteDropLocal"; path: string; driveId: string }
  | { type: "conflict"; path: string; driveId: string; winner: "local" | "remote" } // both changed
  | { type: "noop"; path: string };

/** Actions for folders (sync/delete empty folders). */
export type FolderAction =
  | { type: "createLocalFolder"; path: string } // create folder locally
  | { type: "createRemoteFolder"; path: string } // create folder in Drive
  | { type: "deleteLocalFolder"; path: string } // delete folder locally
  | { type: "deleteRemoteFolder"; path: string; driveId: string } // delete folder in Drive
  // Locally deleted folder, but "Do not delete in Google Drive" active:
  // keep folder in Drive, set base to remote-only (keptRemoteOnly).
  | { type: "keepRemoteFolder"; path: string; driveId: string }
  | { type: "noopFolder"; path: string };

/** Aggregated result of a sync run (for notices/logs). */
export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: string[];
  /**
   * True when the run stopped early because it hit the per-run action cap
   * (mobile batch limit) and more work remains. The caller re-runs the sync to
   * continue. Absent/false means the run processed everything.
   */
  moreRemaining?: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  targets: [],
  autoSyncEnabled: false,
  pollIntervalSeconds: 60,
  localDebounceMs: 2500,
  logRetentionHours: 24,
  debugLogging: false,
  mobileListConcurrency: 4,
};

/** Builds a fresh, empty sync target with sensible defaults. */
export function newTarget(id: string, name: string): SyncTarget {
  return {
    id,
    name,
    driveFolderId: "",
    driveFolderName: "",
    driveSharedId: "",
    localFolder: "",
    allowedExtensions: "",
    ignorePatterns: "",
    excludeFolders: "",
    neverDeleteRemote: false,
  };
}

/** OAuth scope: full Drive access, so that files created manually in Drive are also visible. */
export const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";
