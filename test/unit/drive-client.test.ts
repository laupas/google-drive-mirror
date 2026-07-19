/**
 * Unit tests for GoogleDriveClient — HTTP via the mocked requestUrl.
 * Covered: pathOf (relativePath), recursive listing + mapping, pagination,
 * error handling (assertOk), getFolder type guard, query/escaping construction,
 * createFile incl. folder mirroring (ensureFolderPath) and folder cache.
 *
 * Format: AAA.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { requestUrl } from "obsidian";
import { GoogleDriveClient } from "../../src/drive-client";
import { OAuthManager } from "../../src/oauth";

const mockedRequestUrl = vi.mocked(requestUrl);

/** OAuthManager stub that always returns the same token. */
function fakeOAuth(): OAuthManager {
  return {
    getAccessToken: vi.fn().mockResolvedValue("test-token"),
  } as unknown as OAuthManager;
}

function client(): GoogleDriveClient {
  return new GoogleDriveClient(fakeOAuth());
}

/** Successful listFiles response with the given raw files. */
function listResponse(files: unknown[], nextPageToken?: string) {
  return {
    status: 200,
    json: { files, nextPageToken },
    text: "",
  } as unknown;
}

beforeEach(() => {
  mockedRequestUrl.mockReset();
});

describe("GoogleDriveClient.pathOf", () => {
  it("nutzt relativePath (aus der Ordnerkette abgeleitet), wenn vorhanden", () => {
    // Arrange
    const c = client();
    const raw = {
      id: "1",
      name: "flach.md",
      mimeType: "text/markdown",
      relativePath: "unter/ordner/flach.md",
    };

    // Act
    const path = c.pathOf(raw as never);

    // Assert
    expect(path).toBe("unter/ordner/flach.md"); // "under/folder/flat.md"
  });

  it("fällt auf den Dateinamen zurück, wenn relativePath fehlt", () => {
    // Arrange
    const c = client();
    const raw = { id: "1", name: "ohne-pfad.md", mimeType: "text/markdown" };

    // Act
    const path = c.pathOf(raw as never);

    // Assert
    expect(path).toBe("ohne-pfad.md");
  });
});

describe("GoogleDriveClient.listFiles — Mapping", () => {
  it("mappt Roh-Felder korrekt (modifiedTime->ms, size->number, trashed->bool)", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue(
      listResponse([
        {
          id: "abc",
          name: "note.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-01-01T00:00:00.000Z",
          md5Checksum: "hash",
          size: "1234",
          trashed: false,
          parents: ["root"],
        },
      ])
    );

    // Act: root folder contains exactly this file, no subfolders
    // -> exactly one children query.
    const { files } = await c.listFiles("root");

    // Assert: mapped fields plus relativePath (= name at top level).
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      id: "abc",
      name: "note.md",
      mimeType: "text/markdown",
      modifiedTimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
      md5Checksum: "hash",
      size: 1234,
      trashed: false,
      parents: ["root"],
      relativePath: "note.md",
    });
  });

  it("setzt modifiedTimeMs auf 0 und size auf undefined bei fehlenden Feldern", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue(
      listResponse([{ id: "x", name: "n", mimeType: "text/plain" }])
    );

    // Act
    const { files } = await c.listFiles("root");

    // Assert
    expect(files[0].modifiedTimeMs).toBe(0);
    expect(files[0].size).toBeUndefined();
    expect(files[0].trashed).toBe(false);
  });

  it("folgt nextPageToken innerhalb eines Ordners und sammelt alle Dateien", async () => {
    // Arrange: root folder returns two pages, no subfolders.
    const c = client();
    mockedRequestUrl
      .mockResolvedValueOnce(
        listResponse([{ id: "1", name: "a", mimeType: "t" }], "page-2")
      )
      .mockResolvedValueOnce(
        listResponse([{ id: "2", name: "b", mimeType: "t" }])
      );

    // Act
    const { files } = await c.listFiles("root");

    // Assert
    expect(files.map((f) => f.id)).toEqual(["1", "2"]);
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
  });

  it("steigt rekursiv in Unterordner ab und baut den relativen Pfad auf", async () => {
    // Arrange: root contains folder 'sub' + file 'top.md'; 'sub' contains 'inner.md'.
    const c = client();
    mockedRequestUrl
      .mockResolvedValueOnce(
        listResponse([
          {
            id: "sub-id",
            name: "sub",
            mimeType: "application/vnd.google-apps.folder",
          },
          { id: "top", name: "top.md", mimeType: "text/markdown" },
        ])
      )
      .mockResolvedValueOnce(
        listResponse([{ id: "inner", name: "inner.md", mimeType: "text/markdown" }])
      );

    // Act
    const { files, folders } = await c.listFiles("root");

    // Assert: folder itself not treated as a file; nested file with prefix.
    const byId = new Map(files.map((f) => [f.id, f.relativePath]));
    expect(byId.get("top")).toBe("top.md");
    expect(byId.get("inner")).toBe("sub/inner.md");
    expect(files.find((f) => f.id === "sub-id")).toBeUndefined();
    // The subfolder now appears in folders with a relative path.
    expect(folders).toEqual([{ id: "sub-id", relativePath: "sub" }]);
  });

  it("übergibt corpora=drive und driveId, wenn eine driveId angegeben ist", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue(listResponse([]));

    // Act
    await c.listFiles("root", "shared-drive-1");

    // Assert
    const calledUrl = mockedRequestUrl.mock.calls[0][0].url as string;
    expect(calledUrl).toContain("corpora=drive");
    expect(calledUrl).toContain("driveId=shared-drive-1");
  });
});

describe("GoogleDriveClient — Fehlerbehandlung (assertOk)", () => {
  it("wirft bei einem Nicht-2xx-Status mit Status und Aktion in der Meldung", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 403,
      text: "forbidden",
      json: {},
    } as unknown);

    // Act & Assert
    await expect(c.listFiles("root")).rejects.toThrow(/403/);
    await expect(c.listFiles("root")).rejects.toThrow(/forbidden/);
  });
});

describe("GoogleDriveClient.getFolder — Typ-Guard", () => {
  it("liefert id/name/driveId für einen echten Ordner", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        id: "f1",
        name: "Mein Ordner",
        mimeType: "application/vnd.google-apps.folder",
        driveId: "sd1",
      },
      text: "",
    } as unknown);

    // Act
    const folder = await c.getFolder("f1");

    // Assert
    expect(folder).toEqual({ id: "f1", name: "Mein Ordner", driveId: "sd1" });
  });

  it("wirft, wenn die ID kein Ordner ist (falscher mimeType)", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: { id: "f1", name: "datei.md", mimeType: "text/markdown" },
      text: "",
    } as unknown);

    // Act & Assert
    await expect(c.getFolder("f1")).rejects.toThrow(/not a folder/i);
  });

  it("setzt driveId auf leeren String, wenn nicht vorhanden (My Drive)", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        id: "f1",
        name: "Ordner",
        mimeType: "application/vnd.google-apps.folder",
      },
      text: "",
    } as unknown);

    // Act
    const folder = await c.getFolder("f1");

    // Assert
    expect(folder.driveId).toBe("");
  });
});

describe("GoogleDriveClient.searchFolders — Query-Bau", () => {
  it("escaped Hochkommas im Suchbegriff für die Drive-Query", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: { files: [] },
      text: "",
    } as unknown);

    // Act
    await c.searchFolders("O'Brien");

    // Assert: the escaped term appears in the query. URLSearchParams encodes
    // spaces as '+', so convert '+' -> ' ' back before comparing.
    const calledUrl = mockedRequestUrl.mock.calls[0][0].url as string;
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, " ");
    expect(decoded).toContain("name contains 'O\\'Brien'");
  });

  it("escaped Backslashes im Suchbegriff (Backslash zuerst, dann Hochkomma)", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: { files: [] },
      text: "",
    } as unknown);

    // Act: term with backslash and single quote.
    await c.searchFolders("a\\b'c");

    // Assert: backslash -> \\ and ' -> \' (otherwise the query breaks, or a
    // duplicate folder gets created because the existing one isn't found).
    const calledUrl = mockedRequestUrl.mock.calls[0][0].url as string;
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, " ");
    expect(decoded).toContain("name contains 'a\\\\b\\'c'");
  });

  it("lässt die name-contains-Klausel bei leerem Begriff weg", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: { files: [] },
      text: "",
    } as unknown);

    // Act
    await c.searchFolders("   ");

    // Assert
    const decoded = decodeURIComponent(
      mockedRequestUrl.mock.calls[0][0].url as string
    ).replace(/\+/g, " ");
    expect(decoded).not.toContain("name contains");
    expect(decoded).toContain("mimeType = 'application/vnd.google-apps.folder'");
  });
});

describe("GoogleDriveClient.createFile — multipart Upload", () => {
  it("lädt eine Datei ohne Unterordner direkt in den Wurzelordner (nur ein Request)", async () => {
    // Arrange: path without '/' -> no ensureFolderPath lookup, just the upload.
    const c = client();
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        id: "new-id",
        name: "flach.md",
        mimeType: "text/markdown",
        md5Checksum: "h",
      },
      text: "",
    } as unknown);
    const content = new TextEncoder().encode("hallo").buffer;

    // Act
    const result = await c.createFile("root", "flach.md", content);

    // Assert: exactly one request (the upload), parent = root folder.
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
    const call = mockedRequestUrl.mock.calls[0][0];
    expect(call.method).toBe("POST");
    const bodyText = new TextDecoder().decode(call.body as ArrayBuffer);
    expect(bodyText).toContain('"obsidianPath":"flach.md"');
    expect(bodyText).toContain('"name":"flach.md"'); // basename in name
    expect(bodyText).toContain('"parents":["root"]');
    expect(result.id).toBe("new-id");
  });

  it("legt für einen Unterordner-Pfad fehlende Ordner an und lädt dann in den Ordner hoch", async () => {
    // Arrange: path "sub/flach.md". ensureFolderPath searches for 'sub' (not found),
    // creates 'sub', then upload with parents=[sub-folder ID].
    const c = client();
    mockedRequestUrl
      // 1) folder search for 'sub' -> empty (not present)
      .mockResolvedValueOnce({ status: 200, json: { files: [] }, text: "" } as unknown)
      // 2) create folder 'sub' -> returns ID
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "sub-folder-id", name: "sub" },
        text: "",
      } as unknown)
      // 3) file upload
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "file-id", name: "flach.md", mimeType: "text/markdown" },
        text: "",
      } as unknown);
    const content = new TextEncoder().encode("x").buffer;

    // Act
    const result = await c.createFile("root", "sub/flach.md", content);

    // Assert: three requests, upload ends up under the new folder.
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
    const uploadBody = new TextDecoder().decode(
      mockedRequestUrl.mock.calls[2][0].body as ArrayBuffer
    );
    expect(uploadBody).toContain('"parents":["sub-folder-id"]');
    expect(uploadBody).toContain('"obsidianPath":"sub/flach.md"');
    expect(result.id).toBe("file-id");
  });

  it("nutzt den Ordner-Cache und sucht denselben Ordner beim zweiten Upload nicht erneut", async () => {
    // Arrange
    const c = client();
    // First upload: find folder 'sub' (present) + upload.
    mockedRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: { files: [{ id: "sub-id", name: "sub" }] },
        text: "",
      } as unknown)
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "f1", name: "a.md", mimeType: "t" },
        text: "",
      } as unknown)
      // Second upload: NO more folder search (cache), just upload.
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "f2", name: "b.md", mimeType: "t" },
        text: "",
      } as unknown);
    const content = new TextEncoder().encode("x").buffer;

    // Act
    await c.createFile("root", "sub/a.md", content);
    await c.createFile("root", "sub/b.md", content);

    // Assert: 2 (first: search+upload) + 1 (second: upload only) = 3 requests.
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
  });
});

describe("GoogleDriveClient — retry with backoff", () => {
  /** Response helper. */
  const resp = (status: number, json: unknown = {}) =>
    ({ status, json, text: "", arrayBuffer: new ArrayBuffer(0) }) as never;

  it("retries a 429 and then succeeds", async () => {
    // Arrange: first 429, then 200. Fake timers so the backoff sleep resolves
    // instantly. downloadFile has no mimeType check -> simplest success path.
    vi.useFakeTimers();
    let n = 0;
    const requestImpl = vi.fn(async () => {
      n++;
      return n === 1 ? resp(429) : resp(200);
    });
    const c = new GoogleDriveClient(fakeOAuth(), requestImpl as never);

    // Act
    const p = c.downloadFile("x");
    await vi.runAllTimersAsync();
    await p;

    // Assert: called twice (429 -> retry -> 200).
    expect(requestImpl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does NOT retry a deterministic 404", async () => {
    // Arrange
    const requestImpl = vi.fn(async () => resp(404));
    const c = new GoogleDriveClient(fakeOAuth(), requestImpl as never);

    // Act + Assert: fails immediately, only one request.
    await expect(c.downloadFile("x")).rejects.toThrow();
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_RETRIES on persistent 500", async () => {
    // Arrange
    vi.useFakeTimers();
    const requestImpl = vi.fn(async () => resp(500));
    const c = new GoogleDriveClient(fakeOAuth(), requestImpl as never);

    // Act
    const p = c.downloadFile("x").catch((e) => e);
    await vi.runAllTimersAsync();
    await p;

    // Assert: 1 initial + 4 retries = 5 attempts.
    expect(requestImpl).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });
});
