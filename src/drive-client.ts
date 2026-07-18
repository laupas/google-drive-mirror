import { requestUrl } from "obsidian";
import { DriveFile, DriveFolder } from "./types";
import { OAuthManager } from "./oauth";
import { MessageKey, t } from "./i18n";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** appProperties-Schlüssel, unter dem der vault-relative Pfad gespeichert wird. */
const PATH_PROP = "obsidianPath";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,md5Checksum,size,trashed,parents,appProperties,driveId";

/**
 * Für Shared Drives (Team Drives) müssen alle Requests supportsAllDrives=true
 * setzen. Bei normalem "My Drive" ist der Parameter unschädlich, daher immer an.
 */
const SUPPORTS_ALL_DRIVES = "supportsAllDrives=true";

/**
 * Dünner Wrapper über die Google-Drive-REST-API (v3).
 *
 * Design: Statt die Vault-Ordnerhierarchie in Drive zu spiegeln, wird der
 * vollständige vault-relative Pfad in appProperties[obsidianPath] abgelegt.
 * Alle Sync-Dateien liegen flach im konfigurierten Drive-Wurzelordner.
 * Das eliminiert fehleranfällige Ordner-Reconciliation und Umbenennungs-Edge-Cases.
 */
export class GoogleDriveClient {
  constructor(private oauth: OAuthManager) {}

  private async authHeader(): Promise<Record<string, string>> {
    const token = await this.oauth.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Listet alle (nicht-gelöschten und gelöschten) Dateien im Wurzelordner.
   * Inklusive im Papierkorb liegender Dateien, damit der Reconciler
   * Löschungen erkennen kann.
   */
  /**
   * Listet **rekursiv** alle Dateien unter dem Wurzelordner. Steigt in alle
   * Unterordner ab und setzt bei jeder Datei `relativePath` = Pfad relativ zum
   * Wurzelordner (aus der Ordnerkette abgeleitet, z.B. "sub/notiz.md"). So
   * werden auch manuell in Drive angelegte Unterordner/Dateien korrekt erfasst.
   */
  async listFiles(
    rootFolderId: string,
    driveId?: string
  ): Promise<{ files: DriveFile[]; folders: DriveFolder[] }> {
    const files: DriveFile[] = [];
    const folders: DriveFolder[] = [];
    // Breitensuche über die Ordnerhierarchie.
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
          // Ordner selbst als eigener Eintrag ausgeben UND rekursiv absteigen.
          folders.push({ id: f.id, relativePath });
          queue.push({ id: f.id, prefix: relativePath });
        } else {
          files.push({ ...this.mapFile(f), relativePath });
        }
      }
    }
    return { files, folders };
  }

  /** Listet die direkten Kinder eines Ordners (mit Paginierung). */
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

      const resp = await requestUrl({
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

  /** Liefert den vault-relativen Pfad einer Drive-Datei. */
  pathOf(f: DriveFile): string {
    return f.relativePath ?? f.name;
  }

  /** Lädt den Binärinhalt einer Datei herunter. */
  async downloadFile(driveId: string): Promise<ArrayBuffer> {
    const resp = await requestUrl({
      url: `${DRIVE_API}/files/${driveId}?alt=media&${SUPPORTS_ALL_DRIVES}`,
      method: "GET",
      headers: await this.authHeader(),
      throw: false,
    });
    this.assertOk(resp, "driveActionDownloadFile");
    return resp.arrayBuffer;
  }

  /**
   * Erstellt eine neue Datei unter dem Wurzelordner. Legt fehlende
   * Zwischenordner (aus dem Pfad, z.B. "sub/a/notiz.md") in Drive an, damit die
   * Ordnerstruktur des Vaults gespiegelt wird.
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
   * Stellt sicher, dass die Ordnerkette zum Datei-Pfad in Drive existiert und
   * liefert die ID des direkten Elternordners. Legt fehlende Ordner an.
   * Nutzt einen Cache, um wiederholte Lookups innerhalb eines Sync-Laufs zu sparen.
   */
  private async ensureFolderPath(
    rootFolderId: string,
    filePath: string,
    driveId?: string
  ): Promise<string> {
    const dir = dirname(filePath);
    if (!dir) return rootFolderId;

    let parentId = rootFolderId;
    let accumulated = "";
    for (const segment of dir.split("/")) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const cached = this.folderCache.get(accumulated);
      if (cached) {
        parentId = cached;
        continue;
      }
      parentId = await this.findOrCreateChildFolder(parentId, segment, driveId);
      this.folderCache.set(accumulated, parentId);
    }
    return parentId;
  }

  /**
   * Stellt sicher, dass der Ordner unter `relativePath` in Drive existiert
   * (inkl. aller Zwischenordner). Für das Anlegen (auch leerer) Ordner.
   * Gibt die Drive-ID des Zielordners zurück.
   */
  async createFolderPath(
    rootFolderId: string,
    relativePath: string,
    driveId?: string
  ): Promise<string> {
    let parentId = rootFolderId;
    let accumulated = "";
    for (const segment of relativePath.split("/")) {
      if (!segment) continue;
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const cached = this.folderCache.get(accumulated);
      if (cached) {
        parentId = cached;
        continue;
      }
      parentId = await this.findOrCreateChildFolder(parentId, segment, driveId);
      this.folderCache.set(accumulated, parentId);
    }
    return parentId;
  }

  /** Verschiebt einen Ordner (mit Inhalt) in den Drive-Papierkorb. */
  async trashFolder(folderId: string): Promise<void> {
    // Gleiche Semantik wie trashFile — Drive trasht Ordner samt Inhalt.
    await this.trashFile(folderId);
  }

  /** Sucht einen Unterordner nach Namen; legt ihn an, falls nicht vorhanden. */
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
    const resp = await requestUrl({
      url: `${DRIVE_API}/files?${params.toString()}`,
      method: "GET",
      headers: await this.authHeader(),
      throw: false,
    });
    this.assertOk(resp, "driveActionSearchSubfolder");
    const existing = (resp.json as { files?: RawDriveFile[] }).files?.[0];
    if (existing) return existing.id;

    // Nicht gefunden -> anlegen.
    const createResp = await requestUrl({
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

  /** Ordner-Pfad-Cache pro Client-Instanz (relativer Pfad -> Drive-Ordner-ID). */
  private folderCache = new Map<string, string>();

  /** Leert den Ordner-Cache (z.B. zu Beginn eines Sync-Laufs). */
  clearFolderCache(): void {
    this.folderCache.clear();
  }

  /** Aktualisiert den Inhalt einer bestehenden Datei. */
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

  /** Verschiebt eine Datei in den Drive-Papierkorb (statt harter Löschung). */
  async trashFile(driveId: string): Promise<void> {
    const resp = await requestUrl({
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
   * Prüft, ob eine Ordner-ID existiert und ein Ordner ist (für Settings-Validierung).
   * Liefert zusätzlich `driveId` (gesetzt, wenn der Ordner in einem Shared Drive
   * liegt; sonst leer für "My Drive").
   */
  async getFolder(
    folderId: string
  ): Promise<{ id: string; name: string; driveId: string }> {
    const resp = await requestUrl({
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
   * Sucht Drive-Ordner, deren Name den Suchbegriff enthält (für Autocomplete).
   * Leerer Begriff -> zuletzt geänderte Ordner. Liefert höchstens `limit` Treffer.
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
      // Backslash + Hochkommas im Suchbegriff für die Drive-Query escapen.
      clauses.push(`name contains '${escapeDriveQueryValue(q)}'`);
    }
    const params = new URLSearchParams({
      q: clauses.join(" and "),
      fields: "files(id,name,driveId)",
      pageSize: String(Math.min(100, limit)),
      orderBy: "modifiedTime desc",
      // Auch Ordner aus Shared Drives in die Vorschläge aufnehmen.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
    });
    const resp = await requestUrl({
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

  /** Erstellt einen neuen Ordner unter "My Drive" (root) und gibt ihn zurück. */
  async createFolder(name: string): Promise<{ id: string; name: string }> {
    const resp = await requestUrl({
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

    return requestUrl({
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
  /** Nur gesetzt, wenn die Datei/der Ordner in einem Shared Drive liegt. */
  driveId?: string;
}

/**
 * Escaped einen String-Wert für die Google-Drive-v3-Query-Syntax. Die Grammatik
 * verlangt Backslash als `\\` und Hochkomma als `\'` innerhalb eines Literals —
 * und zwar Backslash ZUERST, sonst würde der aus dem Quote-Escape erzeugte
 * Backslash erneut escaped. Ohne Backslash-Escaping bricht ein Ordnername mit
 * `\` die Query (z.B. Suche findet den Ordner nicht -> Duplikat wird angelegt).
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Verzeichnisanteil eines Pfads ("" wenn keine Ordner enthalten). */
function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}
