import { Vault } from "obsidian";
import { log } from "./logger";

/**
 * Liest/schreibt JSON-Dateien im Plugin-Konfigurationsordner
 * (`<vault>/.obsidian/plugins/<pluginId>/`). Wird genutzt, um den großen,
 * häufig geänderten Sync-State und das Log getrennt von data.json (Settings)
 * zu halten — so wird data.json nicht bei jedem Sync komplett neu geschrieben.
 */
export class PluginStorage {
  constructor(private vault: Vault, private pluginId: string) {}

  /** Vollständiger Pfad einer Datei im Plugin-Ordner. */
  private path(fileName: string): string {
    return `${this.vault.configDir}/plugins/${this.pluginId}/${fileName}`;
  }

  /** Liest+parst eine JSON-Datei; gibt `fallback` zurück, wenn sie fehlt/kaputt ist. */
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

  /** Serialisiert und schreibt ein Objekt als JSON. */
  async writeJson(fileName: string, data: unknown): Promise<void> {
    const p = this.path(fileName);
    await this.vault.adapter.write(p, JSON.stringify(data));
  }

  /** Löscht eine Datei, falls vorhanden. */
  async remove(fileName: string): Promise<void> {
    const p = this.path(fileName);
    if (await this.vault.adapter.exists(p)) {
      await this.vault.adapter.remove(p);
    }
  }
}
