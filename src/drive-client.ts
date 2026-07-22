import { Platform, requestUrl } from "obsidian";
import { DriveFile, DriveFolder } from "./types";
import { OAuthManager } from "./oauth";
import { MessageKey, t } from "./i18n";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** appProperties key under which the vault-relative path is stored. */
const PATH_PROP = "obsidianPath";

// NOTE: `appProperties` is deliberately NOT requested. It stores the legacy
// obsidianPath fallback (still WRITTEN on upload), but the listing derives paths
// from the actual folder structure and never reads it back — requesting it only
// bloated every response page (extra parse memory during the large-Drive fetch).
// `parents` IS kept: the Shared-Drive flat listing (buildSubtree) needs it to
// rebuild the folder hierarchy.
const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,md5Checksum,size,trashed,parents,driveId";

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

/**
 * How many folders are listed concurrently during the recursive (BFS) listing.
 * The listing is latency-bound (one round-trip per folder), so on a large Drive
 * a strictly sequential BFS spends minutes waiting. Fanning out per level with a
 * bounded pool cuts the wall-clock roughly by this factor. Drive's per-user
 * limit is ~120 queries/s; at ~300 ms latency, 16 in-flight is ~50 req/s — well
 * under the cap, and the request wrapper still retries any 429s with backoff.
 */
const LIST_CONCURRENCY = 16;
/**
 * Default listing fan-out on mobile. Each concurrent `listChildren` holds a
 * parsed response page (up to 1000 file records) in memory; 16 in flight on a
 * large Drive pushed the iOS WebView past its memory ceiling and OOM-killed it
 * during the "Fetching Google Drive" phase. Fewer in-flight pages = a lower
 * peak. Now user-configurable (`settings.mobileListConcurrency`); this is the
 * fallback default.
 */
const LIST_CONCURRENCY_MOBILE = 4;

/**
 * Default listing fan-out for the current platform (used when the client is
 * constructed without an explicit provider — e.g. in tests). Desktop has no
 * memory pressure, so it uses the higher fixed value.
 */
function defaultListConcurrency(): number {
  return Platform.isMobile ? LIST_CONCURRENCY_MOBILE : LIST_CONCURRENCY;
}

/** Live progress of a recursive `listFiles` run, reported per folder level. */
export interface ListProgress {
  /** Number of subfolders discovered so far. */
  foldersScanned: number;
  /** Number of files discovered so far. */
  filesFound: number;
}

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
  // IMPORTANT: every representation must be LAZY (accessed only when a caller
  // reads it). Two reasons:
  //   1. `.json` JSON.parses the body; on mobile, touching it for a BINARY
  //      download (?alt=media returns raw bytes) throws "JSON Parse error:
  //      Unrecognized token" and every download fails.
  //   2. Memory: `resp.text` (UTF-16 string) and `resp.arrayBuffer` each
  //      materialize the WHOLE body. The Drive listing reads only `.json` over
  //      thousands of folder requests (16 concurrent); eagerly reading `text`
  //      AND `arrayBuffer` there pinned ~3 copies of every response body at
  //      once and blew the iOS WebView memory budget. As getters, a listing
  //      response now materializes only the parsed JSON, not all three.
  return {
    status: resp.status,
    get text() {
      return resp.text;
    },
    get json() {
      return resp.json;
    },
    get arrayBuffer() {
      return resp.arrayBuffer;
    },
  };
};

export class GoogleDriveClient {
  /**
   * @param oauth    Token provider.
   * @param requestImpl  HTTP implementation (default: Obsidian's requestUrl).
   *                     Injectable so tests can verify retry/backoff.
   * @param listConcurrencyFn  Returns how many Drive folders to list in
   *                     parallel during the fetch phase. Injected from settings
   *                     (mobile value is user-configurable). Defaults to the
   *                     per-platform value.
   */
  constructor(
    private oauth: OAuthManager,
    private requestImpl: RequestFn = defaultRequestImpl,
    private listConcurrencyFn: () => number = defaultListConcurrency
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
    driveId?: string,
    onProgress?: (progress: ListProgress) => void,
    onFile?: (file: DriveFile) => void | Promise<void>
  ): Promise<{ files: DriveFile[]; folders: DriveFolder[] }> {
    // Shared Drive: list the WHOLE drive in one paginated query (no parent
    // filter) and rebuild the subtree locally. This turns thousands of
    // per-folder round-trips into total_items/1000 requests — the dominant win
    // on a large drive. Only safe for a Shared Drive, where corpora=drive scopes
    // the query to exactly that drive; on My Drive a parent-less query would
    // return the entire account, so My Drive keeps the BFS below.
    //
    // `onFile`: when provided, each file is streamed to the callback (AWAITED,
    // so the callback can apply backpressure) and NOT accumulated in the
    // returned `files` array (which stays empty). The caller writes each record
    // to its remote store (IndexedDB on mobile) one at a time instead of holding
    // the whole listing in memory (iOS OOM guard on large Drives). Folders are
    // always returned in-memory (needed for BFS traversal; far fewer than files).
    if (driveId) {
      return this.listFilesFlat(rootFolderId, driveId, onProgress, onFile);
    }
    return this.listFilesBfs(rootFolderId, onProgress, onFile);
  }

  /**
   * BFS listing for My Drive: one query per folder, siblings listed with bounded
   * concurrency per level. Deterministic order (preserves input order per level).
   */
  private async listFilesBfs(
    rootFolderId: string,
    onProgress?: (progress: ListProgress) => void,
    onFile?: (file: DriveFile) => void | Promise<void>
  ): Promise<{ files: DriveFile[]; folders: DriveFolder[] }> {
    // When `onFile` is provided, files are streamed to it and not accumulated
    // (the returned `files` stays empty) — see listFiles(). `fileCount` tracks
    // the number seen either way, for progress reporting.
    const files: DriveFile[] = [];
    const folders: DriveFolder[] = [];
    let fileCount = 0;
    // AWAIT onFile: this gives the consumer (the engine writing each record to
    // IndexedDB during the fetch) natural backpressure — the folder worker
    // pauses until the record is persisted, so un-awaited puts can't pile up in
    // memory and defeat the whole point.
    const emitFile = async (file: DriveFile): Promise<void> => {
      fileCount++;
      if (onFile) await onFile(file);
      else files.push(file);
    };
    // Breadth-first search over the folder hierarchy. Each level is listed with
    // bounded concurrency: the listing is latency-bound (one round-trip per
    // folder), so listing siblings in parallel is the dominant speed-up on a
    // large Drive. Descendants discovered in a level form the next level.
    //
    // MEMORY (mobile/iOS): each folder's children are reduced into
    // files/folders/nextLevel AS SOON AS its listChildren resolves, and the raw
    // response page is dropped immediately. We deliberately do NOT collect the
    // whole level's raw child arrays first (the previous mapPool approach held
    // every folder-in-level's parsed page at once) — on a wide level that peak,
    // plus the concurrent response bodies, OOM-killed the WebView. Streaming +
    // lower mobile concurrency keeps only the growing output resident.
    let level: { id: string; prefix: string }[] = [
      { id: rootFolderId, prefix: "" },
    ];
    // Clamp defensively: at least 1 (0 would stall the pool), capped so a
    // misconfigured huge value can't reintroduce the memory blow-up.
    const concurrency = Math.max(
      1,
      Math.min(this.listConcurrencyFn(), LIST_CONCURRENCY)
    );

    // Throttle progress reporting. Emitting per folder fires thousands of
    // status updates (each re-renders the status bar) on a large Drive — that
    // overhead measurably slowed the fetch. Report at most ~twice a second; the
    // final counts are emitted once after the loop.
    let lastProgressMs = 0;
    const reportProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastProgressMs < 500) return;
      lastProgressMs = now;
      onProgress?.({ foldersScanned: folders.length, filesFound: fileCount });
    };

    while (level.length > 0) {
      const nextLevel: { id: string; prefix: string }[] = [];
      await forEachPool(level, concurrency, async ({ id, prefix }) => {
        const children = await this.listChildren(id, undefined);
        for (const f of children) {
          const relativePath = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.mimeType === FOLDER_MIME) {
            if (f.trashed) continue;
            folders.push({ id: f.id, relativePath });
            nextLevel.push({ id: f.id, prefix: relativePath });
          } else {
            await emitFile({ ...this.mapFile(f), relativePath });
          }
        }
        reportProgress();
      });
      // Note: order within a level is no longer strictly input-order (folders
      // are reduced as they complete). relativePath is derived per item from its
      // own prefix, so paths stay correct; only the array order can vary, which
      // the reconciler (keyed by relativePath) does not depend on.
      level = nextLevel;
    }
    reportProgress(true); // final counts
    return { files, folders };
  }

  /**
   * Flat listing for a Shared Drive: pull EVERY (non-trashed) item in the drive
   * in pages of 1000, then rebuild the subtree rooted at `rootFolderId` locally
   * from each item's `parents`. Produces the SAME { files, folders } (same
   * relativePaths, same exclusion of anything outside the sync root) as the BFS,
   * but with total_items/1000 requests instead of one per folder.
   */
  private async listFilesFlat(
    rootFolderId: string,
    driveId: string,
    onProgress?: (progress: ListProgress) => void,
    onFile?: (file: DriveFile) => void | Promise<void>
  ): Promise<{ files: DriveFile[]; folders: DriveFolder[] }> {
    // 1) Fetch all items in the drive, reporting progress per page.
    const all: RawDriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: "trashed = false",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "drive",
        driveId,
      });
      if (pageToken) params.set("pageToken", pageToken);

      const resp = await this.request({
        url: `${DRIVE_API}/files?${params.toString()}`,
        method: "GET",
        headers: await this.authHeader(),
        throw: false,
      });
      this.assertOk(resp, "driveActionListFiles");
      const json = resp.json as {
        files?: RawDriveFile[];
        nextPageToken?: string;
      };
      all.push(...(json.files ?? []));
      pageToken = json.nextPageToken;
      // Progress during the fetch: we don't yet know the tree, so report the
      // raw item count as "files found" (folders resolved in step 2).
      onProgress?.({ foldersScanned: 0, filesFound: all.length });
    } while (pageToken);

    // 2) Rebuild the subtree rooted at rootFolderId from the parent links.
    //    buildSubtree is synchronous, so it can't await an async onFile. When
    //    onFile is provided, let buildSubtree collect files, then stream them to
    //    onFile here with backpressure (await each) and return an empty files
    //    array — matching the BFS contract.
    if (onFile) {
      const built = buildSubtree(all, rootFolderId, onProgress);
      for (const f of built.files) await onFile(f);
      return { files: [], folders: built.folders };
    }
    return buildSubtree(all, rootFolderId, onProgress);
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
    return mapRawFile(f);
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

/** Drive mime type of a folder. */
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Maps a raw Drive API file to the internal DriveFile shape (pure). */
function mapRawFile(f: RawDriveFile): DriveFile {
  // Keep only what the reconciler / engine actually read downstream. `parents`
  // and `trashed` are intentionally NOT retained: `trashed` is filtered on the
  // raw item before mapping, and `parents` is used only transiently by the
  // Shared-Drive subtree rebuild (on the raw item), never on a mapped DriveFile.
  // Dropping them removes an array + a boolean per file across thousands of
  // files — less resident memory and less allocation churn during the fetch.
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTimeMs: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    md5Checksum: f.md5Checksum,
    size: f.size ? Number(f.size) : undefined,
  };
}

/**
 * Rebuilds the subtree rooted at `rootFolderId` from a FLAT list of drive items,
 * using each item's `parents` to reconstruct the hierarchy. Walks breadth-first
 * from the root so the output order matches the per-folder BFS listing exactly:
 * for each folder, its direct children (in list order) before descending.
 *
 * Anything not reachable from `rootFolderId` (outside the sync subtree, or an
 * orphan whose parent chain doesn't lead to root) is simply not visited, hence
 * excluded — the same result the BFS would produce, and crucially NOT treated as
 * a deletion by the reconciler.
 *
 * Exported for unit testing (this is on the deletion-safety-critical path).
 */
export function buildSubtree(
  items: RawDriveFile[],
  rootFolderId: string,
  onProgress?: (progress: ListProgress) => void
): { files: DriveFile[]; folders: DriveFolder[] } {
  const files: DriveFile[] = [];
  const folders: DriveFolder[] = [];
  let fileCount = 0;
  const emitFile = (file: DriveFile): void => {
    fileCount++;
    files.push(file);
  };

  // Index children by their (first) parent id, preserving input order.
  const childrenByParent = new Map<string, RawDriveFile[]>();
  for (const it of items) {
    const parent = it.parents?.[0];
    if (parent === undefined) continue;
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(it);
    else childrenByParent.set(parent, [it]);
  }

  // BFS from the root, mirroring listFilesBfs: emit folders + descend, collect
  // files with their accumulated relativePath.
  let level: { id: string; prefix: string }[] = [
    { id: rootFolderId, prefix: "" },
  ];
  while (level.length > 0) {
    const nextLevel: { id: string; prefix: string }[] = [];
    for (const { id, prefix } of level) {
      const children = childrenByParent.get(id) ?? [];
      for (const f of children) {
        const relativePath = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
          // trashed items are already filtered out by the query, but stay
          // defensive in case a caller passes an unfiltered list.
          if (f.trashed) continue;
          folders.push({ id: f.id, relativePath });
          nextLevel.push({ id: f.id, prefix: relativePath });
        } else {
          emitFile({ ...mapRawFile(f), relativePath });
        }
      }
    }
    onProgress?.({ foldersScanned: folders.length, filesFound: fileCount });
    level = nextLevel;
  }

  return { files, folders };
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

/**
 * Runs `worker` over `items` with a bounded number of concurrent invocations,
 * returning the results in the SAME order as the input (result[i] is the result
 * for items[i]), regardless of completion order. Used to fan out folder listings
 * during the recursive Drive listing. Exported for unit testing.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const n = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        // Each runner pulls the next index until the queue is drained,
        // writing to the result slot for that index (order-preserving).
        while (next < items.length) {
          const idx = next++;
          results[idx] = await worker(items[idx]);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * Like `mapPool`, but does NOT collect return values — the worker consumes each
 * item's result as it completes (via its own side effects). This keeps memory
 * bounded: nothing is retained across items, unlike `mapPool`'s full results
 * array. Used by the BFS listing to reduce each folder's children immediately
 * instead of holding a whole level's parsed pages. Bounded concurrency; every
 * item runs exactly once. Order of completion is not guaranteed.
 *
 * Exported for unit testing.
 */
export async function forEachPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        while (next < items.length) {
          const idx = next++;
          await worker(items[idx]);
        }
      })()
    );
  }
  await Promise.all(runners);
}
