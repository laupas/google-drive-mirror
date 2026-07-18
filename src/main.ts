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
 * Einstiegspunkt des Plugins. Verdrahtet OAuth, Drive-Client, Sync-Engine
 * und die Auto-Sync-Trigger (lokale Vault-Events + Drive-Poll-Intervall).
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
  /** Pfade, die durch den Sync selbst geschrieben wurden — Events ignorieren. */
  private suppressedPaths = new Set<string>();

  async onload(): Promise<void> {
    // UI-Sprache an die Obsidian-Einstellung koppeln (Fallback Englisch).
    initLocale();
    const raw = await this.loadSettings();
    setDebugLogging(this.settings.debugLogging);

    this.oauth = new OAuthManager(this.settings);
    this.drive = new GoogleDriveClient(this.oauth);

    this.storage = new PluginStorage(this.app.vault, this.manifest.id);

    // Sync-State aus eigener Datei laden; ggf. aus altem data.json migrieren.
    // Die Scope-ID bindet die Base an Vault + Drive-Ordner. Wird die
    // sync-state.json aus einem anderen Vault kopiert, passt sie nicht und die
    // Base wird verworfen (statt fälschlich alles zu löschen).
    this.state = new SyncStateStore(this.storage, () => this.scopeId());
    await this.state.load(
      raw && raw.syncState
        ? { entries: raw.syncState, lastSyncMs: raw.lastSyncMs ?? 0 }
        : undefined
    );

    // Log aus eigener Datei laden; Retention-Dauer aus Settings.
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

    // Statusleiste: zeigt Live-Fortschritt des Syncs.
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gds-statusbar");
    this.statusBarEl.onClickEvent(() => void this.runSync(true));
    this.status.subscribe(() => this.renderStatusBar());
    this.renderStatusBar();

    // Ribbon-Icon für schnellen manuellen Sync.
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

    // Lokale Änderungen beobachten (nur bei aktivem Auto-Sync relevant).
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

    // Beim Start einmal syncen (holt Drive-Änderungen), wenn konfiguriert.
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

  // ---------- Sync-Auslöser ----------

  /** Manueller/expliziter Sync. */
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
    // Leichter Ticker, damit die verstrichene Zeit auch ohne neue Events tickt.
    const ticker = window.setInterval(() => this.status.touch(), 1000);
    try {
      await this.withSuppressedEvents(async () => {
        await this.engine.sync(showNotice);
      });
    } finally {
      window.clearInterval(ticker);
    }
  }

  /** Läuft gerade ein Sync? (für die UI). */
  isSyncing(): boolean {
    return this.engine.isRunning();
  }

  /** Aktualisiert die Statusleiste anhand des aktuellen Sync-Status. */
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

  /** Reagiert auf lokale Vault-Änderungen (debounced Upload-Sync). */
  private onLocalChange(file: TAbstractFile): void {
    if (!this.settings.autoSyncEnabled) return;
    if (!this.oauth.isConfigured()) return;
    // TAbstractFile (Datei ODER Ordner) hat immer einen Pfad; alles ohne Pfad
    // ist kein sync-relevantes Objekt. Das eigentliche Scope-Filtern macht
    // isInScope() weiter unten (Ordner dürfen einen Sync auslösen).
    if (!file || !file.path) return;
    if (this.suppressedPaths.has(file.path)) return;
    if (!this.isInScope(file.path)) return;

    if (this.debounceHandle !== null) window.clearTimeout(this.debounceHandle);
    this.debounceHandle = window.setTimeout(() => {
      this.debounceHandle = null;
      void this.runSync(false);
    }, this.settings.localDebounceMs);
  }

  /** (Neu-)Konfiguriert den Drive-Poll-Timer entsprechend den Settings. */
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

  /** Interaktiver Google-Login. */
  async login(): Promise<void> {
    // System-Browser explizit öffnen (nicht ein Electron-Popup), damit der
    // Loopback-Redirect zuverlässig beim lokalen Server landet.
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
   * Setzt den Drive-Wurzelordner. Ändert sich die Ordner-ID gegenüber der
   * bisherigen, wird die Sync-Base geleert — sonst würde der Reconciler die
   * Dateien des NEUEN Ordners gegen die Base des ALTEN Ordners vergleichen und
   * z.B. lokale Dateien fälschlich als „remote gelöscht" behandeln.
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
   * Setzt den lokalen Sync-Ordner ("" = ganzer Vault). Ändert sich der Scope,
   * wird die Sync-Base geleert (analog zum Drive-Ordnerwechsel), damit der
   * Reconciler nicht Dateien eines anderen Scopes gegen die alte Base vergleicht.
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

  /** Leert die Sync-Historie (nicht die Dateien) und persistiert. */
  async resetSyncBase(): Promise<void> {
    this.state.clear();
    await this.state.save();
  }

  /** Zeitstempel des letzten erfolgreichen Syncs (ms; 0 = nie). */
  getLastSyncMs(): number {
    return this.state.getLastSyncMs();
  }

  /** Alle Sync-State-Einträge (für den Sync-Baum in den Settings). */
  getSyncEntries(): SyncStateEntry[] {
    return this.state.all();
  }

  /**
   * Markiert einen „nur in Drive"-Eintrag (Datei ODER Ordner) zum
   * Wiederherstellen: entfernt das keptRemoteOnly-Flag, sodass er beim nächsten
   * Sync heruntergeladen/lokal angelegt wird. Persistiert sofort.
   */
  async restoreRemoteOnly(path: string): Promise<void> {
    const entry = this.state.get(path);
    if (!entry || !entry.keptRemoteOnly) return;
    this.state.set({ ...entry, keptRemoteOnly: false });
    await this.state.save();
  }

  /**
   * Eindeutige Identität von Vault + Drive-Ordner + lokalem Scope. Bindet die
   * Sync-Base an genau diese Kombination, damit eine aus einem anderen Vault
   * kopierte Base erkannt und verworfen wird.
   */
  private scopeId(): string {
    const vault = this.app.vault.getName();
    const drive = this.settings.driveFolderId || "-";
    const local = this.settings.localFolder || "<vault>";
    return `${vault}::${drive}::${local}`;
  }

  // ---------- Event-Unterdrückung während Sync-Schreibvorgängen ----------

  /**
   * Während der Sync selbst Dateien schreibt, dürfen die dadurch ausgelösten
   * modify/create/delete-Events keinen weiteren Sync antriggern. Wir markieren
   * kurzzeitig alle aktuell im Scope liegenden Pfade als unterdrückt.
   */
  private async withSuppressedEvents(fn: () => Promise<void>): Promise<void> {
    // Grobe, aber robuste Strategie: alle Scope-Pfade während des Laufs
    // ignorieren; nach kurzer Verzögerung wieder freigeben.
    const snapshot = this.app.vault
      .getFiles()
      .map((f) => f.path)
      .filter((p) => this.isInScope(p));
    snapshot.forEach((p) => this.suppressedPaths.add(p));
    try {
      await fn();
    } finally {
      // Verzögerte Freigabe, damit noch nachlaufende Events gefiltert werden.
      window.setTimeout(() => this.suppressedPaths.clear(), 1500);
    }
  }

  private isInScope(vaultPath: string): boolean {
    // Systemordner nie synchronisieren (v.a. beim ganzen Vault).
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

    // Ignore-Muster (Blacklist) auf den sync-relativen Pfad anwenden — analog
    // zur Engine, damit eine ignorierte Datei keinen Auto-Sync auslöst.
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

  // ---------- Persistenz ----------

  /**
   * Lädt die Settings aus data.json. Gibt die ROHEN Daten zurück, damit onload()
   * einen evtl. dort noch liegenden Alt-Sync-State (aus früheren Versionen) in
   * die eigene sync-state.json migrieren kann.
   */
  async loadSettings(): Promise<RawData | null> {
    const raw = (await this.loadData()) as RawData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
    // Alt-Felder sind nicht mehr Teil der Settings -> aus dem Objekt entfernen,
    // damit sie beim nächsten saveData nicht erneut nach data.json wandern.
    delete (this.settings as Partial<RawData>).syncState;
    delete (this.settings as Partial<RawData>).lastSyncMs;
    return raw;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** Rohform von data.json inkl. evtl. alter, migrierter Felder. */
interface RawData extends Partial<PluginSettings> {
  syncState?: Record<string, SyncStateEntry>;
  lastSyncMs?: number;
}
