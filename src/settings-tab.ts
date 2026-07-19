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
 * Settings UI: OAuth setup (your own Google Cloud app), folder selection,
 * auto-sync options.
 *
 * Note: In the `.addText/.addToggle` callbacks the component is named `c`
 * (not `t`), so it doesn't shadow the imported translation function `t()`.
 */
export class SettingsTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;
  private statusEl: HTMLElement | null = null;
  private syncButton: ButtonComponent | null = null;
  /** Stable container for the sync tree, so it can be refilled without a full re-render. */
  private treeEl: HTMLElement | null = null;
  /** Description line of the sync tree (for the "Drive-only" counter). */
  private treeDescSetting: Setting | null = null;
  /** true when the user is switching from "whole vault" to folder selection. */
  private pendingSubfolder = false;

  constructor(app: App, private plugin: GoogleDriveSyncPlugin) {
    super(app, plugin);
  }

  hide(): void {
    // Release the subscription when the tab closes.
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
    // Release the previous subscription (display can run multiple times).
    this.unsubscribe?.();
    const s = this.plugin.settings;

    containerEl.createEl("h2", { text: t("settingsTitle") });

    // ---- 1. Google Cloud app ----
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
              await this.plugin.login(); // shows the success notice itself
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

    // ---- 2. Folders ----
    containerEl.createEl("h3", { text: t("headingFolders") });

    // Toggle "whole vault": ON when no subfolder is set AND we're not currently
    // switching to folder selection.
    const wholeVault = s.localFolder.trim() === "" && !this.pendingSubfolder;

    new Setting(containerEl)
      .setName(t("syncWholeVaultName"))
      .setDesc(t("syncWholeVaultDesc"))
      .addToggle((c) =>
        c.setValue(wholeVault).onChange(async (v) => {
          if (v) {
            // Whole vault -> clear localFolder (scope change, reset base).
            this.pendingSubfolder = false;
            await this.plugin.setLocalFolder("");
          } else {
            // Switch to folder selection; field + required hint appear.
            this.pendingSubfolder = true;
          }
          this.display();
        })
      );

    // Show the folder field only when "whole vault" is off; then required.
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
              // Once a real folder is set, the switching state is over.
              if (val) this.pendingSubfolder = false;
              await this.plugin.setLocalFolder(val);
            });
          new LocalFolderSuggest(this.app, c.inputEl, async (path) => {
            this.pendingSubfolder = false;
            await this.plugin.setLocalFolder(path);
            this.display(); // refresh the hint (requirement met)
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
            // Free input = folder ID (fallback for pasting an ID).
            s.driveFolderId = v.trim();
            await this.plugin.saveSettings();
          });
        // Autocomplete: searches Drive folders via API while typing.
        new DriveFolderSuggest(
          this.app,
          c.inputEl,
          this.plugin.drive,
          () => this.plugin.oauth.isConfigured(),
          async (folder) => {
            // Sets folder + resets the sync base if the ID changes.
            await this.plugin.setDriveFolder(
              folder.id,
              folder.name,
              folder.driveId
            );
            // Refresh the description ("Current: …").
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

    // ---- 2b. File filter ----
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

    // ---- 2c. Deletion behavior ----
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

    // Sync tree: all folders/files; keptRemoteOnly entries with a checkbox.
    this.renderSyncTree(containerEl);

    // ---- 3. Auto-sync ----
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

    // ---- 4. Actions & status ----
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
            // Don't await the sync, so the live status stays visible.
            void this.plugin.runSync(true);
          });
        this.refreshSyncButton();
      });

    // Live status line.
    this.statusEl = containerEl.createDiv({ cls: "gds-status" });

    // Sync log: button opens a live modal.
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

    // Subscribe to live updates (status + button state + "last sync").
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
      // Rebuild the tree after a just-completed sync
      // (make new keptRemoteOnly entries visible live).
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
   * Renders the entire sync tree (all folders + files from the sync base) as a
   * collapsible structure. Entries with keptRemoteOnly ("Drive-only") get a
   * checked checkbox; unchecking removes the flag so the entry is downloaded/
   * created locally again on the next sync.
   */
  private renderSyncTree(containerEl: HTMLElement): void {
    // Heading with a refresh button. The tree is rendered into a STABLE
    // container that refreshSyncTree() can refill without a full settings
    // re-render (automatically after a sync + manually via the button).
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
   * Refills the sync-tree container (without touching the rest of the settings).
   * Called after every sync (via the status subscription) and via the refresh button.
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

  /** Renders the children of a tree node (folders as <details>, files as a row). */
  private renderTreeNodes(parentEl: HTMLElement, nodes: TreeNode[]): void {
    // Folders first, then files; each alphabetically.
    const sorted = [...nodes].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const node of sorted) {
      if (node.isFolder) {
        const details = parentEl.createEl("details", { cls: "gds-tree-folder" });
        details.open = false; // collapsed (user request: collapsible)
        const summary = details.createEl("summary");
        // Row in its own div inside the <summary>, so the disclosure marker
        // stays on the left and our flex layout doesn't push it away.
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
   * Renders a tree row: label on the left, action bar on the right. The action
   * bar (`gds-tree-actions`) is the docking point for row-related buttons;
   * currently the "Drive-only" checkbox, later more (ignore, etc.).
   */
  private renderTreeRow(
    rowEl: HTMLElement,
    node: TreeNode,
    label: string
  ): void {
    rowEl.addClass("gds-tree-row");

    // Label on the left.
    const nameCls = node.keptRemoteOnly
      ? "gds-tree-label gds-tree-remote-only"
      : "gds-tree-label";
    rowEl.createSpan({ cls: nameCls, text: label });

    // Action bar on the right (kept even when empty, so the column stays aligned).
    const actions = rowEl.createDiv({ cls: "gds-tree-actions" });
    this.renderRowActions(actions, node);
  }

  /**
   * Builds the row-related action buttons (right-aligned). Add further
   * buttons (ignore, …) here — each via `addRowAction`.
   *
   * Currently: the "exists locally" checkbox on EVERY row.
   *  - normal (two-sided) entry: checked + disabled (display only).
   *  - "Drive-only" (keptRemoteOnly): unchecked + clickable; checking restores
   *    the file locally on the next sync.
   */
  private renderRowActions(actionsEl: HTMLElement, node: TreeNode): void {
    if (!node.path) return; // pure structure folders without a state entry

    const path = node.path;
    const remoteOnly = node.keptRemoteOnly;
    this.addRowAction(actionsEl, {
      cls: remoteOnly ? "gds-action-remote-only" : "gds-action-local",
      title: remoteOnly
        ? t("syncTreeCheckboxRestoreTitle")
        : t("syncTreeCheckboxLocalTitle"),
      control: (el) => {
        const cb = el.createEl("input", { type: "checkbox" });
        // Checked = exists locally. keptRemoteOnly = NOT local -> unchecked.
        cb.checked = !remoteOnly;
        if (!remoteOnly) {
          // Normal entry: status display only, not interactive.
          cb.disabled = true;
          return;
        }
        // "Drive-only": checking = restore (download locally).
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
   * Adds a single row action to the action bar. Encapsulates the shared
   * behavior (a click does NOT toggle the enclosing <summary> open/closed)
   * and unifies future buttons.
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
    // Interaction in the action bar must not toggle the <summary>.
    host.onclick = (e) => e.stopPropagation();
    opts.control(host);
  }

  /** Enables/disables the sync button and adjusts the text. */
  private refreshSyncButton(): void {
    if (!this.syncButton) return;
    const running = this.plugin.isSyncing();
    this.syncButton.setDisabled(running);
    this.syncButton.setButtonText(
      running ? t("syncRunningButton") : t("syncStartButton")
    );
  }

  /** Renders the live status line. */
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
 * Modal that shows the full sync log and updates **live** while it is open.
 * Newest entries on top.
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
    // Subscribe live; unsubscribe on close.
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
    // Newest first.
    for (const e of [...entries].reverse()) {
      const row = this.listEl.createDiv({ cls: `gds-log-row gds-log-${e.level}` });
      const time = new Date(e.ts).toLocaleString();
      row.createSpan({ cls: "gds-log-time", text: `${time}  ` });
      row.createSpan({ cls: "gds-log-msg", text: e.message });
    }
  }
}

/** A node in the sync tree (folder or file). */
export interface TreeNode {
  name: string;
  /** Full relative path (only set for real state entries). */
  path: string;
  isFolder: boolean;
  keptRemoteOnly: boolean;
  children: TreeNode[];
}

/**
 * Builds a tree structure from the flat sync-state entries. Intermediate
 * folders that have no state entry of their own (only derived from file paths)
 * are created as pure structure folders (without a checkbox).
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
        isFolder: true, // tentative; a file entry sets it to false below
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
        // The leaf node takes on the properties of the state entry.
        node.isFolder = entry.isFolder;
        node.keptRemoteOnly = Boolean(entry.keptRemoteOnly);
      }
    }
  }

  return root;
}
