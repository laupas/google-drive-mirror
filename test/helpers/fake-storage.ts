/**
 * In-memory fake for PluginStorage. Holds JSON files as objects in a map,
 * so SyncStateStore/SyncStatus can persist without a real filesystem.
 */

import { PluginStorage } from "../../src/storage";

export class FakeStorage {
  private files = new Map<string, unknown>();
  /** Test assertion: how often each file was written (for checkpoint tests). */
  private writes = new Map<string, number>();

  async readJson<T>(fileName: string, fallback: T): Promise<T> {
    if (!this.files.has(fileName)) return fallback;
    // Deep-clone via JSON, so the caller doesn't hold a reference into the store.
    return JSON.parse(JSON.stringify(this.files.get(fileName))) as T;
  }

  async writeJson(fileName: string, data: unknown): Promise<void> {
    this.files.set(fileName, JSON.parse(JSON.stringify(data)));
    this.writes.set(fileName, (this.writes.get(fileName) ?? 0) + 1);
  }

  async remove(fileName: string): Promise<void> {
    this.files.delete(fileName);
  }

  /** Test assertion: raw JSON data of a file (or undefined). */
  peek(fileName: string): unknown {
    return this.files.get(fileName);
  }

  /** Test assertion: number of writes to a file. */
  writeCount(fileName: string): number {
    return this.writes.get(fileName) ?? 0;
  }

  /** Make usable as a PluginStorage (structural type). */
  asStorage(): PluginStorage {
    return this as unknown as PluginStorage;
  }
}
