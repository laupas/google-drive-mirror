/**
 * Unit-Tests für GoogleDriveClient — HTTP über den gemockten requestUrl.
 * Geprüft: pathOf (relativePath), rekursives Listing + Mapping, Pagination,
 * Fehlerbehandlung (assertOk), getFolder-Typ-Guard, Query-/Escaping-Bau,
 * createFile inkl. Ordner-Mirroring (ensureFolderPath) und Ordner-Cache.
 *
 * Format: AAA.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { requestUrl } from "obsidian";
import { GoogleDriveClient } from "../../src/drive-client";
import { OAuthManager } from "../../src/oauth";

const mockedRequestUrl = vi.mocked(requestUrl);

/** OAuthManager-Stub, der immer denselben Token liefert. */
function fakeOAuth(): OAuthManager {
  return {
    getAccessToken: vi.fn().mockResolvedValue("test-token"),
  } as unknown as OAuthManager;
}

function client(): GoogleDriveClient {
  return new GoogleDriveClient(fakeOAuth());
}

/** Erfolgreiche listFiles-Antwort mit gegebenen Roh-Dateien. */
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
    expect(path).toBe("unter/ordner/flach.md");
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

    // Act: Wurzelordner enthält genau diese Datei, keine Unterordner
    // -> genau eine Kinder-Abfrage.
    const { files } = await c.listFiles("root");

    // Assert: gemappte Felder plus relativePath (= name auf oberster Ebene).
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
    // Arrange: Wurzelordner liefert zwei Seiten, keine Unterordner.
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
    // Arrange: root enthält Ordner 'sub' + Datei 'top.md'; 'sub' enthält 'inner.md'.
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

    // Assert: Ordner selbst nicht als Datei; verschachtelte Datei mit Prefix.
    const byId = new Map(files.map((f) => [f.id, f.relativePath]));
    expect(byId.get("top")).toBe("top.md");
    expect(byId.get("inner")).toBe("sub/inner.md");
    expect(files.find((f) => f.id === "sub-id")).toBeUndefined();
    // Der Unterordner erscheint jetzt in folders mit relativem Pfad.
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

    // Assert: der escapte Begriff steht in der Query. URLSearchParams kodiert
    // Leerzeichen als '+', daher vor dem Vergleich '+' -> ' ' zurückwandeln.
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

    // Act: Begriff mit Backslash und Hochkomma.
    await c.searchFolders("a\\b'c");

    // Assert: Backslash -> \\ und ' -> \' (sonst bricht die Query bzw. wird
    // ein Duplikat-Ordner angelegt, weil der bestehende nicht gefunden wird).
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
    // Arrange: Pfad ohne '/' -> kein ensureFolderPath-Lookup, nur der Upload.
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

    // Assert: genau ein Request (der Upload), Parent = Wurzelordner.
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
    // Arrange: Pfad "sub/flach.md". ensureFolderPath sucht 'sub' (nicht gefunden),
    // legt 'sub' an, dann Upload mit parents=[sub-Ordner-ID].
    const c = client();
    mockedRequestUrl
      // 1) Ordnersuche nach 'sub' -> leer (nicht vorhanden)
      .mockResolvedValueOnce({ status: 200, json: { files: [] }, text: "" } as unknown)
      // 2) Ordner 'sub' anlegen -> ID zurück
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "sub-folder-id", name: "sub" },
        text: "",
      } as unknown)
      // 3) Datei-Upload
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "file-id", name: "flach.md", mimeType: "text/markdown" },
        text: "",
      } as unknown);
    const content = new TextEncoder().encode("x").buffer;

    // Act
    const result = await c.createFile("root", "sub/flach.md", content);

    // Assert: drei Requests, Upload landet unter dem neuen Ordner.
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
    // Erster Upload: Ordner 'sub' finden (vorhanden) + Upload.
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
      // Zweiter Upload: KEINE Ordnersuche mehr (Cache), nur Upload.
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "f2", name: "b.md", mimeType: "t" },
        text: "",
      } as unknown);
    const content = new TextEncoder().encode("x").buffer;

    // Act
    await c.createFile("root", "sub/a.md", content);
    await c.createFile("root", "sub/b.md", content);

    // Assert: 2 (erster: Suche+Upload) + 1 (zweiter: nur Upload) = 3 Requests.
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
  });
});
