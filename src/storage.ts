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

  /** Deletes a file if it exists. */
  async remove(fileName: string): Promise<void> {
    const p = this.path(fileName);
    if (await this.vault.adapter.exists(p)) {
      await this.vault.adapter.remove(p);
    }
  }
}
