import { Vault } from "obsidian";
import { log } from "./logger";

/**
 * Reads/writes JSON files in the plugin configuration folder
 * (`<vault>/.obsidian/plugins/<pluginId>/`). Used to keep the large,
 * frequently changed sync state and the log separate from data.json (settings)
 * — so data.json isn't fully rewritten on every sync.
 */
export class PluginStorage {
  constructor(private vault: Vault, private pluginId: string) {}

  /** Full path of a file in the plugin folder. */
  private path(fileName: string): string {
    return `${this.vault.configDir}/plugins/${this.pluginId}/${fileName}`;
  }

  /** Reads+parses a JSON file; returns `fallback` if it is missing/corrupt. */
  async readJson<T>(fileName: string, fallback: T): Promise<T> {
    const p = this.path(fileName);
    try {
      if (!(await this.vault.adapter.exists(p))) return fallback;
      const raw = await this.vault.adapter.read(p);
      return JSON.parse(raw) as T;
    } catch (e) {
      log.error(`Konnte ${fileName} nicht lesen:`, e);
      return fallback;
    }
  }

  /** Serializes and writes an object as JSON. */
  async writeJson(fileName: string, data: unknown): Promise<void> {
    const p = this.path(fileName);
    await this.vault.adapter.write(p, JSON.stringify(data));
  }

  /**
   * Appends a raw text chunk to a file (creating it if absent). Used to spill
   * the Drive listing to a temp JSONL file one record at a time during the
   * fetch, so the whole listing never has to sit in memory (iOS OOM guard).
   */
  async appendText(fileName: string, text: string): Promise<void> {
    const p = this.path(fileName);
    await this.vault.adapter.append(p, text);
  }

  /** Reads a file as raw text; returns "" if missing/unreadable. */
  async readText(fileName: string): Promise<string> {
    const p = this.path(fileName);
    try {
      if (!(await this.vault.adapter.exists(p))) return "";
      return await this.vault.adapter.read(p);
    } catch (e) {
      log.error(`Konnte ${fileName} nicht lesen:`, e);
      return "";
    }
  }

  /** Deletes a file if it exists. */
  async remove(fileName: string): Promise<void> {
    const p = this.path(fileName);
    if (await this.vault.adapter.exists(p)) {
      await this.vault.adapter.remove(p);
    }
  }

  /**
   * Lists the plain file names (not full paths) directly inside the plugin
   * folder. Used to find orphaned per-target state files. Returns an empty
   * array on any error (folder missing, adapter without list support).
   */
  async listFileNames(): Promise<string[]> {
    const dir = `${this.vault.configDir}/plugins/${this.pluginId}`;
    try {
      if (!(await this.vault.adapter.exists(dir))) return [];
      const listing = await this.vault.adapter.list(dir);
      // adapter.list returns full paths in `files`; reduce to the base name.
      return listing.files.map((f) => f.split("/").pop() ?? f);
    } catch (e) {
      log.error("Konnte Plugin-Ordner nicht auflisten:", e);
      return [];
    }
  }
}
