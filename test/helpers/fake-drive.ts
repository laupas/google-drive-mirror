/**
 * In-Memory-Fake für GoogleDriveClient. Hält einen Remote-Store und zeichnet
 * Aufrufe auf, damit Integrationstests prüfen können, welche Drive-Operationen
 * die SyncEngine ausgelöst hat — ohne echte HTTP-Requests.
 */

import { GoogleDriveClient } from "../../src/drive-client";
import { DriveFile, DriveFolder } from "../../src/types";

interface RemoteEntry extends DriveFile {
  content: ArrayBuffer;
}

function toBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

export class FakeDriveClient {
  private store = new Map<string, RemoteEntry>(); // key: driveId
  private idSeq = 0;

  public calls = {
    createFile: [] as { path: string }[],
    updateFile: [] as { driveId: string; path: string }[],
    downloadFile: [] as string[],
    trashFile: [] as string[],
    createFolderPath: [] as { path: string }[],
    trashFolder: [] as string[],
  };

  /** In-Memory-Ordner (relativer Pfad -> Drive-Ordner-ID). */
  private folders = new Map<string, string>();

  /**
   * Zusätzliche Ordner-Listing-Einträge, die `listFiles` roh mit ausliefert
   * (für Kollisionstests: mehrere Ordner mit gleichem relativePath). Nicht Teil
   * des `folders`-Map, damit sich gleiche Pfade nicht überschreiben.
   */
  public extraFolderListings: DriveFolder[] = [];

  /** Test-Setup: Remote-Datei mit obsidianPath, Inhalt und Metadaten anlegen. */
  seed(opts: {
    path: string;
    content: string;
    md5: string;
    mtimeMs?: number;
    id?: string;
    mimeType?: string;
    trashed?: boolean;
  }): string {
    const id = opts.id ?? `drive-${++this.idSeq}`;
    this.store.set(id, {
      id,
      name: opts.path.split("/").pop() ?? opts.path,
      mimeType: opts.mimeType ?? "text/markdown",
      modifiedTimeMs: opts.mtimeMs ?? 1_000,
      md5Checksum: opts.md5,
      size: toBuf(opts.content).byteLength,
      trashed: opts.trashed ?? false,
      content: toBuf(opts.content),
      // obsidianPath wird über pathOf zurückgegeben.
      parents: ["root"],
    });
    // Pfad im internen Feld ablegen (pathOf nutzt appProperties -> hier separat).
    (this.store.get(id) as RemoteEntry & { __path: string }).__path = opts.path;
    return id;
  }

  // --- GoogleDriveClient-Oberfläche (nur was die Engine nutzt) ---

  pathOf(f: DriveFile): string {
    return f.relativePath ?? f.name;
  }

  /** Pro Lauf aufgerufen; im Fake ein No-Op (kein echter Ordner-Cache). */
  clearFolderCache(): void {}

  async listFiles(
    _rootFolderId: string,
    _driveId?: string
  ): Promise<{ files: DriveFile[]; folders: DriveFolder[] }> {
    // Der echte Client liefert getrashte Dateien nicht mehr aus (Filter beim
    // rekursiven Listing); der Fake bildet das nach.
    const files = [...this.store.values()]
      .filter((e) => !e.trashed)
      .map((e) => ({
        id: e.id,
        name: e.name,
        mimeType: e.mimeType,
        modifiedTimeMs: e.modifiedTimeMs,
        md5Checksum: e.md5Checksum,
        size: e.size,
        trashed: e.trashed,
        parents: e.parents,
        relativePath: (e as RemoteEntry & { __path?: string }).__path,
      }));
    const folders: DriveFolder[] = [
      ...[...this.folders.entries()].map(
        ([relativePath, id]) => ({ id, relativePath })
      ),
      ...this.extraFolderListings,
    ];
    return { files, folders };
  }

  async downloadFile(driveId: string): Promise<ArrayBuffer> {
    this.calls.downloadFile.push(driveId);
    const e = this.store.get(driveId);
    if (!e) throw new Error(`FakeDrive: keine Datei ${driveId}`);
    return e.content;
  }

  async createFile(
    _rootFolderId: string,
    path: string,
    content: ArrayBuffer
  ): Promise<DriveFile> {
    this.calls.createFile.push({ path });
    const id = `drive-${++this.idSeq}`;
    const entry: RemoteEntry & { __path: string } = {
      id,
      name: path.split("/").pop() ?? path,
      mimeType: "text/markdown",
      modifiedTimeMs: 3_000,
      md5Checksum: `md5-of-${new TextDecoder().decode(content)}`,
      size: content.byteLength,
      trashed: false,
      content,
      parents: ["root"],
      __path: path,
    };
    this.store.set(id, entry);
    return this.strip(entry);
  }

  async updateFile(
    driveId: string,
    path: string,
    content: ArrayBuffer
  ): Promise<DriveFile> {
    this.calls.updateFile.push({ driveId, path });
    const existing = this.store.get(driveId);
    const entry: RemoteEntry & { __path: string } = {
      id: driveId,
      name: path.split("/").pop() ?? path,
      mimeType: existing?.mimeType ?? "text/markdown",
      modifiedTimeMs: 4_000,
      md5Checksum: `md5-of-${new TextDecoder().decode(content)}`,
      size: content.byteLength,
      trashed: false,
      content,
      parents: ["root"],
      __path: path,
    };
    this.store.set(driveId, entry);
    return this.strip(entry);
  }

  async trashFile(driveId: string): Promise<void> {
    this.calls.trashFile.push(driveId);
    const e = this.store.get(driveId);
    if (e) e.trashed = true;
  }

  /** Legt einen (leeren) Ordner an und liefert seine Drive-ID. */
  async createFolderPath(
    _rootFolderId: string,
    path: string,
    _driveId?: string
  ): Promise<string> {
    this.calls.createFolderPath.push({ path });
    const existing = this.folders.get(path);
    if (existing) return existing;
    const id = `folder-${++this.idSeq}`;
    this.folders.set(path, id);
    return id;
  }

  async trashFolder(folderId: string): Promise<void> {
    this.calls.trashFolder.push(folderId);
    for (const [path, id] of this.folders) {
      if (id === folderId) this.folders.delete(path);
    }
  }

  private strip(e: RemoteEntry): DriveFile {
    return {
      id: e.id,
      name: e.name,
      mimeType: e.mimeType,
      modifiedTimeMs: e.modifiedTimeMs,
      md5Checksum: e.md5Checksum,
      size: e.size,
      trashed: e.trashed,
      parents: e.parents,
    };
  }

  /** Als GoogleDriveClient verwendbar machen (Struktur-Typ). */
  asClient(): GoogleDriveClient {
    return this as unknown as GoogleDriveClient;
  }
}
