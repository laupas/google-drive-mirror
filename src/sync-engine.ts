import { Notice, TFile, TFolder, Vault, normalizePath } from "obsidian";
import type { FileManager } from "obsidian";
import { GoogleDriveClient } from "./drive-client";
import { LocalFile, reconcile, reconcileFolders } from "./reconciler";
import { SyncStateStore } from "./sync-state";
import { SyncStatus } from "./sync-status";
import { log } from "./logger";
import { t } from "./i18n";
import { extensionAllowed, isIgnored, parseIgnorePatterns } from "./ignore";
import {
  DriveFile,
  FolderAction,
  SyncAction,
  SyncStateEntry,
  SyncSummary,
  SyncTarget,
} from "./types";

/** Pure-JS MD5 — works on desktop and mobile (no Node `crypto`). */
import { md5Hex } from "./md5";

/**
 * After this many executed (real) actions the sync state is
 * checkpointed. Protects large runs against interruption, without
 * rewriting the entire state file after each file (O(n²) writes).
 */
const CHECKPOINT_EVERY = 50;

/**
 * How many file transfers (upload/download/delete) run concurrently. Network
 * I/O parallelizes well; kept moderate to stay within Google's rate limits
 * (transient 429s are retried by the Drive client's request wrapper).
 */
const MAX_CONCURRENCY = 6;

/**
 * Frozen copy of the scope-relevant settings fields for the duration of ONE
 * sync run. Prevents a folder/scope change in the middle of a run from taking
 * effect live (see `SyncEngine.active`).
 */
interface ScopeSnapshot {
  driveFolderId: string;
  driveSharedId: string;
  localFolder: string;
  allowedExtensions: string;
  /** Pre-parsed ignore patterns (blacklist) for the duration of the run. */
  ignorePatterns: string[];
  /**
   * Sync-relative folder prefixes that are excluded from THIS target for the
   * duration of the run. Combines the user's `excludeFolders` with the local
   * folders of all OTHER targets (so a whole-vault target does not also sync a
   * subfolder that another target owns). A path is excluded if it equals one of
   * these or lies under it (prefix + "/"). Applied on BOTH sides.
   */
  excludeFolders: string[];
}

/** Empty scope snapshot (before the first run). */
function emptyScope(): ScopeSnapshot {
  return {
    driveFolderId: "",
    driveSharedId: "",
    localFolder: "",
    allowedExtensions: "",
    ignorePatterns: [],
    excludeFolders: [],
  };
}

/**
 * Orchestrates a complete two-way sync run:
 *   1. Collect the local state (hashes in the sync folder) + folders.
 *   2. Fetch the Drive state (files + folders).
 *   3. Query the reconciler (files and folders).
 *   4. Execute actions (create folders → files → delete folders).
 *   5. Update and persist the sync base.
 *
 * The deletion safety sits in the reconciler (deletion only on attested
 * two-sided existence via local/remote flags) — hence no separate deletion prompt.
 *
 * Runs are serialized (no parallel sync) via a running flag.
 */
export class SyncEngine {
  private running = false;

  /**
   * Snapshot of the scope-relevant target fields for the duration of ONE run.
   * `target` is a mutable object shared with main.ts/SettingsTab — a folder
   * change in the middle of a run would otherwise take effect live (e.g. the
   * `localFolder` prefix changes between collectLocal and applyAction → paths
   * no longer match). Set in sync().
   */
  private active: ScopeSnapshot = emptyScope();

  /**
   * @param target                The sync target this engine operates on.
   * @param siblingLocalFolders   Returns the vault-relative local folders of
   *                              all OTHER targets. They are excluded from this
   *                              target's scope so a subfolder owned by another
   *                              target is never synced into two Drives (mainly
   *                              relevant for a whole-vault target). Evaluated
   *                              once per run and frozen into the snapshot.
   */
  constructor(
    private vault: Vault,
    private drive: GoogleDriveClient,
    private state: SyncStateStore,
    private target: SyncTarget,
    private status: SyncStatus,
    private fileManager: FileManager,
    private siblingLocalFolders: () => string[] = () => []
  ) {}

  /**
   * Moves a local file/folder to the trash via `FileManager.trashFile()`, which
   * honors the vault's "Deleted files" preference (vault `.trash`, system trash,
   * or permanent).
   */
  private async trashFile(file: TFile | TFolder): Promise<void> {
    await this.fileManager.trashFile(file);
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Performs a complete sync. Returns a summary.
   * On a parallel call the second call is skipped.
   */
  async sync(showNotice = true): Promise<SyncSummary | null> {
    if (this.running) {
      return null;
    }
    if (!this.target.driveFolderId) {
      if (showNotice) new Notice(t("engineNoDriveFolder"));
      return null;
    }

    this.running = true;
    // Freeze the scope fields for the entire runtime (see `active`).
    this.active = {
      driveFolderId: this.target.driveFolderId,
      driveSharedId: this.target.driveSharedId,
      localFolder: this.target.localFolder,
      allowedExtensions: this.target.allowedExtensions,
      ignorePatterns: parseIgnorePatterns(this.target.ignorePatterns),
      excludeFolders: this.computeExcludeFolders(),
    };
    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: [],
    };

    this.status.start(t("statusSyncStarted"), Date.now());

    try {
      // Clear the folder cache per run (IDs may have changed externally).
      this.drive.clearFolderCache();

      this.status.update(t("engineReadingLocal"), 0);
      const local = await this.collectLocal();
      const localFolders = this.collectLocalFolders(local.keys());

      this.status.update(t("engineFetchingDrive"), 0);
      const listing = await this.drive.listFiles(
        this.active.driveFolderId,
        this.active.driveSharedId || undefined,
        ({ foldersScanned, filesFound }) => {
          // Reflect the recursive listing advancing (one update per folder
          // level) so a large Drive doesn't look frozen on "Fetching…".
          this.status.update(
            t("engineFetchingDriveProgress", {
              folders: foldersScanned,
              files: filesFound,
            }),
            0
          );
        }
      );
      log.info(
        `Drive listing done: ${listing.folders.length} folders, ${listing.files.length} files`
      );

      // Index files by vault-relative path.
      //
      // Drive allows MULTIPLE non-trashed files with the same name in the
      // same folder (different IDs). Mapped to the same vault-relative path
      // they would overwrite each other in a map — the
      // reconciler would see only one, and a deleteRemote/conflict might hit the
      // wrong ID. Therefore first GROUP by path, then resolve.
      const remoteByPath = new Map<string, DriveFile[]>();
      for (const f of listing.files) {
        // Google Editors files (Docs/Sheets/Slides) have no
        // downloadable binary content -> always skip.
        if (isGoogleAppsFile(f.mimeType)) continue;
        const path = normalizePath(this.drive.pathOf(f));
        // Never download system folders (config dir / .trash / …).
        if (isSystemPath(path, this.vault.configDir)) continue;
        // Optional file-extension filter (also applies to the Drive side).
        if (!this.extensionAllowed(path)) continue;
        // Ignore patterns (blacklist) — on both sides, see collectLocal().
        if (this.isIgnored(path)) continue;
        // Excluded folders (other targets' scopes + user excludeFolders).
        if (this.isExcluded(path)) continue;
        const list = remoteByPath.get(path);
        if (list) list.push(f);
        else remoteByPath.set(path, [f]);
      }

      // Resolve collisions: If ALL duplicates have IDENTICAL CONTENT (same,
      // present md5), the choice doesn't matter — we take a stable one (smallest
      // Drive ID) and sync normally. If the contents differ (or an md5 is
      // missing, so equality can't be proven), it's a real ambiguity:
      // skip the path ENTIRELY (both sides) instead of guessing a file.
      const remote = new Map<string, DriveFile>();
      for (const [path, dups] of remoteByPath) {
        if (dups.length === 1) {
          remote.set(path, dups[0]);
          continue;
        }
        const first = dups[0].md5Checksum;
        const allSameContent =
          !!first && dups.every((d) => d.md5Checksum === first);
        if (allSameContent) {
          // Identical content -> deterministically choose the smallest ID.
          const chosen = dups.reduce((a, b) => (a.id <= b.id ? a : b));
          remote.set(path, chosen);
          this.status.append(
            "info",
            t("engineDuplicateSameContent", { path })
          );
          continue;
        }
        // Real ambiguity: remove the path from reconciliation on both sides,
        // so it isn't treated as "only local → upload/delete".
        local.delete(path);
        const detail = t("engineDuplicateDifferent", { path });
        summary.errors.push(detail);
        this.status.append("error", detail);
        log.warn("Pfad-Kollision in Drive:", detail);
      }

      // Index Drive folders by path (system folders excluded).
      // Same collision logic as for files: duplicate folder names (same
      // path, different IDs) are skipped instead of choosing an ID —
      // a deleteRemoteFolder on the wrong ID would move an entire subtree
      // to the trash.
      const remoteFolders = new Map<string, string>();
      const collidingFolderPaths = new Set<string>();
      for (const folder of listing.folders) {
        const path = normalizePath(folder.relativePath);
        if (isSystemPath(path, this.vault.configDir)) continue;
        if (this.isIgnored(path)) continue;
        if (this.isExcluded(path)) continue;
        if (remoteFolders.has(path)) {
          collidingFolderPaths.add(path);
          continue;
        }
        remoteFolders.set(path, folder.id);
      }
      for (const path of collidingFolderPaths) {
        remoteFolders.delete(path);
        localFolders.delete(path);
        const detail = t("engineDuplicateFolder", { path });
        summary.errors.push(detail);
        this.status.append("error", detail);
        log.warn("Ordner-Pfad-Kollision in Drive:", detail);
      }

      this.status.append(
        "info",
        t("engineCountSummary", {
          localFiles: local.size,
          remoteFiles: remote.size,
          localFolders: localFolders.size,
          remoteFolders: remoteFolders.size,
        })
      );

      // Split the base into file and folder entries.
      const base = new Map<string, SyncStateEntry>();
      const folderBase = new Map<string, SyncStateEntry>();
      for (const e of this.state.all()) {
        if (e.isFolder) folderBase.set(e.path, e);
        else base.set(e.path, e);
      }

      const actions = reconcile({
        local,
        remote,
        base,
        neverDeleteRemote: this.target.neverDeleteRemote,
      });
      const folderActions = reconcileFolders({
        local: localFolders,
        remote: remoteFolders,
        base: folderBase,
        neverDeleteRemote: this.target.neverDeleteRemote,
      });

      // Only count "real" actions (noop not as a progress step).
      const work = actions.filter((a) => a.type !== "noop");
      this.status.setTotal(work.length);
      if (work.length === 0) {
        this.status.append("info", t("engineNoChanges"));
      }

      // 1) CREATE folders (before files, so target folders exist).
      //    Sorted by path depth: parent folders first.
      const folderCreates = folderActions
        .filter(
          (a) =>
            a.type === "createLocalFolder" || a.type === "createRemoteFolder"
        )
        .sort((a, b) => depth(a.path) - depth(b.path));
      for (const fa of folderCreates) {
        try {
          await this.applyFolderAction(fa, remoteFolders, summary);
        } catch (e) {
          const detail = t("engineActionError", {
            type: fa.type,
            path: fa.path,
            error: errMsg(e),
          });
          summary.errors.push(detail);
          this.status.append("error", detail);
          log.error("Ordner-Aktion fehlgeschlagen:", detail, e);
        }
      }

      // 2a) noop actions only refresh the base (no I/O) — handle them quickly
      //     and sequentially first.
      for (const action of actions) {
        if (action.type === "noop") {
          await this.applyAction(action, local, remote, summary);
        }
      }

      // 2b) Real file actions run through a bounded concurrency pool. File
      //     transfers are independent (distinct paths → distinct state keys), so
      //     parallel I/O is safe and dramatically faster on large vaults. The
      //     folder cache (Drive) and ensureParentDir (local) are parallel-safe.
      //     State is checkpointed every CHECKPOINT_EVERY completed actions so an
      //     interruption costs only the last few actions.
      let done = 0;
      let sinceCheckpoint = 0;
      await runPool(work, MAX_CONCURRENCY, async (action) => {
        try {
          await this.applyAction(action, local, remote, summary);
          this.status.append(
            "info",
            t("engineActionDone", { action: describeAction(action) })
          );
        } catch (e) {
          const detail = t("engineActionError", {
            type: action.type,
            path: pathOfAction(action),
            error: errMsg(e),
          });
          summary.errors.push(detail);
          this.status.append("error", detail);
          log.error("Aktion fehlgeschlagen:", detail, e);
        }
        // Progress + checkpoint after each completed action. The count is
        // placed at the FRONT of the line (right after the symbol) via
        // describeAction, so it reads "↓ (12/340) Download …".
        done++;
        this.status.update(
          describeAction(action, `(${done}/${work.length})`),
          done,
          work.length
        );
        if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
          sinceCheckpoint = 0;
          await this.checkpoint();
        }
      });

      // 3) DELETE / KEEP folders (after files; deepest first).
      //    keepRemoteFolder performs no Drive operation, only state — harmless in
      //    this phase and keeps the folder handling in one place.
      const folderDeletes = folderActions
        .filter(
          (a) =>
            a.type === "deleteLocalFolder" ||
            a.type === "deleteRemoteFolder" ||
            a.type === "keepRemoteFolder"
        )
        .sort((a, b) => depth(b.path) - depth(a.path));
      for (const fa of folderDeletes) {
        // SAFETY NET against subtree loss: `trashFolder` moves a
        // Drive folder INCLUDING ITS CONTENT to the trash. A deleteRemoteFolder
        // may therefore only run if no Drive file remains under this folder
        // in the current listing. If the local folder collection
        // wrongly reports "folder missing locally" (e.g. a transient cache glitch),
        // a populated remote subtree would otherwise be deleted.
        if (
          fa.type === "deleteRemoteFolder" &&
          this.remoteSubtreeHasFiles(fa.path, remote)
        ) {
          const detail = t("engineRemoteFolderNotDeleted", { path: fa.path });
          summary.errors.push(detail);
          this.status.append("error", detail);
          log.warn("deleteRemoteFolder übersprungen:", detail);
          continue;
        }
        try {
          await this.applyFolderAction(fa, remoteFolders, summary);
        } catch (e) {
          const detail = t("engineActionError", {
            type: fa.type,
            path: fa.path,
            error: errMsg(e),
          });
          summary.errors.push(detail);
          this.status.append("error", detail);
          log.error("Ordner-Aktion fehlgeschlagen:", detail, e);
        }
      }

      // 4) Refresh noopFolder entries in the state. Usually "both sides
      //    present" (local=remote=true). But a deliberately remote-only kept
      //    folder (keptRemoteOnly, not present locally) must be PRESERVED,
      //    otherwise it would be marked as two-sided and the folder would come
      //    back locally on the next run (zombie).
      for (const fa of folderActions) {
        if (fa.type !== "noopFolder") continue;
        const prev = this.state.get(fa.path);
        if (prev?.keptRemoteOnly && !localFolders.has(fa.path)) {
          // leave remote-only folder unchanged
          continue;
        }
        this.state.set(this.folderEntry(fa.path, remoteFolders.get(fa.path)));
      }

      this.state.setLastSyncMs(Date.now());
      // Persist the sync state in its own file (not data.json).
      await this.state.save();

      // Reset the flag BEFORE finish(): finish() fires the status subscription that
      // updates the sync button based on isRunning() — otherwise it would stay disabled.
      this.running = false;

      const finalMsg = summaryText(summary);
      this.status.finish(
        summary.errors.length ? "error" : "done",
        finalMsg
      );

      if (showNotice) {
        // On errors, show the notice longer so the details are readable.
        const duration = summary.errors.length ? 15000 : undefined;
        new Notice(formatSummary(summary), duration);
      }
      return summary;
    } catch (e) {
      this.running = false;
      const msg = t("engineSyncFailed", { error: errMsg(e) });
      summary.errors.push(msg);
      this.status.finish("error", msg);
      if (showNotice) new Notice(t("engineNoticePrefix", { message: msg }));
      return summary;
    } finally {
      // Safety net in case a path above did not reset the flag.
      this.running = false;
    }
  }

  /**
   * Checkpoints the sync state during a running sync. Deliberately does
   * NOT set `lastSyncMs` — the run only counts as finished at the end.
   * A checkpoint contains only entries of completed transfers and is
   * therefore always a consistent partial state. Write errors do not abort
   * the sync (log entry only).
   */
  private async checkpoint(): Promise<void> {
    try {
      await this.state.save();
    } catch (e) {
      log.error("Checkpoint-Speichern fehlgeschlagen:", e);
    }
  }

  /** Executes a single reconcile action and updates the base. */
  private async applyAction(
    action: SyncAction,
    local: Map<string, LocalFile>,
    remote: Map<string, DriveFile>,
    summary: SyncSummary
  ): Promise<void> {
    switch (action.type) {
      case "noop": {
        // Update the base so future runs are consistent.
        const l = local.get(action.path);
        const r = remote.get(action.path);
        const prev = this.state.get(action.path);
        if (l && r) {
          this.state.set(this.entryFrom(action.path, r, l));
        } else if (!l && r && prev?.keptRemoteOnly) {
          // "Deliberately remote-only" (keptRemoteOnly): PRESERVE the entry, so the
          // file is not downloaded as a new addition on the next run.
          // Refresh remoteMtime/md5 so a later Drive edit is recognized as
          // a change (-> then download).
          this.state.set({
            path: action.path,
            local: false,
            remote: true,
            keptRemoteOnly: true,
            isFolder: false,
            driveId: r.id,
            md5: r.md5Checksum ?? prev.md5,
            size: r.size ?? prev.size,
            localMtime: prev.localMtime,
            remoteMtime: r.modifiedTimeMs,
          });
        } else {
          this.state.delete(action.path);
        }
        return;
      }

      case "upload": {
        const l = local.get(action.path);
        if (!l) return;
        const content = await this.readLocal(action.path);
        const existing = remote.get(action.path);
        const uploaded = existing
          ? await this.drive.updateFile(existing.id, action.path, content)
          : await this.drive.createFile(
              this.active.driveFolderId,
              action.path,
              content,
              this.active.driveSharedId || undefined
            );
        this.state.set(this.entryFrom(action.path, uploaded, l));
        summary.uploaded++;
        return;
      }

      case "download": {
        const content = await this.drive.downloadFile(action.driveId);
        await this.writeLocal(action.path, content);
        const r = remote.get(action.path);
        const l = await this.freshLocal(action.path);
        if (r && l) this.state.set(this.entryFrom(action.path, r, l));
        summary.downloaded++;
        return;
      }

      case "deleteLocal": {
        await this.trashLocal(action.path);
        this.state.delete(action.path);
        summary.deletedLocal++;
        return;
      }

      case "deleteRemote": {
        await this.drive.trashFile(action.driveId);
        this.state.delete(action.path);
        summary.deletedRemote++;
        return;
      }

      case "keepRemoteDropLocal": {
        // Setting "Do not delete in Google Drive": do NOT touch the Drive file,
        // only set the base entry to remote-only. This way, on the next run the
        // file no longer counts as "deleted locally" (no deleteRemote) and
        // also not as "new in Drive" (no download zombie). Via the
        // "Drive only" tree local can be re-enabled (-> download).
        const prev = this.state.get(action.path);
        this.state.set({
          path: action.path,
          local: false,
          remote: true,
          keptRemoteOnly: true,
          isFolder: false,
          driveId: action.driveId,
          md5: prev?.md5 ?? "",
          size: prev?.size ?? 0,
          localMtime: prev?.localMtime ?? 0,
          remoteMtime: prev?.remoteMtime ?? 0,
        });
        return;
      }

      case "conflict": {
        summary.conflicts++;
        if (action.winner === "local") {
          const l = local.get(action.path);
          if (!l) return;
          const content = await this.readLocal(action.path);
          const uploaded = await this.drive.updateFile(
            action.driveId,
            action.path,
            content
          );
          this.state.set(this.entryFrom(action.path, uploaded, l));
          summary.uploaded++;
        } else {
          const content = await this.drive.downloadFile(action.driveId);
          await this.writeLocal(action.path, content);
          const r = remote.get(action.path);
          const l = await this.freshLocal(action.path);
          if (r && l) this.state.set(this.entryFrom(action.path, r, l));
          summary.downloaded++;
        }
        return;
      }
    }
  }

  // ---------- Local file helpers ----------

  /**
   * Collects hash/size/mtime of all files in the configured sync folder.
   *
   * PERFORMANCE (large vaults): Instead of fully reading and hashing every file
   * on EVERY run, the stored MD5 from the base is reused
   * if `mtime` AND `size` are unchanged (rsync/Syncthing principle). Only on
   * a mismatch (or a missing base) is the content read and re-hashed.
   * This way the second and every further sync is almost without hashing.
   */
  private async collectLocal(): Promise<Map<string, LocalFile>> {
    const result = new Map<string, LocalFile>();
    const prefix = this.folderPrefix();

    for (const file of this.vault.getFiles()) {
      if (!this.inScope(file.path)) continue;
      if (!this.extensionAllowed(file.path)) continue;
      const rel = this.toRelative(file.path, prefix);
      // Ignore patterns check the SYNC-RELATIVE path (like the Drive side).
      if (this.isIgnored(rel)) continue;
      // Excluded folders (other targets' scopes + user excludeFolders).
      if (this.isExcluded(rel)) continue;

      const mtimeMs = file.stat.mtime;
      const size = file.stat.size;

      // Hash cache: mtime+size unchanged vs. the base -> reuse the stored
      // MD5, do NOT read the file.
      const prev = this.state.get(rel);
      if (
        prev &&
        !prev.isFolder &&
        prev.localMtime === mtimeMs &&
        prev.size === size &&
        prev.md5
      ) {
        result.set(rel, { path: rel, md5: prev.md5, size, mtimeMs });
        continue;
      }

      // Changed / new / no cache -> read and hash the content.
      const content = await this.vault.adapter.readBinary(file.path);
      result.set(rel, {
        path: rel,
        md5: md5Hex(content),
        size: content.byteLength,
        mtimeMs,
      });
    }
    return result;
  }

  /**
   * Collects all local folders in scope (relative paths).
   *
   * Two sources, unioned:
   *  1. The parent-folder chain of EVERY collected file (`fileRelPaths`). This is
   *     the AUTHORITATIVE source: a folder that contains a synced file
   *     is guaranteed to exist. Without this derivation, a transient
   *     glitch of `getAllLoadedFiles()` could report a populated folder as "missing
   *     locally" → `deleteRemoteFolder` would move the entire Drive subtree to
   *     the trash (data loss).
   *  2. `getAllLoadedFiles()` (TFolder) — only needed to additionally capture EMPTY
   *     folders (which have no file to derive them from).
   *
   * System folders and the root itself are excluded.
   */
  private collectLocalFolders(fileRelPaths: Iterable<string>): Set<string> {
    const prefix = this.folderPrefix();
    const result = new Set<string>();

    // 1) Derive folders from the parent chains of the collected files.
    //    (fileRelPaths already contains only non-ignored files; a
    //    parent folder of an allowed file is deliberately NOT ignored.)
    for (const rel of fileRelPaths) {
      let idx = rel.lastIndexOf("/");
      while (idx > 0) {
        result.add(rel.slice(0, idx));
        idx = rel.lastIndexOf("/", idx - 1);
      }
    }

    // 2) Additionally include empty folders from the loaded vault tree.
    for (const f of this.vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder)) continue;
      if (f.isRoot()) continue;
      if (!this.inScope(f.path)) continue;
      const rel = this.toRelative(f.path, prefix);
      if (rel && !this.isIgnored(rel) && !this.isExcluded(rel)) result.add(rel);
    }
    return result;
  }

  /**
   * Is there still (at least) one file below the folder `folderPath` in the
   * current Drive listing? Serves as protection against trashing a populated
   * remote subtree (see the deleteRemoteFolder safety net).
   */
  private remoteSubtreeHasFiles(
    folderPath: string,
    remote: Map<string, DriveFile>
  ): boolean {
    const prefix = folderPath + "/";
    for (const path of remote.keys()) {
      if (path.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Executes a single folder action and maintains the state. */
  private async applyFolderAction(
    action: FolderAction,
    remoteFolders: Map<string, string>,
    summary: SyncSummary
  ): Promise<void> {
    switch (action.type) {
      case "createRemoteFolder": {
        const id = await this.drive.createFolderPath(
          this.active.driveFolderId,
          action.path,
          this.active.driveSharedId || undefined
        );
        remoteFolders.set(action.path, id);
        this.state.set(this.folderEntry(action.path, id));
        this.status.append(
          "info",
          `📁 ${t("engineRemoteFolderCreated", { path: action.path })}`
        );
        return;
      }
      case "createLocalFolder": {
        const abs = this.toAbsolute(action.path);
        if (!(await this.vault.adapter.exists(abs))) {
          await this.vault.adapter.mkdir(abs);
        }
        this.state.set(
          this.folderEntry(action.path, remoteFolders.get(action.path))
        );
        this.status.append(
          "info",
          `📁 ${t("engineLocalFolderCreated", { path: action.path })}`
        );
        return;
      }
      case "deleteRemoteFolder": {
        await this.drive.trashFolder(action.driveId);
        this.state.delete(action.path);
        this.status.append(
          "info",
          `🗑 ${t("engineRemoteFolderDeleted", { path: action.path })}`
        );
        return;
      }
      case "deleteLocalFolder": {
        const abs = this.toAbsolute(action.path);
        const folder = this.vault.getAbstractFileByPath(abs);
        if (folder instanceof TFolder) {
          // Respects the user's "Deleted files" preference.
          await this.trashFile(folder);
        } else if (await this.vault.adapter.exists(abs)) {
          await this.vault.adapter.trashLocal(abs);
        }
        this.state.delete(action.path);
        this.status.append(
          "info",
          `🗑 ${t("engineLocalFolderDeleted", { path: action.path })}`
        );
        return;
      }
      case "keepRemoteFolder": {
        // "Do not delete in Google Drive": do NOT touch the Drive folder, only
        // set the base entry to remote-only (keptRemoteOnly).
        this.state.set({
          path: action.path,
          local: false,
          remote: true,
          keptRemoteOnly: true,
          isFolder: true,
          driveId: action.driveId,
          md5: "",
          size: 0,
          localMtime: 0,
          remoteMtime: 0,
        });
        this.status.append(
          "info",
          `↛ ${t("engineFolderKeptRemote", { path: action.path })}`
        );
        return;
      }
      case "noopFolder":
        return;
    }
  }

  /** Builds a folder state entry (local & remote true, isFolder true). */
  private folderEntry(path: string, driveId?: string): SyncStateEntry {
    return {
      path,
      local: true,
      remote: true,
      isFolder: true,
      driveId: driveId ?? "",
      md5: "",
      size: 0,
      localMtime: 0,
      remoteMtime: 0,
    };
  }

  private async freshLocal(relPath: string): Promise<LocalFile | null> {
    const abs = this.toAbsolute(relPath);
    if (!(await this.vault.adapter.exists(abs))) return null;
    const content = await this.vault.adapter.readBinary(abs);
    const stat = await this.vault.adapter.stat(abs);
    return {
      path: relPath,
      md5: md5Hex(content),
      size: content.byteLength,
      mtimeMs: stat?.mtime ?? Date.now(),
    };
  }

  private async readLocal(relPath: string): Promise<ArrayBuffer> {
    return this.vault.adapter.readBinary(this.toAbsolute(relPath));
  }

  private async writeLocal(relPath: string, content: ArrayBuffer): Promise<void> {
    const abs = this.toAbsolute(relPath);
    await this.ensureParentDir(abs);
    await this.vault.adapter.writeBinary(abs, content);
  }

  /**
   * Moves a local file to the trash, respecting the user's deletion preference
   * (via `trashFile()` → `FileManager.trashFile()`). The adapter's
   * `trashLocal` fallback lands in the vault `.trash`.
   */
  private async trashLocal(relPath: string): Promise<void> {
    const abs = this.toAbsolute(relPath);
    const file = this.vault.getAbstractFileByPath(abs);
    if (file instanceof TFile) {
      await this.trashFile(file);
    } else if (await this.vault.adapter.exists(abs)) {
      await this.vault.adapter.trashLocal(abs);
    }
  }

  private async ensureParentDir(absPath: string): Promise<void> {
    const idx = absPath.lastIndexOf("/");
    if (idx <= 0) return;
    const dir = absPath.slice(0, idx);
    if (await this.vault.adapter.exists(dir)) return;
    try {
      await this.vault.adapter.mkdir(dir);
    } catch (e) {
      // Parallel-safe: with concurrent downloads two callers may race here and
      // both attempt mkdir. If the folder exists now, that's fine; otherwise
      // rethrow the real error.
      if (!(await this.vault.adapter.exists(dir))) throw e;
    }
  }

  // ---------- Path/scope helpers ----------

  /**
   * Checks whether the file extension is allowed per the filter. Empty filter =
   * everything allowed. Comparison is case-insensitive, without a leading dot.
   */
  private extensionAllowed(path: string): boolean {
    return extensionAllowed(path, this.active.allowedExtensions);
  }

  /**
   * Is the (sync-relative) path excluded by an ignore pattern? Applied
   * on BOTH sides (local + Drive, files + folders), so an
   * ignored file is not treated as "deleted on one side". Patterns are already
   * pre-parsed in `active.ignorePatterns`.
   */
  private isIgnored(path: string): boolean {
    return isIgnored(path, this.active.ignorePatterns);
  }

  /**
   * Combines the excluded folder prefixes for this run: the user's
   * `excludeFolders` plus the local folders of all OTHER targets, each
   * normalized to a sync-relative folder path (this target's prefix stripped).
   * A sibling folder outside this target's scope is dropped (it cannot collide).
   * Evaluated once per run and frozen into the snapshot.
   */
  private computeExcludeFolders(): string[] {
    const prefix = this.folderPrefix();
    const result = new Set<string>();

    const add = (vaultRel: string) => {
      const norm = normalizePath(vaultRel.trim());
      if (!norm) return;
      // Restrict to this target's scope: for a subfolder target keep only
      // siblings that live INSIDE this folder (strip the prefix). A whole-vault
      // target (empty prefix) keeps everything as-is.
      if (!prefix) {
        result.add(norm);
      } else if (norm === prefix.slice(0, -1) || norm.startsWith(prefix)) {
        const rel = this.toRelative(norm, prefix);
        if (rel) result.add(rel);
      }
    };

    for (const sib of this.siblingLocalFolders()) add(sib);
    // User-provided excludeFolders are already sync-relative to this target.
    for (const raw of this.target.excludeFolders.split(",")) {
      const norm = normalizePath(raw.trim());
      if (norm) result.add(norm);
    }
    return [...result];
  }

  /**
   * Is the sync-relative path under one of the excluded folders? Applied on
   * BOTH sides (local + Drive, files + folders), like `isIgnored`, so an
   * excluded path is never seen as "deleted on one side".
   */
  private isExcluded(path: string): boolean {
    for (const ex of this.active.excludeFolders) {
      if (path === ex || path.startsWith(ex + "/")) return true;
    }
    return false;
  }

  /** Folder prefix incl. trailing "/" ("" if whole vault). */
  private folderPrefix(): string {
    const f = this.active.localFolder.trim();
    if (!f) return "";
    const norm = normalizePath(f);
    return norm.endsWith("/") ? norm : norm + "/";
  }

  /** Is the vault path in the configured sync folder (and not in a system folder)? */
  private inScope(vaultPath: string): boolean {
    if (isSystemPath(vaultPath, this.vault.configDir)) return false;
    const prefix = this.folderPrefix();
    if (!prefix) return true; // whole vault
    return vaultPath === prefix.slice(0, -1) || vaultPath.startsWith(prefix);
  }

  /** Vault path -> sync-relative path (without folder prefix). */
  private toRelative(vaultPath: string, prefix: string): string {
    return prefix && vaultPath.startsWith(prefix)
      ? vaultPath.slice(prefix.length)
      : vaultPath;
  }

  /** Sync-relative path -> full vault path. */
  private toAbsolute(relPath: string): string {
    return normalizePath(this.folderPrefix() + relPath);
  }

  /**
   * Builds a state entry for a file that is currently present on BOTH sides
   * (after upload or download). Hence local=remote=true — that is
   * the precondition for a later deletion to be propagated at all.
   */
  private entryFrom(
    path: string,
    remote: DriveFile,
    local: LocalFile
  ): SyncStateEntry {
    return {
      path,
      local: true,
      remote: true,
      isFolder: false,
      driveId: remote.id,
      md5: remote.md5Checksum ?? local.md5,
      size: remote.size ?? local.size,
      localMtime: local.mtimeMs,
      remoteMtime: remote.modifiedTimeMs,
    };
  }
}

/** Path depth (number of "/" segments) — for folder sorting. */
function depth(path: string): number {
  return path.split("/").length;
}

/**
 * Runs `worker` over all `items` with at most `limit` concurrent executions.
 * Order of completion is not guaranteed; every item is processed exactly once.
 * A worker that throws is NOT caught here — callers handle per-item errors
 * inside the worker (as the engine does) so one failure doesn't stop the pool.
 */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        // Each runner pulls the next index until the queue is drained.
        while (next < items.length) {
          const idx = next++;
          await worker(items[idx]);
        }
      })()
    );
  }
  await Promise.all(runners);
}

function pathOfAction(a: SyncAction): string {
  return "path" in a ? a.path : "?";
}

/**
 * Human-readable description of an action for status/log.
 *
 * An optional `progress` fragment (e.g. "(12/340)") is inserted right after the
 * leading symbol, so the running count sits at the front of the line
 * (↓ (12/340) Download "…") instead of trailing behind the path.
 */
function describeAction(a: SyncAction, progress?: string): string {
  const p = pathOfAction(a);
  // Space-padded progress to slot between the symbol and the action text.
  const g = progress ? `${progress} ` : "";
  switch (a.type) {
    case "upload":
      return `↑ ${g}${t("uploadAction", { path: p })}`;
    case "download":
      return `↓ ${g}${t("downloadAction", { path: p })}`;
    case "deleteLocal":
      return `🗑 ${g}${t("deleteLocalAction", { path: p })}`;
    case "deleteRemote":
      return `🗑 ${g}${t("deleteRemoteAction", { path: p })}`;
    case "keepRemoteDropLocal":
      return `↛ ${g}${t("keepRemoteDropLocalAction", { path: p })}`;
    case "conflict":
      return `⚔ ${g}${t("conflictAction", {
        path: p,
        winner:
          a.winner === "local"
            ? t("conflictWinnerLocal")
            : t("conflictWinnerRemote"),
      })}`;
    default:
      return `${g}${p}`;
  }
}

/** Compact result line for the final status (without notice formatting). */
function summaryText(s: SyncSummary): string {
  const parts: string[] = [];
  if (s.uploaded) parts.push(t("summaryUploaded", { count: s.uploaded }));
  if (s.downloaded) parts.push(t("summaryDownloaded", { count: s.downloaded }));
  if (s.deletedRemote)
    parts.push(t("summaryDeletedRemote", { count: s.deletedRemote }));
  if (s.deletedLocal)
    parts.push(t("summaryDeletedLocal", { count: s.deletedLocal }));
  if (s.conflicts) parts.push(t("summaryConflicts", { count: s.conflicts }));
  const head = parts.length ? parts.join(", ") : t("summaryNoChanges");
  return s.errors.length
    ? t("summaryDoneWithErrors", { count: s.errors.length, head })
    : t("summaryDone", { head });
}

/**
 * Google Editors files (Docs, Sheets, Slides, Forms …) and folders have
 * an "application/vnd.google-apps.*" MIME type and no downloadable
 * binary content. Such files cannot be synced 1:1.
 */
function isGoogleAppsFile(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps");
}

/**
 * Paths in system folders that must never be synced — above all the
 * Obsidian config folder (plugins, themes, settings, our own sync state).
 * Especially relevant when syncing the whole vault. The config folder is not
 * necessarily `.obsidian`; `configDir` carries the vault's actual value
 * (`Vault#configDir`).
 */
export function isSystemPath(vaultPath: string, configDir: string): boolean {
  const p = vaultPath.startsWith("/") ? vaultPath.slice(1) : vaultPath;
  // Strip any leading "./" and trailing "/" from the configured folder.
  const cfg = configDir.replace(/^\.\//, "").replace(/\/+$/, "");
  return (
    p === cfg ||
    p.startsWith(`${cfg}/`) ||
    p === ".trash" ||
    p.startsWith(".trash/") ||
    p.split("/").pop() === ".DS_Store"
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatSummary(s: SyncSummary): string {
  const parts: string[] = [];
  if (s.uploaded) parts.push(`↑${s.uploaded}`);
  if (s.downloaded) parts.push(`↓${s.downloaded}`);
  if (s.deletedRemote)
    parts.push(`🗑${t("noticeDeletedRemote", { count: s.deletedRemote })}`);
  if (s.deletedLocal)
    parts.push(`🗑${t("noticeDeletedLocal", { count: s.deletedLocal })}`);
  if (s.conflicts) parts.push(`⚔${s.conflicts}`);
  const head = parts.length ? parts.join("  ") : t("summaryNoChanges");
  let errTail = "";
  if (s.errors.length) {
    // Show the first up to 3 error messages directly; count the rest.
    const shown = s.errors.slice(0, 3).map((e) => `• ${e}`).join("\n");
    const more =
      s.errors.length > 3
        ? t("noticeErrorMore", { count: s.errors.length - 3 })
        : "";
    errTail = t("noticeErrorTail", { count: s.errors.length, shown, more });
  }
  return t("noticeSummary", { head, errTail });
}
