import { Notice, Plugin, TAbstractFile, normalizePath } from "obsidian";
import { GoogleDriveClient } from "./drive-client";
import { OAuthManager } from "./oauth";
import { SettingsTab } from "./settings-tab";
import { PluginStorage } from "./storage";
import { SyncEngine } from "./sync-engine";
import { SyncStateStore } from "./sync-state";
import { SyncStatus } from "./sync-status";
import { DEFAULT_SETTINGS, PluginSettings, SyncStateEntry } from "./types";
import { log, setDebugLogging } from "./logger";
import { initLocale, t } from "./i18n";
import { isIgnored, parseIgnorePatterns } from "./ignore";

/**
 * Plugin entry point. Wires up OAuth, Drive client, sync engine
 * and the auto-sync triggers (local vault events + Drive poll interval).
 */
export default class GoogleDriveSyncPlugin extends Plugin {
  settings!: PluginSettings;
  oauth!: OAuthManager;
  drive!: GoogleDriveClient;
  status!: SyncStatus;
  private engine!: SyncEngine;
  private state!: SyncStateStore;
  private storage!: PluginStorage;

  private pollHandle: number | null = null;
  private debounceHandle: number | null = null;
  private statusBarEl: HTMLElement | null = null;
  /** Paths written by the sync itself — ignore their events. */
  private suppressedPaths = new Set<string>();

  async onload(): Promise<void> {
    // Couple the UI language to the Obsidian setting (fallback English).
    initLocale();
    const raw = await this.loadSettings();
    setDebugLogging(this.settings.debugLogging);

    this.oauth = new OAuthManager(this.settings);
    this.drive = new GoogleDriveClient(this.oauth);

    this.storage = new PluginStorage(this.app.vault, this.manifest.id);

    // Load sync state from its own file; migrate from old data.json if needed.
    // The scope ID binds the base to vault + Drive folder. If the
    // sync-state.json is copied from another vault, it won't match and the
    // base is discarded (instead of wrongly deleting everything).
    this.state = new SyncStateStore(this.storage, () => this.scopeId());
    await this.state.load(
      raw && raw.syncState
        ? { entries: raw.syncState, lastSyncMs: raw.lastSyncMs ?? 0 }
        : undefined
    );

    // Load log from its own file; retention duration from settings.
    this.status = new SyncStatus(
      this.storage,
      () => this.settings.logRetentionHours
    );
    await this.status.load();

    this.engine = new SyncEngine(
      this.app.vault,
      this.drive,
      this.state,
      this.settings,
      this.status
    );

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

  // ---------- Sync triggers ----------

  /** Manual/explicit sync. */
  async runSync(showNotice: boolean): Promise<void> {
    if (this.engine.isRunning()) {
      if (showNotice) new Notice(t("noticeSyncAlreadyRunning"));
      return;
    }
    if (!this.oauth.isConfigured()) {
      if (showNotice) {
        new Notice(t("noticeSignInFirst"));
      }
      return;
    }
    // Lightweight ticker so the elapsed time keeps updating even without new events.
    const ticker = window.setInterval(() => this.status.touch(), 1000);
    try {
      await this.withSuppressedEvents(async () => {
        await this.engine.sync(showNotice);
      });
    } finally {
      window.clearInterval(ticker);
    }
  }

  /** Is a sync currently running? (for the UI). */
  isSyncing(): boolean {
    return this.engine.isRunning();
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
      if (this.oauth.isConfigured() && !this.engine.isRunning()) {
        void this.runSync(false);
      }
    }, intervalMs);
    this.registerInterval(this.pollHandle);
  }

  /** Interactive Google login. */
  async login(): Promise<void> {
    // Explicitly open the system browser (not an Electron popup) so the
    // loopback redirect reliably lands at the local server.
    await this.oauth.openLogin((url) => {
      window.open(url, "_blank");
    });
    await this.saveSettings();
    log.info(
      "Login abgeschlossen, refreshToken gesetzt:",
      Boolean(this.settings.refreshToken)
    );
    new Notice(t("noticeLoginSuccess"));
  }

  /**
   * Sets the Drive root folder. If the folder ID changes from the previous
   * one, the sync base is cleared — otherwise the reconciler would compare the
   * files of the NEW folder against the base of the OLD folder and e.g. treat
   * local files wrongly as "deleted remotely".
   */
  async setDriveFolder(id: string, name: string, sharedId: string): Promise<void> {
    const changed = this.settings.driveFolderId !== id;
    this.settings.driveFolderId = id;
    this.settings.driveFolderName = name;
    this.settings.driveSharedId = sharedId;
    if (changed) {
      await this.resetSyncBase();
      log.debug("Drive-Ordner gewechselt -> Sync-Base zurückgesetzt.");
    }
    await this.saveSettings();
  }

  /**
   * Sets the local sync folder ("" = whole vault). If the scope changes, the
   * sync base is cleared (analogous to changing the Drive folder), so the
   * reconciler doesn't compare files of a different scope against the old base.
   */
  async setLocalFolder(folder: string): Promise<void> {
    const changed = this.settings.localFolder !== folder;
    this.settings.localFolder = folder;
    if (changed) {
      await this.resetSyncBase();
      log.debug("Lokaler Scope gewechselt -> Sync-Base zurückgesetzt.");
    }
    await this.saveSettings();
  }

  /** Clears the sync history (not the files) and persists. */
  async resetSyncBase(): Promise<void> {
    this.state.clear();
    await this.state.save();
  }

  /** Timestamp of the last successful sync (ms; 0 = never). */
  getLastSyncMs(): number {
    return this.state.getLastSyncMs();
  }

  /** All sync-state entries (for the sync tree in the settings). */
  getSyncEntries(): SyncStateEntry[] {
    return this.state.all();
  }

  /**
   * Marks a "Drive-only" entry (file OR folder) for restoration: removes the
   * keptRemoteOnly flag so it is downloaded/created locally on the next sync.
   * Persists immediately.
   */
  async restoreRemoteOnly(path: string): Promise<void> {
    const entry = this.state.get(path);
    if (!entry || !entry.keptRemoteOnly) return;
    this.state.set({ ...entry, keptRemoteOnly: false });
    await this.state.save();
  }

  /**
   * Unique identity of vault + Drive folder + local scope. Binds the sync base
   * to exactly this combination, so a base copied from another vault is
   * detected and discarded.
   */
  private scopeId(): string {
    const vault = this.app.vault.getName();
    const drive = this.settings.driveFolderId || "-";
    const local = this.settings.localFolder || "<vault>";
    return `${vault}::${drive}::${local}`;
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

  private isInScope(vaultPath: string): boolean {
    // Never sync system folders (especially for the whole vault).
    const p = vaultPath.startsWith("/") ? vaultPath.slice(1) : vaultPath;
    if (p === ".obsidian" || p.startsWith(".obsidian/")) return false;
    if (p === ".trash" || p.startsWith(".trash/")) return false;

    const f = this.settings.localFolder.trim();
    let rel = p;
    if (f) {
      const norm = normalizePath(f);
      const prefix = norm + "/";
      if (vaultPath !== norm && !vaultPath.startsWith(prefix)) return false;
      rel = vaultPath === norm ? "" : vaultPath.slice(prefix.length);
    }

    // Apply ignore patterns (blacklist) to the sync-relative path — analogous
    // to the engine, so an ignored file doesn't trigger an auto-sync.
    const patterns = parseIgnorePatterns(this.settings.ignorePatterns);
    if (rel && isIgnored(rel, patterns)) return false;

    return true;
  }

  private clearTimers(): void {
    if (this.pollHandle !== null) window.clearInterval(this.pollHandle);
    if (this.debounceHandle !== null) window.clearTimeout(this.debounceHandle);
    this.pollHandle = null;
    this.debounceHandle = null;
  }

  // ---------- Persistence ----------

  /**
   * Loads the settings from data.json. Returns the RAW data so onload() can
   * migrate any old sync state (from earlier versions) still sitting there
   * into its own sync-state.json.
   */
  async loadSettings(): Promise<RawData | null> {
    const raw = (await this.loadData()) as RawData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
    // Legacy fields are no longer part of the settings -> remove them from the
    // object so they don't land in data.json again on the next saveData.
    delete (this.settings as Partial<RawData>).syncState;
    delete (this.settings as Partial<RawData>).lastSyncMs;
    return raw;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** Raw form of data.json including any old, migrated fields. */
interface RawData extends Partial<PluginSettings> {
  syncState?: Record<string, SyncStateEntry>;
  lastSyncMs?: number;
}
