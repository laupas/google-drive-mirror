import {
  DriveFile,
  FolderAction,
  SyncAction,
  SyncStateEntry,
} from "./types";

/** Snapshot of a local file (collected by the SyncEngine). */
export interface LocalFile {
  path: string;
  md5: string;
  size: number;
  mtimeMs: number;
}

/** Inputs for a reconcile run. */
export interface ReconcileInput {
  /** Current local state: path -> file. */
  local: Map<string, LocalFile>;
  /** Current Drive state (non-trashed): path -> Drive file. */
  remote: Map<string, DriveFile>;
  /** Base from the last sync: path -> entry. */
  base: Map<string, SyncStateEntry>;
  /**
   * "Do not delete in Google Drive": When true, a local deletion is NOT
   * propagated as `deleteRemote` but as `keepRemoteDropLocal` (Drive file
   * stays, base is set to remote-only). Default: false.
   */
  neverDeleteRemote?: boolean;
}

/**
 * Compares the local state, remote state and the base (last sync) and
 * derives the action to perform for each path.
 *
 * Basic principle:
 *   - "changed" = md5 differs from the base (or no base = new).
 *   - "deleted" = missing now, but according to the base was present on THIS
 *     side (b.local resp. b.remote). Exactly this condition prevents a
 *     file that never existed here (empty/copied/foreign base) from being
 *     wrongly interpreted as a deletion and emptying the other side.
 *
 * Conflict strategy: "newer wins" — on a change on both sides the
 * more recent mtime timestamp decides.
 *
 * Deletions are propagated to the trash — unless the other side has
 * changed the same file too; then the change wins (no
 * data loss).
 */
export function reconcile(input: ReconcileInput): SyncAction[] {
  const { local, remote, base, neverDeleteRemote = false } = input;
  const actions: SyncAction[] = [];

  // Union of all paths that appear anywhere.
  const paths = new Set<string>([
    ...local.keys(),
    ...remote.keys(),
    ...base.keys(),
  ]);

  for (const path of paths) {
    const l = local.get(path);
    const r = remote.get(path);
    const b = base.get(path);

    const localChanged = l ? !b || l.md5 !== b.md5 : false;
    // For some files Drive returns NO md5Checksum. In that case "no hash"
    // must not count as "changed" — otherwise the file would be re-downloaded
    // on every run (infinite loop) and a deletion would be wrongly counted
    // as a change. Fallback in that case: compare mtime/size against the base.
    const remoteChanged = r
      ? !b ||
        (r.md5Checksum !== undefined
          ? r.md5Checksum !== b.md5
          : r.modifiedTimeMs > b.remoteMtime ||
            (r.size !== undefined && r.size !== b.size))
      : false;
    const contentEqual =
      !!l && !!r && !!r.md5Checksum && l.md5 === r.md5Checksum;

    // CORE OF THE DELETION SAFETY: A file only counts as "deleted" if the
    // base attests that it actually existed on THIS side last time.
    //   - missing locally, but base says b.local=true -> real local deletion
    //   - missing locally, and b.local=false/no base -> was never here -> new addition
    // This way a base (e.g. copied from another vault) that does not list a
    // never-locally-existent file as local=true cannot trigger a deletion.
    const localDeleted = !l && !!b && b.local;
    const remoteDeleted = !r && !!b && b.remote;

    // --- Case 1: no longer present anywhere ---
    if (!l && !r) {
      // Nothing to do. (Any remaining base entry is cleaned up by the engine.)
      continue;
    }

    // --- Case 2: only local, was never/not in Drive -> upload ---
    if (l && !r && !remoteDeleted) {
      actions.push({ type: "upload", path });
      continue;
    }

    // --- Case 3: only remote present ---
    if (!l && r && !localDeleted) {
      // Special case "deliberately remote-only" (keptRemoteOnly): deleted locally, but
      // kept in Drive via "Do not delete in Google Drive" and intentionally
      // NOT restored locally. As long as the Drive file is unchanged,
      // do NOT download (no zombie). Only once the Drive file changes
      // (new version) does it win -> download.
      // IMPORTANT: only when keptRemoteOnly is set — a mere local=false base
      // (e.g. copied/foreign) is still downloaded (data-loss protection).
      if (b?.keptRemoteOnly && !remoteChanged) {
        actions.push({ type: "noop", path });
      } else {
        actions.push({ type: "download", path, driveId: r.id });
      }
      continue;
    }

    // --- Case 4: present on both sides, but no (valid) base -> collision ---
    if (l && r && !b) {
      if (contentEqual) {
        actions.push({ type: "noop", path });
      } else {
        actions.push({
          type: "conflict",
          path,
          driveId: r.id,
          winner: l.mtimeMs >= r.modifiedTimeMs ? "local" : "remote",
        });
      }
      continue;
    }

    // --- Case 6: deleted locally (missing locally, was local per the base) ---
    if (localDeleted && r) {
      if (remoteChanged) {
        // Remote was changed after the last sync -> change beats
        // deletion: fetch it back to local (no data loss).
        actions.push({ type: "download", path, driveId: r.id });
      } else if (neverDeleteRemote) {
        // Setting "Do not delete in Google Drive": keep Drive file, only
        // set the base entry to remote-only (no local zombie).
        actions.push({ type: "keepRemoteDropLocal", path, driveId: r.id });
      } else {
        // Remote unchanged -> propagate deletion (trash).
        actions.push({ type: "deleteRemote", path, driveId: r.id });
      }
      continue;
    }

    // --- Case 7: deleted remotely (missing remote, was remote per the base) ---
    if (remoteDeleted && l) {
      if (localChanged) {
        // Was changed locally -> change beats deletion: upload.
        actions.push({ type: "upload", path });
      } else {
        // Locally unchanged -> propagate the local deletion.
        actions.push({ type: "deleteLocal", path });
      }
      continue;
    }

    // From here on: both present with a base. (l and r set.)
    if (!l || !r) continue; // type guard (theoretically unreachable)

    // --- Case 8: neither side changed ---
    if (!localChanged && !remoteChanged) {
      actions.push({ type: "noop", path });
      continue;
    }

    // --- Case 9: only local changed ---
    if (localChanged && !remoteChanged) {
      actions.push({ type: "upload", path });
      continue;
    }

    // --- Case 10: only remote changed ---
    if (!localChanged && remoteChanged) {
      actions.push({ type: "download", path, driveId: r.id });
      continue;
    }

    // --- Case 11: both changed ---
    if (contentEqual) {
      // Coincidentally identical -> only update the base.
      actions.push({ type: "noop", path });
    } else {
      actions.push({
        type: "conflict",
        path,
        driveId: r.id,
        winner: l.mtimeMs >= r.modifiedTimeMs ? "local" : "remote",
      });
    }
  }

  return actions;
}

/** Inputs for the folder reconcile (existence on both sides + base). */
export interface ReconcileFoldersInput {
  /** Currently existing local folders (relative paths). */
  local: Set<string>;
  /** Currently existing folders in Drive: path -> Drive ID. */
  remote: Map<string, string>;
  /** Folder base from the last sync: path -> entry (isFolder=true). */
  base: Map<string, SyncStateEntry>;
  /**
   * "Do not delete in Google Drive": When true, a locally deleted
   * folder is NOT removed from Drive (analogous to files). Default: false.
   */
  neverDeleteRemote?: boolean;
}

/**
 * Reconcile for folders — analogous to files, but without content/hash. Only
 * existence plus the local/remote flags of the base matter.
 *
 * Deletion rule as for files: A folder is only deleted on one side
 * if the base attests that it last existed there (b.local resp. b.remote).
 * Otherwise it counts as a new addition and is created on the other side.
 */
export function reconcileFolders(
  input: ReconcileFoldersInput
): FolderAction[] {
  const { local, remote, base, neverDeleteRemote = false } = input;
  const actions: FolderAction[] = [];

  const paths = new Set<string>([
    ...local,
    ...remote.keys(),
    ...base.keys(),
  ]);

  for (const path of paths) {
    const l = local.has(path);
    const r = remote.has(path);
    const b = base.get(path);

    const localDeleted = !l && !!b && b.local;
    const remoteDeleted = !r && !!b && b.remote;

    // Both present -> nothing to do.
    if (l && r) {
      actions.push({ type: "noopFolder", path });
      continue;
    }

    // Only local, and not known as remote-deleted -> create in Drive.
    if (l && !r && !remoteDeleted) {
      actions.push({ type: "createRemoteFolder", path });
      continue;
    }

    // Only remote present.
    if (!l && r && !localDeleted) {
      // "Deliberately remote-only" (keptRemoteOnly): keep folder in Drive, do
      // NOT restore locally (no zombie). Otherwise: create locally.
      if (b?.keptRemoteOnly) {
        actions.push({ type: "noopFolder", path });
      } else {
        actions.push({ type: "createLocalFolder", path });
      }
      continue;
    }

    // Deleted locally (was local per the base).
    if (localDeleted && r) {
      const driveId = remote.get(path)!;
      if (neverDeleteRemote) {
        // "Do not delete in Google Drive": keep folder in Drive.
        actions.push({ type: "keepRemoteFolder", path, driveId });
      } else {
        actions.push({ type: "deleteRemoteFolder", path, driveId });
      }
      continue;
    }

    // Deleted remotely (was remote per the base) -> delete locally.
    if (remoteDeleted && l) {
      actions.push({ type: "deleteLocalFolder", path });
      continue;
    }

    // Otherwise (e.g. gone on both sides) -> nothing; base entry is cleaned up.
  }

  return actions;
}
