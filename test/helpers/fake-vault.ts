/**
 * In-memory fake for Obsidian's Vault + DataAdapter, as much as the SyncEngine
 * actually uses. No real filesystem, no Obsidian needed.
 *
 * Files are held as { content, mtime } in a map. The engine calls:
 *   - vault.getFiles()                     -> list of TFile
 *   - vault.getAbstractFileByPath(path)    -> TFile | null
 *   - vault.trash(file, system)            -> deletes file
 *   - vault.adapter.readBinary/writeBinary/exists/stat/mkdir/trashSystem
 */

import { TFile } from "obsidian";

interface FakeEntry {
  content: ArrayBuffer;
  mtime: number;
}

function toArrayBuffer(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

export class FakeVault {
  private files = new Map<string, FakeEntry>();
  public adapter: FakeAdapter;

  constructor() {
    this.adapter = new FakeAdapter(this.files);
  }

  /** Test setup: create a file with text content and mtime. */
  seed(path: string, content: string, mtime = 1_000): void {
    this.files.set(path, { content: toArrayBuffer(content), mtime });
  }

  /** Test assertion: does the file exist (not trashed)? */
  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Test assertion: text content of the file. */
  read(path: string): string {
    const e = this.files.get(path);
    if (!e) throw new Error(`FakeVault: keine Datei ${path}`);
    return new TextDecoder().decode(e.content);
  }

  getFiles(): TFile[] {
    return [...this.files.entries()].map(([path, entry]) => {
      const f = new TFile();
      f.path = path;
      f.stat = { mtime: entry.mtime, ctime: entry.mtime, size: entry.content.byteLength };
      return f;
    });
  }

  getAbstractFileByPath(path: string): TFile | null {
    if (!this.files.has(path)) return null;
    const f = new TFile();
    f.path = path;
    return f;
  }

  /**
   * The engine uses this for folder collection (collectLocalFolders).
   * The fake holds no real folder objects -> empty list. This keeps
   * the existing file-only tests valid and unchanged.
   */
  getAllLoadedFiles(): TFile[] {
    return [];
  }

  async trash(file: TFile, _system: boolean): Promise<void> {
    this.files.delete(file.path);
  }
}

class FakeAdapter {
  constructor(private files: Map<string, FakeEntry>) {}

  /** Test assertion: which paths were read via readBinary (hash cache). */
  public readBinaryCalls: string[] = [];

  async readBinary(path: string): Promise<ArrayBuffer> {
    const e = this.files.get(path);
    if (!e) throw new Error(`FakeAdapter: keine Datei ${path}`);
    this.readBinaryCalls.push(path);
    return e.content;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const existing = this.files.get(path);
    this.files.set(path, { content: data, mtime: existing?.mtime ?? 2_000 });
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const e = this.files.get(path);
    return e ? { mtime: e.mtime, size: e.content.byteLength } : null;
  }

  async mkdir(_path: string): Promise<void> {
    // In-memory: folders are implicit, no-op.
  }

  async trashSystem(path: string): Promise<boolean> {
    return this.files.delete(path);
  }
}
