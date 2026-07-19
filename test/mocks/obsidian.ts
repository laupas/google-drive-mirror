/**
 * Test mock for the `obsidian` module.
 *
 * The real `obsidian` package only ships type declarations (no runtime JS),
 * so this mock is used as an alias for `obsidian` in vitest.config.ts.
 * It provides exactly the runtime symbols the plugin code imports:
 *   - `normalizePath` (path normalization, simplified here)
 *   - `requestUrl`    (HTTP; replaced via vi.fn() in tests)
 *   - `Notice`        (UI notification; no-op)
 *   - `TFile`, `Vault` (classes sufficient for `instanceof` checks)
 */

import { vi } from "vitest";

/**
 * Simplified replica of Obsidian's normalizePath: collapses
 * backslashes/multiple slashes and removes leading/trailing slashes.
 * Sufficient for the sync engine's path logic in tests.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Controlled in tests via vi.mocked(requestUrl). */
export const requestUrl = vi.fn();

/**
 * Platform flags. Default to desktop; tests that exercise the mobile branch
 * flip `Platform.isMobileApp` via a spy/assignment.
 */
export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
};

/** UI notice — a no-op in tests, but constructible. */
export class Notice {
  constructor(public message: string, public timeout?: number) {}
  setMessage(_message: string): this {
    return this;
  }
  hide(): void {}
}

/** Base class for abstract vault files (only needed for instanceof). */
export class TAbstractFile {
  path = "";
}

/** Represents a file in the vault (only needed for instanceof). */
export class TFile extends TAbstractFile {
  stat = { mtime: 0, ctime: 0, size: 0 };
  basename = "";
  extension = "";
}

/** Represents a folder in the vault (only needed for instanceof). */
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === "" || this.path === "/";
  }
}

/**
 * Vault surface, as far as the plugin code (sync-engine.ts) uses it.
 * For type checking only; the actual instances in tests are the FakeVault.
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

/** AbstractInputSuggest is extended by suggesters.ts (not tested). */
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
