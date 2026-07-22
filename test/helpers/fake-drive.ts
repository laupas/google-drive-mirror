/**
 * In-memory fake for GoogleDriveClient. Holds a remote store and records
 * calls, so integration tests can verify which Drive operations the
 * SyncEngine triggered — without real HTTP requests.
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

  /** In-memory folders (relative path -> Drive folder ID). */
  private folders = new Map<string, string>();

  /**
   * Additional folder-listing entries that `listFiles` returns raw
   * (for collision tests: multiple folders with the same relativePath). Not part
   * of the `folders` map, so identical paths don't overwrite each other.
   */
  public extraFolderListings: DriveFolder[] = [];

  /** Test setup: create a remote file with obsidianPath, content and metadata. */
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
      // obsidianPath is returned via pathOf.
      parents: ["root"],
    });
    // Store the path in the internal field (pathOf uses appProperties -> separate here).
    (this.store.get(id) as RemoteEntry & { __path: string }).__path = opts.path;
    return id;
  }

  // --- GoogleDriveClient surface (only what the engine uses) ---

  pathOf(f: DriveFile): string {
    return f.relativePath ?? f.name;
  }

  /** Called once per run; a no-op in the fake (no real folder cache). */
  clearFolderCache(): void {}

  async listFiles(
    _rootFolderId: string,
    _driveId?: string,
    _onProgress?: (p: { foldersScanned: number; filesFound: number }) => void,
    onFile?: (file: DriveFile) => void | Promise<void>
  ): Promise<{ files: DriveFile[]; folders: DriveFolder[] }> {
    // The real client no longer returns trashed files (filtered during the
    // recursive listing); the fake mirrors that.
    const mapped = [...this.store.values()]
      .filter((e) => !e.trashed)
      .map((e) => ({
        id: e.id,
        name: e.name,
        mimeType: e.mimeType,
        modifiedTimeMs: e.modifiedTimeMs,
        md5Checksum: e.md5Checksum,
        size: e.size,
        relativePath: (e as RemoteEntry & { __path?: string }).__path,
      }));
    // Mirror the real client's `onFile` streaming contract: when provided,
    // AWAIT each file (backpressure) and return an empty `files` array (the
    // engine stores them). Otherwise return them in-memory.
    let files: DriveFile[] = [];
    if (onFile) {
      for (const f of mapped) await onFile(f);
    } else {
      files = mapped;
    }
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

  downloadTransport(): "fetch" | "requestUrl" | "unknown" {
    return "unknown";
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

  /** Creates an (empty) folder and returns its Drive ID. */
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
    };
  }

  /** Make usable as a GoogleDriveClient (structural type). */
  asClient(): GoogleDriveClient {
    return this as unknown as GoogleDriveClient;
  }
}
