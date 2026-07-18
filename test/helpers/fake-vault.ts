/**
 * In-Memory-Fake für Obsidians Vault + DataAdapter, so viel wie die SyncEngine
 * tatsächlich benutzt. Kein echtes Dateisystem, kein Obsidian nötig.
 *
 * Dateien werden als { content, mtime } in einer Map gehalten. Die Engine ruft:
 *   - vault.getFiles()                     -> Liste der TFile
 *   - vault.getAbstractFileByPath(path)    -> TFile | null
 *   - vault.trash(file, system)            -> löscht Datei
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

  /** Test-Setup: Datei mit Textinhalt und mtime anlegen. */
  seed(path: string, content: string, mtime = 1_000): void {
    this.files.set(path, { content: toArrayBuffer(content), mtime });
  }

  /** Test-Assertion: existiert die Datei (nicht getrasht)? */
  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Test-Assertion: Textinhalt der Datei. */
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
   * Die Engine nutzt dies für die Ordner-Erhebung (collectLocalFolders).
   * Der Fake hält keine echten Ordner-Objekte -> leere Liste. Dadurch bleiben
   * die bestehenden reinen Datei-Tests unverändert gültig.
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

  async readBinary(path: string): Promise<ArrayBuffer> {
    const e = this.files.get(path);
    if (!e) throw new Error(`FakeAdapter: keine Datei ${path}`);
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
    // In-Memory: Ordner sind implizit, No-Op.
  }

  async trashSystem(path: string): Promise<boolean> {
    return this.files.delete(path);
  }
}
