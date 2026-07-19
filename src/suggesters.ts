import { AbstractInputSuggest, App, TFolder } from "obsidian";
import { GoogleDriveClient } from "./drive-client";
import { t } from "./i18n";

/** A Drive folder hit for the autocomplete. `driveId` ≠ "" = Shared Drive. */
export interface DriveFolderHit {
  id: string;
  name: string;
  driveId: string;
}

/**
 * Autocomplete for local vault folders. Shows matching folders as a dropdown
 * while typing (as in many other Obsidian plugins).
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
    // Iterate over all folders in the vault (incl. vault root).
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
 * Autocomplete for Google Drive folders. Searches for matching folders via the
 * Drive API while typing (debounced) and shows them as a dropdown.
 * Includes Shared Drives (Team Drives).
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
    // Small debounce so that not every keystroke triggers an API call.
    await this.debounce(250);
    try {
      return await this.drive.searchFolders(query, 20);
    } catch {
      return [];
    }
  }

  renderSuggestion(folder: DriveFolderHit, el: HTMLElement): void {
    const title = el.createDiv({ text: folder.name });
    if (folder.driveId) {
      // Visibly mark Shared Drive folders.
      title.createSpan({
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
