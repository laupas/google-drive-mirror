import { AbstractInputSuggest, App, TFolder } from "obsidian";
import { GoogleDriveClient } from "./drive-client";
import { t } from "./i18n";

/** Ein Drive-Ordner-Treffer für das Autocomplete. `driveId` ≠ "" = Shared Drive. */
export interface DriveFolderHit {
  id: string;
  name: string;
  driveId: string;
}

/**
 * Autocomplete für lokale Vault-Ordner. Zeigt beim Tippen passende Ordner
 * als Dropdown an (wie in vielen anderen Obsidian-Plugins).
 */
export class LocalFolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private onPick: (path: string) => void
  ) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    const folders: TFolder[] = [];
    // Alle Ordner im Vault durchgehen (inkl. Vault-Wurzel).
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (file instanceof TFolder && file.path.toLowerCase().contains(lower)) {
        folders.push(file);
      }
    }
    return folders.slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path === "/" ? t("suggestWholeVault") : folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    const value = folder.path === "/" ? "" : folder.path;
    this.inputEl.value = value;
    this.inputEl.trigger("input");
    this.onPick(value);
    this.close();
  }
}

/**
 * Autocomplete für Google-Drive-Ordner. Sucht beim Tippen per Drive-API
 * nach passenden Ordnern (debounced) und zeigt sie als Dropdown.
 * Schließt Shared Drives (Team Drives) mit ein.
 */
export class DriveFolderSuggest extends AbstractInputSuggest<DriveFolderHit> {
  private debounceHandle: number | null = null;

  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private drive: GoogleDriveClient,
    private isReady: () => boolean,
    private onPick: (folder: DriveFolderHit) => void
  ) {
    super(app, inputEl);
  }

  async getSuggestions(query: string): Promise<DriveFolderHit[]> {
    if (!this.isReady()) return [];
    // Kleines Debounce, damit nicht jeder Tastendruck einen API-Call auslöst.
    await this.debounce(250);
    try {
      return await this.drive.searchFolders(query, 20);
    } catch {
      return [];
    }
  }

  renderSuggestion(folder: DriveFolderHit, el: HTMLElement): void {
    const title = el.createEl("div", { text: folder.name });
    if (folder.driveId) {
      // Shared-Drive-Ordner sichtbar kennzeichnen.
      title.createEl("span", {
        text: t("suggestSharedDriveBadge"),
        cls: "gds-suggest-badge",
      });
    }
    el.createEl("small", {
      text: folder.id,
      cls: "gds-suggest-id",
    });
  }

  selectSuggestion(folder: DriveFolderHit): void {
    this.inputEl.value = folder.name;
    this.inputEl.trigger("input");
    this.onPick(folder);
    this.close();
  }

  private debounce(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.debounceHandle !== null) window.clearTimeout(this.debounceHandle);
      this.debounceHandle = window.setTimeout(resolve, ms);
    });
  }
}
