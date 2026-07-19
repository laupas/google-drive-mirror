import { Notice, Platform, Plugin, TAbstractFile, normalizePath } from "obsidian";
import { GoogleDriveClient } from "./drive-client";
import { OAuthManager } from "./oauth";
import { SettingsTab } from "./settings-tab";
import { PluginStorage } from "./storage";
import { SyncEngine } from "./sync-engine";
import { SyncStateStore, isStateFile, stateFileName } from "./sync-state";
import { SyncStatus } from "./sync-status";
import {
  DEFAULT_SETTINGS,
  PluginSettings,
  SyncStateEntry,
  SyncTarget,
  newTarget,
} from "./types";
import { log, setDebugLogging } from "./logger";
import { initLocale, t } from "./i18n";
import { isIgnored, parseIgnorePatterns } from "./ignore";

/** Engine + state store pair for a single sync target. */
interface TargetRuntime {
  engine: SyncEngine;
  state: SyncStateStore;
}

/**
 * Plugin entry point. Wires up OAuth, Drive client and one sync engine PER
 * configured target, plus the auto-sync triggers (local vault events + Drive
 * poll interval). All targets share the same OAuth account and status/log, but
 * keep independent sync bases (one `sync-state-<id>.json` each).
 */
export default class GoogleDriveSyncPlugin extends Plugin {
  settings!: PluginSettings;
  oauth!: OAuthManager;
  drive!: GoogleDriveClient;
  status!: SyncStatus;
  private storage!: PluginStorage;

  /** One engine + state store per target id. Rebuilt when targets change. */
  private runtimes = new Map<string, TargetRuntime>();
  /** True while a (multi-target) sync run is in progress. */
  private running = false;

  private pollHandle: number | null = null;
  private debounceHandle: number | null = null;
  private statusBarEl: HTMLElement | null = null;
  /** Paths written by the sync itself — ignore their events. */
  private suppressedPaths = new Set<string>();

  async onload(): Promise<void> {
    // Couple the UI language to the Obsidian setting (fallback English).
    initLocale();
    await this.loadSettings();
    setDebugLogging(this.settings.debugLogging);

    this.oauth = new OAuthManager(this.settings);
    this.drive = new GoogleDriveClient(this.oauth);

    // Mobile login redirect: Obsidian delivers obsidian://gdrive-auth back to
    // the plugin here (mobile can't run the desktop loopback server).
    this.registerObsidianProtocolHandler("gdrive-auth", (params) => {
      this.oauth.handleMobileRedirect(params);
    });

    this.storage = new PluginStorage(this.app.vault, this.manifest.id);

    // Load log from its own file; retention duration from settings.
    this.status = new SyncStatus(
      this.storage,
      () => this.settings.logRetentionHours
    );
    await this.status.load();

    // Build one engine + state store per configured target.
    await this.rebuildRuntimes();
    // Remove state files of targets that no longer exist (data hygiene).
    await this.cleanupOrphanStateFiles();

    this.addSettingTab(new SettingsTab(this.app, this));

    // Status bar: shows live progress of the sync.
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gds-statusbar");
    this.statusBarEl.onClickEvent(() => void this.runSync(true));
    this.status.subscribe(() => this.renderStatusBar());
    this.renderStatusBar();

    // Ribbon icon for quick manual sync.
    this.addRibbonIcon("refresh-cw", t("ribbonSyncTooltip"), () => {
      void this.runSync(true);
    });

    // Commands.
    this.addCommand({
      id: "sync-now",
      name: t("commandSyncNow"),
      callback: () => void this.runSync(true),
    });
    this.addCommand({
      id: "login",
      name: t("commandLogin"),
      callback: () => void this.login(),
    });

    // Watch local changes (only relevant when auto-sync is active).
    this.registerEvent(
      this.app.vault.on("modify", (f) => this.onLocalChange(f))
    );
    this.registerEvent(
      this.app.vault.on("create", (f) => this.onLocalChange(f))
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.onLocalChange(f))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f) => this.onLocalChange(f))
    );

    // Sync once at startup (fetches Drive changes), if configured.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSyncEnabled && this.oauth.isConfigured()) {
        void this.runSync(false);
      }
      this.reconfigureAutoSync();
    });
  }

  onunload(): void {
    this.clearTimers();
  }

  // ---------- Target runtimes ----------

  /**
   * (Re)builds the engine + state store for every configured target. Each state
   * store binds to its own file and its own scope id (target id + Drive folder +
   * local folder). Called on load and whenever the target list changes.
   */
  async rebuildRuntimes(): Promise<void> {
    // Preserve stores of targets that still exist so their in-memory base isn't
    // dropped needlessly (avoids a redundant reload) — but a scope change is
    // handled explicitly via resetTargetBase(), so a plain rebuild reuses them.
    const next = new Map<string, TargetRuntime>();
    for (const target of this.settings.targets) {
      const existing = this.runtimes.get(target.id);
      if (existing) {
        next.set(target.id, existing);
        continue;
      }
      const state = new SyncStateStore(
        this.storage,
        () => this.scopeId(target),
        stateFileName(target.id)
      );
      await state.load();
      const engine = new SyncEngine(
        this.app.vault,
        this.drive,
        state,
        target,
        this.status,
        this.app.fileManager,
        () => this.siblingLocalFolders(target.id)
      );
      next.set(target.id, { engine, state });
    }
    this.runtimes = next;
  }

  /**
   * Local folders (vault-relative) of all targets EXCEPT `exceptId`. A target
   * uses these to exclude other targets' scopes from its own sync — so a
   * subfolder owned by one target is never mirrored into a second Drive by a
   * whole-vault target. Empty local folders (whole-vault targets) contribute
   * nothing, as there is no specific subfolder to exclude.
   */
  private siblingLocalFolders(exceptId: string): string[] {
    return this.settings.targets
      .filter((tg) => tg.id !== exceptId && tg.localFolder.trim() !== "")
      .map((tg) => tg.localFolder.trim());
  }

  /** Deletes `sync-state-*.json` files that don't belong to a current target. */
  private async cleanupOrphanStateFiles(): Promise<void> {
    const valid = new Set(
      this.settings.targets.map((tg) => stateFileName(tg.id))
    );
    const files = await this.storage.listFileNames();
    for (const name of files) {
      if (isStateFile(name) && !valid.has(name)) {
        await this.storage.remove(name);
        log.info("Verwaiste Sync-State-Datei entfernt:", name);
      }
    }
  }

  // ---------- Sync triggers ----------

  /**
   * Manual/explicit sync. Runs every configured target SEQUENTIALLY (parallel
   * targets would fight over event suppression and Drive rate limits). The
   * shared `running` flag serializes overlapping calls.
   */
  async runSync(showNotice: boolean): Promise<void> {
    if (this.running) {
      if (showNotice) new Notice(t("noticeSyncAlreadyRunning"));
      return;
    }
    if (!this.oauth.isConfigured()) {
      if (showNotice) new Notice(t("noticeSignInFirst"));
      return;
    }
    const targets = this.settings.targets.filter((tg) => tg.driveFolderId);
    if (targets.length === 0) {
      if (showNotice) new Notice(t("noticeNoTargets"));
      return;
    }

    this.running = true;
    // Lightweight ticker so the elapsed time keeps updating even without new events.
    const ticker = window.setInterval(() => this.status.touch(), 1000);
    try {
      await this.withSuppressedEvents(async () => {
        for (const target of targets) {
          const rt = this.runtimes.get(target.id);
          if (!rt) continue;
          await rt.engine.sync(showNotice);
        }
      });
    } finally {
      this.running = false;
      window.clearInterval(ticker);
    }
  }

  /** Is a sync currently running? (for the UI). */
  isSyncing(): boolean {
    return this.running;
  }

  /** Updates the status bar based on the current sync status. */
  private renderStatusBar(): void {
    if (!this.statusBarEl) return;
    const p = this.status.getProgress();
    let icon = "🔄";
    let text = t("statusBarReady");
    switch (p.phase) {
      case "running": {
        icon = "⏳";
        const progress =
          p.total > 0
            ? t("statusBarRunningProgress", {
                current: p.current,
                total: p.total,
              })
            : "";
        text = t("statusBarRunning", { progress, message: p.message });
        break;
      }
      case "done":
        icon = "✅";
        text = t("statusBarDone", { message: p.message });
        break;
      case "error":
        icon = "⚠️";
        text = t("statusBarError", { message: p.message });
        break;
    }
    this.statusBarEl.setText(`${icon} ${text}`);
    this.statusBarEl.title = t("statusBarTooltip");
  }

  /** Reacts to local vault changes (debounced upload sync). */
  private onLocalChange(file: TAbstractFile): void {
    if (!this.settings.autoSyncEnabled) return;
    if (!this.oauth.isConfigured()) return;
    // TAbstractFile (file OR folder) always has a path; anything without a path
    // is not a sync-relevant object. The actual scope filtering is done by
    // isInScope() further below (folders may trigger a sync).
    if (!file || !file.path) return;
    if (this.suppressedPaths.has(file.path)) return;
    if (!this.isInScope(file.path)) return;

    if (this.debounceHandle !== null) window.clearTimeout(this.debounceHandle);
    this.debounceHandle = window.setTimeout(() => {
      this.debounceHandle = null;
      void this.runSync(false);
    }, this.settings.localDebounceMs);
  }

  /** (Re-)configures the Drive poll timer according to the settings. */
  reconfigureAutoSync(): void {
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (!this.settings.autoSyncEnabled) return;

    const intervalMs = Math.max(15, this.settings.pollIntervalSeconds) * 1000;
    this.pollHandle = window.setInterval(() => {
      if (this.oauth.isConfigured() && !this.running) {
        void this.runSync(false);
      }
    }, intervalMs);
    this.registerInterval(this.pollHandle);
  }

  /** Interactive Google login. */
  async login(): Promise<void> {
    // Open the consent page in the SYSTEM browser. On desktop this ensures the
    // loopback redirect lands at the local server (not an Electron popup); on
    // mobile the browser redirects to obsidian://gdrive-auth back into the app.
    await this.oauth.openLogin((url) => openExternal(url));
    await this.saveSettings();
    log.info(
      "Login abgeschlossen, refreshToken gesetzt:",
      Boolean(this.settings.refreshToken)
    );
    new Notice(t("noticeLoginSuccess"));
  }

  // ---------- Target management (from the settings UI) ----------

  /** All configured targets. */
  getTargets(): SyncTarget[] {
    return this.settings.targets;
  }

  /** Adds a new empty target, persists and rebuilds the runtimes. */
  async addTarget(): Promise<SyncTarget> {
    const id = generateTargetId();
    const name = t("targetDefaultName", {
      index: this.settings.targets.length + 1,
    });
    const target = newTarget(id, name);
    this.settings.targets.push(target);
    await this.saveSettings();
    await this.rebuildRuntimes();
    return target;
  }

  /**
   * Removes a target: drops its runtime, deletes its state file and persists.
   * The files themselves are untouched (only the sync base is discarded).
   */
  async removeTarget(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (rt) {
      await rt.state.destroy();
      this.runtimes.delete(id);
    }
    this.settings.targets = this.settings.targets.filter((tg) => tg.id !== id);
    await this.saveSettings();
    await this.rebuildRuntimes();
  }

  /** Persists after a target field changed (no scope reset). */
  async updateTarget(id: string, patch: Partial<SyncTarget>): Promise<void> {
    const target = this.settings.targets.find((tg) => tg.id === id);
    if (!target) return;
    Object.assign(target, patch);
    await this.saveSettings();
  }

  /**
   * Sets the Drive root folder for a target. If the folder ID changes, the
   * target's sync base is reset — otherwise the reconciler would compare the
   * files of the NEW folder against the base of the OLD folder.
   */
  async setDriveFolderForTarget(
    id: string,
    driveId: string,
    name: string,
    sharedId: string
  ): Promise<void> {
    const target = this.settings.targets.find((tg) => tg.id === id);
    if (!target) return;
    const changed = target.driveFolderId !== driveId;
    target.driveFolderId = driveId;
    target.driveFolderName = name;
    target.driveSharedId = sharedId;
    await this.saveSettings();
    if (changed) {
      await this.resetTargetBase(id);
      log.debug("Drive-Ordner gewechselt -> Sync-Base zurückgesetzt.");
    }
  }

  /**
   * Sets the local sync folder for a target ("" = whole vault). If the scope
   * changes, the target's sync base is reset (analogous to the Drive folder).
   *
   * Only ONE target may sync the whole vault (`folder === ""`) — otherwise the
   * same files would be mirrored into two Drives (whole-vault targets don't
   * exclude each other, since neither owns a specific subfolder). Setting a
   * second target to whole-vault is refused and returns false.
   */
  async setLocalFolderForTarget(id: string, folder: string): Promise<boolean> {
    const target = this.settings.targets.find((tg) => tg.id === id);
    if (!target) return false;
    // Guard: reject a second whole-vault target.
    if (folder === "") {
      const other = this.wholeVaultTargetId();
      if (other && other !== id) return false;
    }
    const changed = target.localFolder !== folder;
    target.localFolder = folder;
    await this.saveSettings();
    if (changed) {
      await this.resetTargetBase(id);
      log.debug("Lokaler Scope gewechselt -> Sync-Base zurückgesetzt.");
    }
    return true;
  }

  /**
   * Id of the target that syncs the whole vault (`localFolder === ""` with a
   * Drive folder configured), or null. Used to enforce "only one whole-vault
   * target" in the settings UI.
   */
  wholeVaultTargetId(): string | null {
    const target = this.settings.targets.find(
      (tg) => tg.localFolder.trim() === ""
    );
    return target ? target.id : null;
  }

  /** Clears the sync history of one target (not the files) and persists. */
  async resetTargetBase(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.state.clear();
    await rt.state.save();
  }

  /** Clears the sync history of ALL targets. */
  async resetAllBases(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      rt.state.clear();
      await rt.state.save();
    }
  }

  /** Most recent successful sync across all targets (ms; 0 = never). */
  getLastSyncMs(): number {
    let max = 0;
    for (const rt of this.runtimes.values()) {
      max = Math.max(max, rt.state.getLastSyncMs());
    }
    return max;
  }

  /** Sync-state entries of one target (for its sync tree in the settings). */
  getSyncEntries(id: string): SyncStateEntry[] {
    return this.runtimes.get(id)?.state.all() ?? [];
  }

  /**
   * Marks a "Drive-only" entry (file OR folder) of a target for restoration:
   * removes the keptRemoteOnly flag so it is downloaded/created locally on the
   * next sync. Persists immediately.
   */
  async restoreRemoteOnly(id: string, path: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const entry = rt.state.get(path);
    if (!entry || !entry.keptRemoteOnly) return;
    rt.state.set({ ...entry, keptRemoteOnly: false });
    await rt.state.save();
  }

  /**
   * Unique identity of vault + Drive folder + local scope for a target. Binds
   * the sync base to exactly this combination, so a base copied from another
   * vault is detected and discarded. The target id keeps the scope unique even
   * if two targets happen to share the same Drive/local folder.
   */
  private scopeId(target: SyncTarget): string {
    const vault = this.app.vault.getName();
    const drive = target.driveFolderId || "-";
    const local = target.localFolder || "<vault>";
    return `${vault}::${target.id}::${drive}::${local}`;
  }

  // ---------- Event suppression during sync writes ----------

  /**
   * While the sync itself writes files, the modify/create/delete events it
   * triggers must not start another sync. We briefly mark all paths currently
   * in scope as suppressed.
   */
  private async withSuppressedEvents(fn: () => Promise<void>): Promise<void> {
    // Coarse but robust strategy: ignore all scope paths during the run;
    // release them again after a short delay.
    const snapshot = this.app.vault
      .getFiles()
      .map((f) => f.path)
      .filter((p) => this.isInScope(p));
    snapshot.forEach((p) => this.suppressedPaths.add(p));
    try {
      await fn();
    } finally {
      // Delayed release so trailing events are still filtered.
      window.setTimeout(() => this.suppressedPaths.clear(), 1500);
    }
  }

  /**
   * Does the vault path fall into ANY configured target's scope (and is not
   * ignored/excluded there)? Used to decide whether a local change should
   * trigger an auto-sync.
   */
  private isInScope(vaultPath: string): boolean {
    // Never sync system folders (especially for the whole vault). The config
    // folder is not necessarily ".obsidian" — use Vault#configDir.
    const p = vaultPath.startsWith("/") ? vaultPath.slice(1) : vaultPath;
    const cfg = this.app.vault.configDir.replace(/^\.\//, "").replace(/\/+$/, "");
    if (p === cfg || p.startsWith(`${cfg}/`)) return false;
    if (p === ".trash" || p.startsWith(".trash/")) return false;

    return this.settings.targets.some((target) =>
      this.inTargetScope(target, vaultPath, p)
    );
  }

  /** Scope check for a single target (folder prefix + ignore + exclude). */
  private inTargetScope(
    target: SyncTarget,
    vaultPath: string,
    stripped: string
  ): boolean {
    const f = target.localFolder.trim();
    let rel = stripped;
    if (f) {
      const norm = normalizePath(f);
      const prefix = norm + "/";
      if (vaultPath !== norm && !vaultPath.startsWith(prefix)) return false;
      rel = vaultPath === norm ? "" : vaultPath.slice(prefix.length);
    }
    if (!rel) return true;

    // Ignore patterns (blacklist) on the sync-relative path.
    const patterns = parseIgnorePatterns(target.ignorePatterns);
    if (isIgnored(rel, patterns)) return false;

    // Excluded folders: other targets' scopes + this target's excludeFolders.
    for (const ex of this.excludeFoldersFor(target)) {
      if (rel === ex || rel.startsWith(ex + "/")) return false;
    }
    return true;
  }

  /**
   * Sync-relative excluded folder prefixes for a target (siblings' local
   * folders + user excludeFolders), mirroring the engine's computeExcludeFolders
   * for the auto-sync scope check. For a whole-vault target the prefix is empty,
   * so sibling folders map 1:1.
   */
  private excludeFoldersFor(target: SyncTarget): string[] {
    const result = new Set<string>();
    const f = target.localFolder.trim();
    const prefix = f ? normalizePath(f) + "/" : "";

    for (const sib of this.siblingLocalFolders(target.id)) {
      const norm = normalizePath(sib);
      if (!prefix) {
        result.add(norm);
      } else if (norm === prefix.slice(0, -1) || norm.startsWith(prefix)) {
        const rel = norm.slice(prefix.length);
        if (rel) result.add(rel);
      }
    }
    for (const raw of target.excludeFolders.split(",")) {
      const norm = normalizePath(raw.trim());
      if (norm) result.add(norm);
    }
    return [...result];
  }

  private clearTimers(): void {
    if (this.pollHandle !== null) window.clearInterval(this.pollHandle);
    if (this.debounceHandle !== null) window.clearTimeout(this.debounceHandle);
    this.pollHandle = null;
    this.debounceHandle = null;
  }

  // ---------- Persistence ----------

  /**
   * Loads the settings from data.json. Legacy single-target fields (from
   * versions before the multi-target model) are dropped — the user reconfigures
   * targets; the reconciler's deletion safety means a fresh base never deletes.
   */
  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as RawData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
    // Ensure `targets` is always an array (older data.json has no such field).
    if (!Array.isArray(this.settings.targets)) this.settings.targets = [];
    // Strip legacy fields so they don't get written back into data.json.
    stripLegacyFields(this.settings as unknown as Record<string, unknown>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/**
 * Opens an external URL in the SYSTEM browser, cross-platform.
 *
 * `window.open(url, "_blank")` opens the system browser on desktop (Electron),
 * but on mobile (iOS especially) it's a no-op inside Obsidian's WebView, which
 * left login hanging forever. On mobile we click a real anchor with
 * `target="_blank"` — Obsidian's mobile shell intercepts that and hands the URL
 * to the OS browser, from which Google can redirect back via obsidian://.
 */
function openExternal(url: string): void {
  if (Platform.isDesktopApp) {
    window.open(url, "_blank");
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Generates a short, collision-resistant target id (no crypto dependency). */
function generateTargetId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${time}${rand}`;
}

/** Removes fields from earlier plugin versions that no longer belong here. */
function stripLegacyFields(obj: Record<string, unknown>): void {
  for (const key of [
    "driveFolderId",
    "driveFolderName",
    "driveSharedId",
    "localFolder",
    "allowedExtensions",
    "ignorePatterns",
    "neverDeleteRemote",
    "syncState",
    "lastSyncMs",
  ]) {
    delete obj[key];
  }
}

/** Raw form of data.json including any old, migrated fields. */
interface RawData extends Partial<PluginSettings> {
  syncState?: Record<string, SyncStateEntry>;
  lastSyncMs?: number;
}
