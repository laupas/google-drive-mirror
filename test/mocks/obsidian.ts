/**
 * Test-Mock für das `obsidian`-Modul.
 *
 * Das echte `obsidian`-Paket liefert nur Typdeklarationen (keine Runtime-JS),
 * daher wird dieser Mock in vitest.config.ts als Alias für `obsidian` verwendet.
 * Er stellt genau die Runtime-Symbole bereit, die der Plugin-Code importiert:
 *   - `normalizePath` (Pfad-Normalisierung, hier vereinfacht)
 *   - `requestUrl`    (HTTP; in Tests via vi.fn() ersetzt)
 *   - `Notice`        (UI-Benachrichtigung; No-Op)
 *   - `TFile`, `Vault` (Klassen, die für `instanceof`-Prüfungen ausreichen)
 */

import { vi } from "vitest";

/**
 * Vereinfachte Nachbildung von Obsidians normalizePath: kollabiert
 * Backslashes/Mehrfach-Slashes und entfernt führende/abschließende Slashes.
 * Reicht für die Pfadlogik der Sync-Engine im Test.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** In Tests via vi.mocked(requestUrl) gesteuert. */
export const requestUrl = vi.fn();

/** UI-Notice — im Test ein No-Op, aber konstruierbar. */
export class Notice {
  constructor(public message: string, public timeout?: number) {}
  setMessage(_message: string): this {
    return this;
  }
  hide(): void {}
}

/** Basisklasse für abstrakte Vault-Dateien (nur für instanceof nötig). */
export class TAbstractFile {
  path = "";
}

/** Repräsentiert eine Datei im Vault (nur für instanceof nötig). */
export class TFile extends TAbstractFile {
  stat = { mtime: 0, ctime: 0, size: 0 };
  basename = "";
  extension = "";
}

/** Repräsentiert einen Ordner im Vault (nur für instanceof nötig). */
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === "" || this.path === "/";
  }
}

/**
 * Vault-Oberfläche, so weit sie der Plugin-Code (sync-engine.ts) nutzt.
 * Nur zur Typprüfung; die tatsächlichen Instanzen im Test sind der FakeVault.
 */
export interface DataAdapter {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  mkdir(path: string): Promise<void>;
  trashSystem(path: string): Promise<boolean>;
}

export class Vault {
  adapter!: DataAdapter;
  getFiles(): TFile[] {
    return [];
  }
  getAbstractFileByPath(_path: string): TAbstractFile | null {
    return null;
  }
  async trash(_file: TAbstractFile, _system: boolean): Promise<void> {}
}

/** AbstractInputSuggest wird von suggesters.ts erweitert (nicht getestet). */
export class AbstractInputSuggest<T> {
  constructor(_app: unknown, _input: unknown) {}
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_value: T, _el: unknown): void {}
  selectSuggestion(_value: T): void {}
}

export class PluginSettingTab {}
export class Setting {}
export class Plugin {}
export class App {}
export class Modal {}
