import { requestUrl } from "obsidian";
import { DriveFile, DriveFolder } from "./types";
import { OAuthManager } from "./oauth";
import { MessageKey, t } from "./i18n";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** appProperties key under which the vault-relative path is stored. */
const PATH_PROP = "obsidianPath";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,md5Checksum,size,trashed,parents,appProperties,driveId";

/**
 * For Shared Drives (Team Drives), all requests must set supportsAllDrives=true.
 * On regular "My Drive" the parameter is harmless, so it's always on.
 */
const SUPPORTS_ALL_DRIVES = "supportsAllDrives=true";

/**
 * Thin wrapper over the Google Drive REST API (v3).
 *
 * Design: Instead of mirroring the vault folder hierarchy in Drive, the full
 * vault-relative path is stored in appProperties[obsidianPath].
 * All sync files sit flat in the configured Drive root folder.
 * This eliminates error-prone folder reconciliation and rename edge cases.
 */
/** How often a transiently failed request is retried. */
const MAX_RETRIES = 4;
/** Base for the exponential backoff (ms): 500, 1000, 2000, 4000 … */
const RETRY_BASE_MS = 500;

/** HTTP response from requestUrl (the subset the client uses). */
export interface DriveResponse {
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

/** Performs an HTTP request (injectable for tests). */
export type RequestFn = (params: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  throw?: boolean;
}) => Promise<DriveResponse>;

/** Default HTTP implementation: Obsidian's `requestUrl`, mapped to `RequestFn`. */
const defaultRequestImpl: RequestFn = async (params) => {
  const resp = await requestUrl(params);
  return {
    status: resp.status,
    text: resp.text,
    json: resp.json,
    arrayBuffer: resp.arrayBuffer,
  };
};

export class GoogleDriveClient {
  /**
   * @param oauth    Token provider.
   * @param requestImpl  HTTP implementation (default: Obsidian's requestUrl).
   *                     Injectable so tests can verify retry/backoff.
   */
  constructor(
    private oauth: OAuthManager,
    private requestImpl: RequestFn = defaultRequestImpl
  ) {}

  private async authHeader(): Promise<Record<string, string>> {
    const token = await this.oauth.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Central request wrapper with retry + exponential backoff for TRANSIENT
   * errors (429 rate limit, 5xx server, network exceptions). Deterministic
   * 4xx (except 429) are NOT retried. Important during parallel execution,
   * where Google responds with 429 more easily.
   */
  private async request(
    params: Parameters<RequestFn>[0]
  ): Promise<DriveResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await this.requestImpl({ ...params, throw: false });
        if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
          if (attempt < MAX_RETRIES) {
            await sleep(backoffMs(attempt));
            continue;
          }
        }
        return resp; // success or non-retryable status -> return.
      } catch (e) {
        // Network exception (no HTTP status) -> retryable.
        lastErr = e;
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw e;
      }
    }
    // Unreachable, but for TS completeness.
    throw lastErr instanceof Error ? lastErr : new Error("request failed");
  }

  /**
   * Lists all (non-deleted and deleted) files in the root folder.
   * Includes trashed files so the reconciler can detect deletions.
   */
  /**
   * Lists **recursively** all files under the root folder. Descends into all
   * subfolders and sets `relativePath` on each file = path relative to the
   * root folder (derived from the folder chain, e.g. "sub/notiz.md"). This way
   * subfolders/files created manually in Drive are also captured correctly.
   */
  async listFiles(
    rootFolderId: string,
    driveId?: string
  ): Promise<{ files: DriveFile[]; folders: DriveFolder[] }> {
    const files: DriveFile[] = [];
    const folders: DriveFolder[] = [];
    // Breadth-first search over the folder hierarchy.
    const queue: { id: string; prefix: string }[] = [
      { id: rootFolderId, prefix: "" },
    ];

    while (queue.length > 0) {
      const { id, prefix } = queue.shift()!;
      const children = await this.listChildren(id, driveId);
      for (const f of children) {
        const relativePath = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.mimeType === "application/vnd.google-apps.folder") {
          if (f.trashed) continue;
          // Emit the folder itself as its own entry AND descend recursively.
          folders.push({ id: f.id, relativePath });
          queue.push({ id: f.id, prefix: relativePath });
        } else {
          files.push({ ...this.mapFile(f), relativePath });
        }
      }
    }
    return { files, folders };
  }

  /** Lists the direct children of a folder (with pagination). */
  private async listChildren(
    folderId: string,
    driveId?: string
  ): Promise<RawDriveFile[]> {
    const out: RawDriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (driveId) {
        params.set("corpora", "drive");
        params.set("driveId", driveId);
      }
      if (pageToken) params.set("pageToken", pageToken);

      const resp = await this.request({
        url: `${DRIVE_API}/files?${params.toString()}`,
        method: "GET",
        headers: await this.authHeader(),
        throw: false,
      });
      this.assertOk(resp, "driveActionListFiles");

      const json = resp.json as { files: RawDriveFile[]; nextPageToken?: string };
      out.push(...(json.files ?? []));
      pageToken = json.nextPageToken;
    } while (pageToken);

    return out;
  }

  /** Returns the vault-relative path of a Drive file. */
  pathOf(f: DriveFile): string {
    return f.relativePath ?? f.name;
  }

  /** Downloads the binary content of a file. */
  async downloadFile(driveId: string): Promise<ArrayBuffer> {
    const resp = await this.request({
      url: `${DRIVE_API}/files/${driveId}?alt=media&${SUPPORTS_ALL_DRIVES}`,
      method: "GET",
      headers: await this.authHeader(),
      throw: false,
    });
    this.assertOk(resp, "driveActionDownloadFile");
    return resp.arrayBuffer;
  }

  /**
   * Creates a new file under the root folder. Creates missing intermediate
   * folders (from the path, e.g. "sub/a/notiz.md") in Drive, so the vault's
   * folder structure is mirrored.
   */
  async createFile(
    rootFolderId: string,
    path: string,
    content: ArrayBuffer,
    driveId?: string
  ): Promise<DriveFile> {
    const parentId = await this.ensureFolderPath(rootFolderId, path, driveId);
    const metadata = {
      name: basename(path),
      parents: [parentId],
      appProperties: { [PATH_PROP]: path },
    };
    const resp = await this.multipartUpload(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&${SUPPORTS_ALL_DRIVES}&fields=${FILE_FIELDS}`,
      "POST",
      metadata,
      content
    );
    this.assertOk(resp, "driveActionCreateFile");
    return this.mapFile(resp.json as RawDriveFile);
  }

  /**
   * Ensures the folder chain for the file path exists in Drive and returns the
   * ID of the direct parent folder. Creates missing folders.
   * Uses a cache to avoid repeated lookups within a sync run.
   */
  private async ensureFolderPath(
    rootFolderId: string,
    filePath: string,
    driveId?: string
  ): Promise<string> {
    const dir = dirname(filePath);
    if (!dir) return rootFolderId;
    return this.resolveFolderPath(rootFolderId, dir, driveId);
  }

  /**
   * Ensures the folder at `relativePath` exists in Drive (including all
   * intermediate folders). For creating (even empty) folders.
   * Returns the Drive ID of the target folder.
   */
  async createFolderPath(
    rootFolderId: string,
    relativePath: string,
    driveId?: string
  ): Promise<string> {
    return this.resolveFolderPath(rootFolderId, relativePath, driveId);
  }

  /**
   * Resolves a slash-separated folder path to its Drive ID, creating missing
   * intermediate folders. Shared by ensureFolderPath/createFolderPath.
   *
   * PARALLEL-SAFE: caches the in-flight PROMISE per accumulated path (not just
   * the finished ID). If two concurrent uploads need the same not-yet-created
   * folder, both await the same promise instead of each creating a duplicate
   * folder in Drive.
   */
  private async resolveFolderPath(
    rootFolderId: string,
    relativePath: string,
    driveId?: string
  ): Promise<string> {
    let parentId = rootFolderId;
    let accumulated = "";
    for (const segment of relativePath.split("/")) {
      if (!segment) continue;
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;

      let pending = this.folderCache.get(accumulated);
      if (!pending) {
        // Capture parent in a local so the async closure uses a stable value.
        const parent = parentId;
        pending = this.findOrCreateChildFolder(parent, segment, driveId);
        this.folderCache.set(accumulated, pending);
        // On failure, drop the cache entry so a later run can retry.
        pending.catch(() => {
          if (this.folderCache.get(accumulated) === pending) {
            this.folderCache.delete(accumulated);
          }
        });
      }
      parentId = await pending;
    }
    return parentId;
  }

  /** Moves a folder (with its contents) to the Drive trash. */
  async trashFolder(folderId: string): Promise<void> {
    // Same semantics as trashFile — Drive trashes the folder along with its contents.
    await this.trashFile(folderId);
  }

  /** Searches a subfolder by name; creates it if not present. */
  private async findOrCreateChildFolder(
    parentId: string,
    name: string,
    driveId?: string
  ): Promise<string> {
    const q =
      `'${parentId}' in parents and trashed = false and ` +
      `mimeType = 'application/vnd.google-apps.folder' and ` +
      `name = '${escapeDriveQueryValue(name)}'`;
    const params = new URLSearchParams({
      q,
      fields: "files(id,name)",
      pageSize: "1",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (driveId) {
      params.set("corpora", "drive");
      params.set("driveId", driveId);
    }
    const resp = await this.request({
      url: `${DRIVE_API}/files?${params.toString()}`,
      method: "GET",
      headers: await this.authHeader(),
      throw: false,
    });
    this.assertOk(resp, "driveActionSearchSubfolder");
    const existing = (resp.json as { files?: RawDriveFile[] }).files?.[0];
    if (existing) return existing.id;

    // Not found -> create.
    const createResp = await this.request({
      url: `${DRIVE_API}/files?fields=id,name&${SUPPORTS_ALL_DRIVES}`,
      method: "POST",
      headers: {
        ...(await this.authHeader()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
      throw: false,
    });
    this.assertOk(createResp, "driveActionCreateSubfolder");
    return (createResp.json as RawDriveFile).id;
  }

  /**
   * Folder path cache per client instance: relative path -> in-flight/resolved
   * promise of the Drive folder ID. Caching the PROMISE (not the string)
   * deduplicates concurrent creations of the same folder (parallel uploads).
   */
  private folderCache = new Map<string, Promise<string>>();

  /** Clears the folder cache (e.g. at the start of a sync run). */
  clearFolderCache(): void {
    this.folderCache.clear();
  }

  /** Updates the content of an existing file. */
  async updateFile(
    driveId: string,
    path: string,
    content: ArrayBuffer
  ): Promise<DriveFile> {
    const metadata = {
      name: basename(path),
      appProperties: { [PATH_PROP]: path },
    };
    const resp = await this.multipartUpload(
      `${DRIVE_UPLOAD_API}/files/${driveId}?uploadType=multipart&${SUPPORTS_ALL_DRIVES}&fields=${FILE_FIELDS}`,
      "PATCH",
      metadata,
      content
    );
    this.assertOk(resp, "driveActionUpdateFile");
    return this.mapFile(resp.json as RawDriveFile);
  }

  /** Moves a file to the Drive trash (instead of a hard delete). */
  async trashFile(driveId: string): Promise<void> {
    const resp = await this.request({
      url: `${DRIVE_API}/files/${driveId}?fields=id,trashed&${SUPPORTS_ALL_DRIVES}`,
      method: "PATCH",
      headers: {
        ...(await this.authHeader()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
      throw: false,
    });
    this.assertOk(resp, "driveActionTrashFile");
  }

  /**
   * Checks whether a folder ID exists and is a folder (for settings validation).
   * Additionally returns `driveId` (set if the folder lives in a Shared Drive;
   * otherwise empty for "My Drive").
   */
  async getFolder(
    folderId: string
  ): Promise<{ id: string; name: string; driveId: string }> {
    const resp = await this.request({
      url: `${DRIVE_API}/files/${folderId}?fields=id,name,mimeType,driveId&${SUPPORTS_ALL_DRIVES}`,
      method: "GET",
      headers: await this.authHeader(),
      throw: false,
    });
    this.assertOk(resp, "driveActionCheckFolder");
    const json = resp.json as RawDriveFile;
    if (json.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error(t("driveNotAFolder"));
    }
    return { id: json.id, name: json.name, driveId: json.driveId ?? "" };
  }

  /**
   * Searches Drive folders whose name contains the search term (for autocomplete).
   * Empty term -> most recently modified folders. Returns at most `limit` hits.
   */
  async searchFolders(
    query: string,
    limit = 20
  ): Promise<{ id: string; name: string; driveId: string }[]> {
    const clauses = [
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ];
    const q = query.trim();
    if (q) {
      // Escape backslash + single quotes in the search term for the Drive query.
      clauses.push(`name contains '${escapeDriveQueryValue(q)}'`);
    }
    const params = new URLSearchParams({
      q: clauses.join(" and "),
      fields: "files(id,name,driveId)",
      pageSize: String(Math.min(100, limit)),
      orderBy: "modifiedTime desc",
      // Also include folders from Shared Drives in the suggestions.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
    });
    const resp = await this.request({
      url: `${DRIVE_API}/files?${params.toString()}`,
      method: "GET",
      headers: await this.authHeader(),
      throw: false,
    });
    this.assertOk(resp, "driveActionSearchFolder");
    const json = resp.json as { files?: RawDriveFile[] };
    return (json.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      driveId: f.driveId ?? "",
    }));
  }

  /** Creates a new folder under "My Drive" (root) and returns it. */
  async createFolder(name: string): Promise<{ id: string; name: string }> {
    const resp = await this.request({
      url: `${DRIVE_API}/files?fields=id,name`,
      method: "POST",
      headers: {
        ...(await this.authHeader()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
      }),
      throw: false,
    });
    this.assertOk(resp, "driveActionCreateFolder");
    const json = resp.json as RawDriveFile;
    return { id: json.id, name: json.name };
  }

  private async multipartUpload(
    url: string,
    method: "POST" | "PATCH",
    metadata: unknown,
    content: ArrayBuffer
  ) {
    const boundary = "-------obsidian-gdrive-" + Date.now().toString(16);
    const enc = new TextEncoder();

    const head = enc.encode(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);

    const bodyBuf = new Uint8Array(
      head.byteLength + content.byteLength + tail.byteLength
    );
    bodyBuf.set(head, 0);
    bodyBuf.set(new Uint8Array(content), head.byteLength);
    bodyBuf.set(tail, head.byteLength + content.byteLength);

    return this.request({
      url,
      method,
      headers: {
        ...(await this.authHeader()),
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: bodyBuf.buffer,
      throw: false,
    });
  }

  private mapFile(f: RawDriveFile): DriveFile {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTimeMs: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
      md5Checksum: f.md5Checksum,
      size: f.size ? Number(f.size) : undefined,
      trashed: Boolean(f.trashed),
      parents: f.parents,
    };
  }

  private assertOk(
    resp: { status: number; text: string },
    actionKey: MessageKey
  ): void {
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        t("driveApiFailed", {
          action: t(actionKey),
          status: resp.status,
          text: resp.text,
        })
      );
    }
  }
}

interface RawDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  trashed?: boolean;
  parents?: string[];
  appProperties?: Record<string, string>;
  /** Only set if the file/folder lives in a Shared Drive. */
  driveId?: string;
}

/**
 * Escapes a string value for the Google Drive v3 query syntax. The grammar
 * requires backslash as `\\` and single quote as `\'` within a literal —
 * and backslash FIRST, otherwise the backslash produced by the quote escape
 * would be escaped again. Without backslash escaping, a folder name containing
 * `\` breaks the query (e.g. the search doesn't find the folder -> a duplicate is created).
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Directory portion of a path ("" if no folders are included). */
function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** Exponential backoff with slight jitter (ms) for retry attempt `attempt`. */
function backoffMs(attempt: number): number {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  // ±20% jitter to avoid a thundering herd of parallel requests.
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
