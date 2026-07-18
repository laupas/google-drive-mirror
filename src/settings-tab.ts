import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  normalizePath,
} from "obsidian";
import type GoogleDriveSyncPlugin from "./main";
import { DriveFolderSuggest, LocalFolderSuggest } from "./suggesters";
import { log, setDebugLogging } from "./logger";
import { t } from "./i18n";
import type { SyncStateEntry } from "./types";

/**
 * Einstellungs-UI: OAuth-Setup (eigene Google-Cloud-App), Ordnerwahl,
 * Auto-Sync-Optionen.
 *
 * Hinweis: In den `.addText/.addToggle`-Callbacks heißt die Komponente `c`
 * (nicht `t`), um nicht die importierte Übersetzungsfunktion `t()` zu verdecken.
 */
export class SettingsTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;
  private statusEl: HTMLElement | null = null;
  private syncButton: ButtonComponent | null = null;
  /** Stabiler Container des Sync-Baums, damit er ohne kompletten Re-Render neu gefüllt werden kann. */
  private treeEl: HTMLElement | null = null;
  /** Beschreibungszeile des Sync-Baums (für den "nur in Drive"-Zähler). */
  private treeDescSetting: Setting | null = null;
  /** true, wenn der Nutzer gerade von "ganzer Vault" auf Ordnerwahl umschaltet. */
  private pendingSubfolder = false;

  constructor(app: App, private plugin: GoogleDriveSyncPlugin) {
    super(app, plugin);
  }

  hide(): void {
    // Abo beim Schließen des Tabs lösen.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.statusEl = null;
    this.treeEl = null;
    this.treeDescSetting = null;
    this.pendingSubfolder = false;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Vorheriges Abo lösen (display kann mehrfach laufen).
    this.unsubscribe?.();
    const s = this.plugin.settings;

    containerEl.createEl("h2", { text: t("settingsTitle") });

    // ---- 1. Google-Cloud-App ----
    containerEl.createEl("h3", { text: t("headingCloudAccess") });
    const help = containerEl.createEl("p", { cls: "setting-item-description" });
    help.appendText(t("cloudHelp"));

    new Setting(containerEl)
      .setName(t("clientIdName"))
      .setDesc(t("clientIdDesc"))
      .addText((c) =>
        c
          .setPlaceholder("....apps.googleusercontent.com")
          .setValue(s.clientId)
          .onChange(async (v) => {
            s.clientId = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("clientSecretName"))
      .setDesc(t("clientSecretDesc"))
      .addText((c) => {
        c.inputEl.type = "password";
        c.setValue(s.clientSecret).onChange(async (v) => {
          s.clientSecret = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("loginName"))
      .setDesc(
        s.refreshToken ? t("loginDescSignedIn") : t("loginDescSignedOut")
      )
      .addButton((b) =>
        b
          .setButtonText(
            s.refreshToken ? t("loginButtonReauth") : t("loginButtonSignIn")
          )
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.login(); // zeigt Erfolgs-Notice selbst
              this.display();
            } catch (e) {
              log.error("Login-Fehler:", e);
              new Notice(
                t("loginFailed", {
                  error: e instanceof Error ? e.message : String(e),
                }),
                10000
              );
            }
          })
      )
      .addExtraButton((b) => {
        b.setIcon("log-out")
          .setTooltip(t("logoutTooltip"))
          .onClick(async () => {
            this.plugin.oauth.reset();
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // ---- 2. Ordner ----
    containerEl.createEl("h3", { text: t("headingFolders") });

    // Toggle "ganzer Vault": AN, wenn kein Unterordner gesetzt UND nicht gerade
    // auf Ordnerwahl umgeschaltet wurde.
    const wholeVault = s.localFolder.trim() === "" && !this.pendingSubfolder;

    new Setting(containerEl)
      .setName(t("syncWholeVaultName"))
      .setDesc(t("syncWholeVaultDesc"))
      .addToggle((c) =>
        c.setValue(wholeVault).onChange(async (v) => {
          if (v) {
            // Ganzer Vault -> localFolder leeren (Scope-Wechsel, Base zurücksetzen).
            this.pendingSubfolder = false;
            await this.plugin.setLocalFolder("");
          } else {
            // Auf Ordnerwahl umschalten; Feld + Pflicht-Hinweis erscheinen.
            this.pendingSubfolder = true;
          }
          this.display();
        })
      );

    // Ordnerfeld nur bei ausgeschaltetem "ganzer Vault" zeigen; dann Pflicht.
    if (!wholeVault) {
      new Setting(containerEl)
        .setName(t("localFolderName"))
        .setDesc(
          s.localFolder ? t("localFolderDescSet") : t("localFolderDescEmpty")
        )
        .addText((c) => {
          c.setPlaceholder(t("localFolderPlaceholder"))
            .setValue(s.localFolder)
            .onChange(async (v) => {
              const val = v ? normalizePath(v.trim()) : "";
              // Sobald ein echter Ordner steht, ist der Umschalt-Zustand vorbei.
              if (val) this.pendingSubfolder = false;
              await this.plugin.setLocalFolder(val);
            });
          new LocalFolderSuggest(this.app, c.inputEl, async (path) => {
            this.pendingSubfolder = false;
            await this.plugin.setLocalFolder(path);
            this.display(); // Hinweis auffrischen (Pflicht erfüllt)
          });
        });
    }

    new Setting(containerEl)
      .setName(t("driveFolderName"))
      .setDesc(
        s.driveFolderId
          ? t("driveFolderDescSet", {
              name: s.driveFolderName || s.driveFolderId,
            })
          : t("driveFolderDescEmpty")
      )
      .addText((c) => {
        c.setPlaceholder(
          this.plugin.oauth.isConfigured()
            ? t("driveFolderPlaceholderReady")
            : t("driveFolderPlaceholderNotReady")
        )
          .setValue(s.driveFolderName || s.driveFolderId)
          .onChange(async (v) => {
            // Freie Eingabe = Ordner-ID (Fallback zum Einfügen einer ID).
            s.driveFolderId = v.trim();
            await this.plugin.saveSettings();
          });
        // Autocomplete: sucht Drive-Ordner per API beim Tippen.
        new DriveFolderSuggest(
          this.app,
          c.inputEl,
          this.plugin.drive,
          () => this.plugin.oauth.isConfigured(),
          async (folder) => {
            // Setzt Ordner + setzt Sync-Base zurück, falls sich die ID ändert.
            await this.plugin.setDriveFolder(
              folder.id,
              folder.name,
              folder.driveId
            );
            // Beschreibung ("Aktuell: …") auffrischen.
            this.display();
          }
        );
      })
      .addButton((b) =>
        b.setButtonText(t("driveFolderCheckButton")).onClick(async () => {
          try {
            const folder = await this.plugin.drive.getFolder(s.driveFolderId);
            await this.plugin.setDriveFolder(
              folder.id,
              folder.name,
              folder.driveId
            );
            const loc = folder.driveId ? t("sharedDriveSuffix") : "";
            new Notice(
              t("driveFolderFound", { name: folder.name, location: loc })
            );
            this.display();
          } catch (e) {
            new Notice(
              t("driveFolderInvalid", {
                error: e instanceof Error ? e.message : String(e),
              })
            );
          }
        })
      )
      .addExtraButton((b) =>
        b
          .setIcon("folder-plus")
          .setTooltip(t("driveFolderCreateTooltip"))
          .onClick(async () => {
            try {
              const folder = await this.plugin.drive.createFolder("Obsidian");
              await this.plugin.setDriveFolder(folder.id, folder.name, "");
              new Notice(t("driveFolderCreated", { name: folder.name }));
              this.display();
            } catch (e) {
              new Notice(
                t("driveFolderCreateFailed", {
                  error: e instanceof Error ? e.message : String(e),
                })
              );
            }
          })
      );

    // ---- 2b. Dateifilter ----
    new Setting(containerEl)
      .setName(t("allowedExtensionsName"))
      .setDesc(t("allowedExtensionsDesc"))
      .addText((c) =>
        c
          .setPlaceholder(t("allowedExtensionsPlaceholder"))
          .setValue(s.allowedExtensions)
          .onChange(async (v) => {
            s.allowedExtensions = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("ignorePatternsName"))
      .setDesc(t("ignorePatternsDesc"))
      .addText((c) =>
        c
          .setPlaceholder(t("ignorePatternsPlaceholder"))
          .setValue(s.ignorePatterns)
          .onChange(async (v) => {
            s.ignorePatterns = v;
            await this.plugin.saveSettings();
          })
      );

    // ---- 2c. Löschverhalten ----
    new Setting(containerEl)
      .setName(t("neverDeleteRemoteName"))
      .setDesc(t("neverDeleteRemoteDesc"))
      .addToggle((c) =>
        c.setValue(s.neverDeleteRemote).onChange(async (v) => {
          s.neverDeleteRemote = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    // Sync-Baum: alle Ordner/Dateien; keptRemoteOnly-Einträge mit Checkbox.
    this.renderSyncTree(containerEl);

    // ---- 3. Auto-Sync ----
    containerEl.createEl("h3", { text: t("headingAutoSync") });

    new Setting(containerEl)
      .setName(t("autoSyncEnabledName"))
      .setDesc(t("autoSyncEnabledDesc"))
      .addToggle((c) =>
        c.setValue(s.autoSyncEnabled).onChange(async (v) => {
          s.autoSyncEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.reconfigureAutoSync();
        })
      );

    new Setting(containerEl)
      .setName(t("pollIntervalName"))
      .setDesc(t("pollIntervalDesc"))
      .addText((c) =>
        c.setValue(String(s.pollIntervalSeconds)).onChange(async (v) => {
          const n = Math.max(15, parseInt(v, 10) || 60);
          s.pollIntervalSeconds = n;
          await this.plugin.saveSettings();
          this.plugin.reconfigureAutoSync();
        })
      );

    new Setting(containerEl)
      .setName(t("localDebounceName"))
      .setDesc(t("localDebounceDesc"))
      .addText((c) =>
        c.setValue(String(s.localDebounceMs)).onChange(async (v) => {
          s.localDebounceMs = Math.max(500, parseInt(v, 10) || 2500);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("logRetentionName"))
      .setDesc(t("logRetentionDesc"))
      .addText((c) =>
        c.setValue(String(s.logRetentionHours)).onChange(async (v) => {
          const n = Math.max(0, parseInt(v, 10) || 0);
          s.logRetentionHours = n;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("debugLoggingName"))
      .setDesc(t("debugLoggingDesc"))
      .addToggle((c) =>
        c.setValue(s.debugLogging).onChange(async (v) => {
          s.debugLogging = v;
          setDebugLogging(v);
          await this.plugin.saveSettings();
        })
      );

    // ---- 4. Aktionen & Status ----
    containerEl.createEl("h3", { text: t("headingActionsStatus") });

    const lastSync = this.plugin.getLastSyncMs();
    const syncSetting = new Setting(containerEl)
      .setName(t("syncNowName"))
      .setDesc(
        lastSync
          ? t("lastSyncDesc", { time: new Date(lastSync).toLocaleString() })
          : t("neverSyncedDesc")
      )
      .addButton((b) => {
        this.syncButton = b;
        b.setButtonText(t("syncStartButton"))
          .setCta()
          .onClick(async () => {
            // Nicht auf den Sync warten, damit der Live-Status sichtbar bleibt.
            void this.plugin.runSync(true);
          });
        this.refreshSyncButton();
      });

    // Live-Statuszeile.
    this.statusEl = containerEl.createDiv({ cls: "gds-status" });

    // Sync-Log: Button öffnet ein Live-Modal.
    new Setting(containerEl)
      .setName(t("syncLogName"))
      .setDesc(t("syncLogDesc"))
      .addButton((b) =>
        b.setButtonText(t("showLogButton")).onClick(() => {
          new SyncLogModal(this.app, this.plugin).open();
        })
      )
      .addExtraButton((b) =>
        b
          .setIcon("trash-2")
          .setTooltip(t("clearLogTooltip"))
          .onClick(() => this.plugin.status.clearLog())
      );

    // Live-Updates abonnieren (Status + Button-Zustand + "Letzter Sync").
    let wasSyncing = this.plugin.isSyncing();
    this.unsubscribe = this.plugin.status.subscribe(() => {
      this.renderStatus();
      this.refreshSyncButton();
      const syncing = this.plugin.isSyncing();
      if (!syncing && this.plugin.getLastSyncMs()) {
        syncSetting.setDesc(
          t("lastSyncDesc", {
            time: new Date(this.plugin.getLastSyncMs()).toLocaleString(),
          })
        );
      }
      // Nach einem gerade abgeschlossenen Sync den Baum neu aufbauen
      // (neue keptRemoteOnly-Einträge live sichtbar machen).
      if (wasSyncing && !syncing) this.refreshSyncTree();
      wasSyncing = syncing;
    });
    this.renderStatus();

    new Setting(containerEl)
      .setName(t("resetSyncStateName"))
      .setDesc(t("resetSyncStateDesc"))
      .addButton((b) =>
        b
          .setWarning()
          .setButtonText(t("resetButton"))
          .onClick(async () => {
            await this.plugin.resetSyncBase();
            new Notice(t("resetSyncStateNotice"));
            this.display();
          })
      );
  }

  /**
   * Rendert den gesamten Sync-Baum (alle Ordner + Dateien aus der Sync-Base) als
   * einklappbare Struktur. Einträge mit keptRemoteOnly ("nur in Drive") bekommen
   * eine aktivierte Checkbox; deaktivieren entfernt das Flag, sodass der Eintrag
   * beim nächsten Sync wieder heruntergeladen/lokal angelegt wird.
   */
  private renderSyncTree(containerEl: HTMLElement): void {
    // Überschrift mit Refresh-Button. Der Baum wird in einen STABILEN Container
    // gerendert, den refreshSyncTree() ohne kompletten Settings-Re-Render neu
    // füllen kann (nach Sync automatisch + per Button manuell).
    this.treeDescSetting = new Setting(containerEl)
      .setName(t("syncTreeName"))
      .addExtraButton((b) =>
        b
          .setIcon("refresh-cw")
          .setTooltip(t("syncTreeRefresh"))
          .onClick(() => this.refreshSyncTree())
      );

    this.treeEl = containerEl.createDiv({ cls: "gds-sync-tree" });
    this.refreshSyncTree();
  }

  /**
   * Füllt den Sync-Baum-Container neu (ohne die übrigen Settings anzufassen).
   * Wird nach jedem Sync (via Status-Abo) und über den Refresh-Button aufgerufen.
   */
  private refreshSyncTree(): void {
    if (!this.treeEl) return;
    const entries = this.plugin.getSyncEntries();
    const remoteOnlyCount = entries.filter((e) => e.keptRemoteOnly).length;
    this.treeDescSetting?.setDesc(
      t("syncTreeDesc", { count: remoteOnlyCount })
    );

    this.treeEl.empty();
    if (entries.length === 0) {
      this.treeEl.createDiv({
        cls: "gds-tree-empty",
        text: t("syncTreeEmpty"),
      });
      return;
    }
    const root = buildTree(entries);
    this.renderTreeNodes(this.treeEl, root.children);
  }

  /** Rendert die Kinder eines Baumknotens (Ordner als <details>, Dateien als Zeile). */
  private renderTreeNodes(parentEl: HTMLElement, nodes: TreeNode[]): void {
    // Ordner zuerst, dann Dateien; jeweils alphabetisch.
    const sorted = [...nodes].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const node of sorted) {
      if (node.isFolder) {
        const details = parentEl.createEl("details", { cls: "gds-tree-folder" });
        details.open = false; // eingeklappt (User-Wunsch: einklappbar)
        const summary = details.createEl("summary");
        // Zeile in ein eigenes Div im <summary>, damit der Disclosure-Marker
        // links stehen bleibt und unser Flex-Layout ihn nicht verdrängt.
        const row = summary.createDiv({ cls: "gds-tree-file gds-tree-folder-row" });
        this.renderTreeRow(row, node, `📁 ${node.name}`);
        const childrenEl = details.createDiv({ cls: "gds-tree-children" });
        this.renderTreeNodes(childrenEl, node.children);
      } else {
        const row = parentEl.createDiv({ cls: "gds-tree-file" });
        this.renderTreeRow(row, node, node.name);
      }
    }
  }

  /**
   * Rendert eine Baumzeile: Label links, Aktions-Leiste rechts. Die Aktions-
   * Leiste (`gds-tree-actions`) ist der Andockpunkt für zeilenbezogene Buttons;
   * aktuell die "nur in Drive"-Checkbox, später weitere (Ignorieren usw.).
   */
  private renderTreeRow(
    rowEl: HTMLElement,
    node: TreeNode,
    label: string
  ): void {
    rowEl.addClass("gds-tree-row");

    // Label links.
    const nameCls = node.keptRemoteOnly
      ? "gds-tree-label gds-tree-remote-only"
      : "gds-tree-label";
    rowEl.createSpan({ cls: nameCls, text: label });

    // Aktions-Leiste rechts (bleibt auch leer erhalten, damit die Spalte fluchtet).
    const actions = rowEl.createDiv({ cls: "gds-tree-actions" });
    this.renderRowActions(actions, node);
  }

  /**
   * Baut die zeilenbezogenen Aktions-Buttons (rechtsbündig). Hier weitere
   * Buttons (Ignorieren, …) ergänzen — jeweils via `addRowAction`.
   *
   * Aktuell: die "lokal vorhanden"-Checkbox an JEDER Zeile.
   *  - normaler (beidseitiger) Eintrag: angehakt + deaktiviert (nur Anzeige).
   *  - "nur in Drive" (keptRemoteOnly): abgehakt + anklickbar; Anhaken stellt die
   *    Datei beim nächsten Sync wieder lokal her.
   */
  private renderRowActions(actionsEl: HTMLElement, node: TreeNode): void {
    if (!node.path) return; // reine Struktur-Ordner ohne State-Eintrag

    const path = node.path;
    const remoteOnly = node.keptRemoteOnly;
    this.addRowAction(actionsEl, {
      cls: remoteOnly ? "gds-action-remote-only" : "gds-action-local",
      title: remoteOnly
        ? t("syncTreeCheckboxRestoreTitle")
        : t("syncTreeCheckboxLocalTitle"),
      control: (el) => {
        const cb = el.createEl("input", { type: "checkbox" });
        // Angehakt = lokal vorhanden. keptRemoteOnly = NICHT lokal -> abgehakt.
        cb.checked = !remoteOnly;
        if (!remoteOnly) {
          // Normaler Eintrag: nur Statusanzeige, nicht interaktiv.
          cb.disabled = true;
          return;
        }
        // "nur in Drive": Anhaken = wiederherstellen (lokal herunterladen).
        cb.onchange = async () => {
          if (cb.checked) {
            await this.plugin.restoreRemoteOnly(path);
            new Notice(t("syncTreeRestored", { path }));
            this.display();
          }
        };
      },
    });
  }

  /**
   * Fügt eine einzelne Zeilen-Aktion in die Aktions-Leiste ein. Kapselt das
   * gemeinsame Verhalten (Klick klappt das umschließende <summary> NICHT auf/zu)
   * und vereinheitlicht künftige Buttons.
   */
  private addRowAction(
    actionsEl: HTMLElement,
    opts: {
      cls?: string;
      title?: string;
      control: (host: HTMLElement) => void;
    }
  ): void {
    const host = actionsEl.createSpan({
      cls: `gds-tree-action ${opts.cls ?? ""}`.trim(),
    });
    if (opts.title) host.title = opts.title;
    // Interaktion in der Aktions-Leiste darf das <summary> nicht togglen.
    host.onclick = (e) => e.stopPropagation();
    opts.control(host);
  }

  /** Aktiviert/deaktiviert den Sync-Button und passt den Text an. */
  private refreshSyncButton(): void {
    if (!this.syncButton) return;
    const running = this.plugin.isSyncing();
    this.syncButton.setDisabled(running);
    this.syncButton.setButtonText(
      running ? t("syncRunningButton") : t("syncStartButton")
    );
  }

  /** Rendert die Live-Statuszeile. */
  private renderStatus(): void {
    if (!this.statusEl) return;
    const p = this.plugin.status.getProgress();
    this.statusEl.empty();
    this.statusEl.removeClass("is-running", "is-done", "is-error");

    let label = t("statusLineReady");
    if (p.phase === "running") {
      this.statusEl.addClass("is-running");
      const progress =
        p.total > 0
          ? t("statusLineRunningProgress", {
              current: p.current,
              total: p.total,
            })
          : "";
      const secs = p.startedMs ? Math.round((Date.now() - p.startedMs) / 1000) : 0;
      label = `⏳ ${t("statusLineRunning", {
        message: p.message,
        progress,
        secs,
      })}`;
    } else if (p.phase === "done") {
      this.statusEl.addClass("is-done");
      label = `✅ ${t("statusLineDone", { message: p.message })}`;
    } else if (p.phase === "error") {
      this.statusEl.addClass("is-error");
      label = `⚠️ ${t("statusLineError", { message: p.message })}`;
    }
    this.statusEl.setText(label);
  }
}

/**
 * Modal, das das vollständige Sync-Log anzeigt und sich **live** aktualisiert,
 * solange es geöffnet ist. Neueste Einträge oben.
 */
export class SyncLogModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private listEl: HTMLElement | null = null;

  constructor(app: App, private plugin: GoogleDriveSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("logModalTitle"));
    this.modalEl.addClass("gds-log-modal");

    const controls = this.contentEl.createDiv({ cls: "gds-log-controls" });
    const info = controls.createSpan({ cls: "gds-log-count" });
    const clearBtn = controls.createEl("button", { text: t("logModalClearButton") });
    clearBtn.onclick = () => this.plugin.status.clearLog();

    this.listEl = this.contentEl.createDiv({ cls: "gds-log gds-log--modal" });

    const render = () => {
      const entries = this.plugin.status.getLog();
      info.setText(t("logModalCount", { count: entries.length }));
      this.renderList(entries);
    };
    // Live abonnieren; bei Schließen abmelden.
    this.unsubscribe = this.plugin.status.subscribe(render);
    render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private renderList(
    entries: ReadonlyArray<{ ts: number; level: string; message: string }>
  ): void {
    if (!this.listEl) return;
    this.listEl.empty();
    if (entries.length === 0) {
      this.listEl.createDiv({ cls: "gds-log-empty", text: t("logModalEmpty") });
      return;
    }
    // Neueste zuerst.
    for (const e of [...entries].reverse()) {
      const row = this.listEl.createDiv({ cls: `gds-log-row gds-log-${e.level}` });
      const time = new Date(e.ts).toLocaleString();
      row.createSpan({ cls: "gds-log-time", text: `${time}  ` });
      row.createSpan({ cls: "gds-log-msg", text: e.message });
    }
  }
}

/** Ein Knoten im Sync-Baum (Ordner oder Datei). */
export interface TreeNode {
  name: string;
  /** Voller relativer Pfad (nur bei echten State-Einträgen gesetzt). */
  path: string;
  isFolder: boolean;
  keptRemoteOnly: boolean;
  children: TreeNode[];
}

/**
 * Baut aus den flachen Sync-State-Einträgen eine Baumstruktur. Zwischenordner,
 * die selbst keinen eigenen State-Eintrag haben (nur aus Dateipfaden abgeleitet),
 * werden als reine Struktur-Ordner (ohne Checkbox) erzeugt.
 */
export function buildTree(entries: SyncStateEntry[]): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    isFolder: true,
    keptRemoteOnly: false,
    children: [],
  };

  const findOrAddChild = (parent: TreeNode, name: string): TreeNode => {
    let child = parent.children.find((c) => c.name === name);
    if (!child) {
      child = {
        name,
        path: parent.path ? `${parent.path}/${name}` : name,
        isFolder: true, // vorläufig; ein Datei-Eintrag setzt es unten auf false
        keptRemoteOnly: false,
        children: [],
      };
      parent.children.push(child);
    }
    return child;
  };

  for (const entry of entries) {
    const parts = entry.path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;

    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      node = findOrAddChild(node, parts[i]);
      if (isLast) {
        // Der Blatt-Knoten übernimmt die Eigenschaften des State-Eintrags.
        node.isFolder = entry.isFolder;
        node.keptRemoteOnly = Boolean(entry.keptRemoteOnly);
      }
    }
  }

  return root;
}
