/**
 * In-Memory-Fake für PluginStorage. Hält JSON-Dateien als Objekte in einer Map,
 * sodass SyncStateStore/SyncStatus ohne echtes Dateisystem persistieren können.
 */

import { PluginStorage } from "../../src/storage";

export class FakeStorage {
  private files = new Map<string, unknown>();
  /** Test-Assertion: wie oft wurde jede Datei geschrieben (für Checkpoint-Tests). */
  private writes = new Map<string, number>();

  async readJson<T>(fileName: string, fallback: T): Promise<T> {
    if (!this.files.has(fileName)) return fallback;
    // Deep-Clone via JSON, damit der Aufrufer keine Referenz auf den Store hält.
    return JSON.parse(JSON.stringify(this.files.get(fileName))) as T;
  }

  async writeJson(fileName: string, data: unknown): Promise<void> {
    this.files.set(fileName, JSON.parse(JSON.stringify(data)));
    this.writes.set(fileName, (this.writes.get(fileName) ?? 0) + 1);
  }

  async remove(fileName: string): Promise<void> {
    this.files.delete(fileName);
  }

  /** Test-Assertion: rohe JSON-Daten einer Datei (oder undefined). */
  peek(fileName: string): unknown {
    return this.files.get(fileName);
  }

  /** Test-Assertion: Anzahl der Schreibvorgänge einer Datei. */
  writeCount(fileName: string): number {
    return this.writes.get(fileName) ?? 0;
  }

  /** Als PluginStorage verwendbar machen (Struktur-Typ). */
  asStorage(): PluginStorage {
    return this as unknown as PluginStorage;
  }
}
