/**
 * Unit tests for GoogleDriveClient — HTTP via the mocked requestUrl.
 * Covered: pathOf (relativePath), recursive listing + mapping, pagination,
 * error handling (assertOk), getFolder type guard, query/escaping construction,
 * createFile incl. folder mirroring (ensureFolderPath) and folder cache.
 *
 * Format: AAA.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requestUrl } from "obsidian";
import { GoogleDriveClient, mapPool, buildSubtree } from "../../src/drive-client";
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

/**
 * Parent-aware mock: given a tree keyed by parent folder id, returns a
 * requestUrl implementation that parses the queried parent ids from the URL
 * (the BFS batches many via `'id' in parents or …`) and returns the UNION of
 * those parents' children — each child carrying `parents: [parentId]`, exactly
 * as real Drive does, so the batched attribution can place them. This exercises
 * the multi-parent batching realistically.
 */
function treeMock(tree: Record<string, unknown[]>) {
  return (params: { url: string }) => {
    const url = decodeURIComponent(params.url).replace(/\+/g, " ");
    const files: unknown[] = [];
    for (const [parent, children] of Object.entries(tree)) {
      if (url.includes(`'${parent}' in parents`)) {
        for (const c of children) {
          files.push({ ...(c as object), parents: [parent] });
        }
      }
    }
    return Promise.resolve(listResponse(files)) as never;
  };
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
      relativePath: "note.md",
    });
  });

  it("setzt modifiedTimeMs auf 0 und size auf undefined bei fehlenden Feldern", async () => {
    // Arrange
    const c = client();
    mockedRequestUrl.mockImplementation(
      treeMock({ root: [{ id: "x", name: "n", mimeType: "text/plain" }] })
    );

    // Act
    const { files } = await c.listFiles("root");

    // Assert
    expect(files[0].modifiedTimeMs).toBe(0);
    expect(files[0].size).toBeUndefined();
  });

  it("folgt nextPageToken innerhalb eines Ordners und sammelt alle Dateien", async () => {
    // Arrange: root folder returns two pages, no subfolders.
    const c = client();
    mockedRequestUrl
      .mockResolvedValueOnce(
        listResponse(
          [{ id: "1", name: "a", mimeType: "t", parents: ["root"] }],
          "page-2"
        )
      )
      .mockResolvedValueOnce(
        listResponse([{ id: "2", name: "b", mimeType: "t", parents: ["root"] }])
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
    mockedRequestUrl.mockImplementation(
      treeMock({
        root: [
          {
            id: "sub-id",
            name: "sub",
            mimeType: "application/vnd.google-apps.folder",
          },
          { id: "top", name: "top.md", mimeType: "text/markdown" },
        ],
        "sub-id": [
          { id: "inner", name: "inner.md", mimeType: "text/markdown" },
        ],
      })
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

describe("GoogleDriveClient.listFiles — batched parent listing", () => {
  it("lists sibling subfolders in ONE batched query and attributes by parent", async () => {
    // Root has two subfolders 'a' and 'b'. With batching, a whole level's
    // folders are queried in a single request `('a' in parents or 'b' in
    // parents ...)`, and each returned item is attributed to its parent via
    // `parents`. So level 1 (a + b) is ONE request, not two.
    const c = client();
    let level1Requests = 0;
    mockedRequestUrl.mockImplementation((params: { url: string }) => {
      const url = decodeURIComponent(params.url).replace(/\+/g, " ");
      if (url.includes("'root' in parents")) {
        return Promise.resolve(
          listResponse([
            {
              id: "a",
              name: "a",
              mimeType: "application/vnd.google-apps.folder",
              parents: ["root"],
            },
            {
              id: "b",
              name: "b",
              mimeType: "application/vnd.google-apps.folder",
              parents: ["root"],
            },
          ])
        ) as never;
      }
      // Level 1: both 'a' and 'b' come in ONE query.
      const inA = url.includes("'a' in parents");
      const inB = url.includes("'b' in parents");
      if (inA || inB) {
        level1Requests++;
        const files: unknown[] = [];
        if (inA)
          files.push({
            id: "fa",
            name: "in-a.md",
            mimeType: "text/markdown",
            parents: ["a"],
          });
        if (inB)
          files.push({
            id: "fb",
            name: "in-b.md",
            mimeType: "text/markdown",
            parents: ["b"],
          });
        return Promise.resolve(listResponse(files)) as never;
      }
      return Promise.resolve(listResponse([])) as never;
    });

    // Act
    const { files } = await c.listFiles("root");

    // Assert: both leaf files collected & correctly attributed; level 1 was a
    // SINGLE batched request (not one per folder).
    expect(level1Requests).toBe(1);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      "a/in-a.md",
      "b/in-b.md",
    ]);
  });

  it("reports cumulative progress once per folder level via onProgress", async () => {
    // Arrange: root has folder 'sub' + file 'top.md'; 'sub' has 'inner.md'.
    const c = client();
    mockedRequestUrl.mockImplementation(
      treeMock({
        root: [
          {
            id: "sub-id",
            name: "sub",
            mimeType: "application/vnd.google-apps.folder",
          },
          { id: "top", name: "top.md", mimeType: "text/markdown" },
        ],
        "sub-id": [
          { id: "inner", name: "inner.md", mimeType: "text/markdown" },
        ],
      })
    );
    const progress: { foldersScanned: number; filesFound: number }[] = [];

    // Act
    await c.listFiles("root", undefined, (p) => progress.push({ ...p }));

    // Assert: progress is reported (throttled), counts are monotonic, and the
    // FINAL callback carries the complete totals (1 folder, 2 files).
    expect(progress.length).toBeGreaterThan(0);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].foldersScanned).toBeGreaterThanOrEqual(
        progress[i - 1].foldersScanned
      );
      expect(progress[i].filesFound).toBeGreaterThanOrEqual(
        progress[i - 1].filesFound
      );
    }
    expect(progress[progress.length - 1]).toEqual({
      foldersScanned: 1,
      filesFound: 2,
    });
  });

  it("chunks a wide level into multiple batched queries and attributes every child", async () => {
    // 120 sibling folders under root (> LIST_PARENTS_PER_QUERY=50), each with one
    // file. Must be split into ceil(120/50)=3 batched queries for level 1, and
    // every file attributed to the right parent.
    const c = client();
    const N = 120;
    const tree: Record<string, unknown[]> = {
      root: Array.from({ length: N }, (_, i) => ({
        id: `d${i}`,
        name: `d${i}`,
        mimeType: "application/vnd.google-apps.folder",
      })),
    };
    for (let i = 0; i < N; i++) {
      tree[`d${i}`] = [{ id: `f${i}`, name: `f${i}.md`, mimeType: "text/markdown" }];
    }
    let level1Requests = 0;
    mockedRequestUrl.mockImplementation((params: { url: string }) => {
      const url = decodeURIComponent(params.url).replace(/\+/g, " ");
      if (!url.includes("'root' in parents")) level1Requests++;
      return treeMock(tree)(params);
    });

    // Act
    const { files, folders } = await c.listFiles("root");

    // Assert: all folders + files found, correctly pathed; level 1 batched into
    // 3 requests (not 120).
    expect(folders).toHaveLength(N);
    expect(files).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(files.find((f) => f.relativePath === `d${i}/f${i}.md`)).toBeTruthy();
    }
    expect(level1Requests).toBe(Math.ceil(N / 50));
  });

  it("attributes a file to each queried parent it lists (multi-parent safe)", async () => {
    // A file that lives under two folders a and b (Drive allows multiple
    // parents). Both a and b are queried together; the file must appear under
    // BOTH paths.
    const c = client();
    mockedRequestUrl.mockImplementation((params: { url: string }) => {
      const url = decodeURIComponent(params.url).replace(/\+/g, " ");
      if (url.includes("'root' in parents")) {
        return Promise.resolve(
          listResponse([
            { id: "a", name: "a", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
            { id: "b", name: "b", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
          ])
        ) as never;
      }
      if (url.includes("'a' in parents") || url.includes("'b' in parents")) {
        // The shared file lists BOTH a and b as parents.
        return Promise.resolve(
          listResponse([
            { id: "shared", name: "s.md", mimeType: "text/markdown", parents: ["a", "b"] },
          ])
        ) as never;
      }
      return Promise.resolve(listResponse([])) as never;
    });

    // Act
    const { files } = await c.listFiles("root");

    // Assert: the file appears under both parent paths.
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      "a/s.md",
      "b/s.md",
    ]);
  });
});

describe("buildSubtree — flat-list tree reconstruction (Shared Drive)", () => {
  const folder = (id: string, name: string, parent: string) => ({
    id,
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parent],
  });
  const file = (id: string, name: string, parent: string) => ({
    id,
    name,
    mimeType: "text/markdown",
    parents: [parent],
  });

  it("reconstructs nested relativePaths from parent links", () => {
    // Arrange: root -> sub -> inner; files at each level.
    const items = [
      file("t", "top.md", "root"),
      folder("s", "sub", "root"),
      file("i", "inner.md", "s"),
      folder("d", "deep", "s"),
      file("x", "x.md", "d"),
    ];

    // Act
    const { files, folders } = buildSubtree(items, "root");

    // Assert
    const paths = new Map(files.map((f) => [f.id, f.relativePath]));
    expect(paths.get("t")).toBe("top.md");
    expect(paths.get("i")).toBe("sub/inner.md");
    expect(paths.get("x")).toBe("sub/deep/x.md");
    expect(folders).toEqual([
      { id: "s", relativePath: "sub" },
      { id: "d", relativePath: "sub/deep" },
    ]);
  });

  it("excludes items outside the sync root subtree", () => {
    // Arrange: 'other' hangs off a DIFFERENT parent, not reachable from root.
    const items = [
      file("t", "top.md", "root"),
      file("o", "other.md", "someOtherFolder"),
    ];

    // Act
    const { files } = buildSubtree(items, "root");

    // Assert: only the in-root file; 'other' is not a deletion, just excluded.
    expect(files.map((f) => f.id)).toEqual(["t"]);
  });

  it("ignores orphans (parent not present) without throwing", () => {
    // Arrange: 'ghost' points at a parent id that doesn't exist in the list.
    const items = [file("t", "top.md", "root"), file("g", "ghost.md", "missing")];

    // Act
    const { files } = buildSubtree(items, "root");

    // Assert
    expect(files.map((f) => f.id)).toEqual(["t"]);
  });

  it("supports a root that is a SUBFOLDER of the drive (not the drive root)", () => {
    // Arrange: sync root is 'sub'; 'top.md' at the drive root must be excluded.
    const items = [
      file("t", "top.md", "driveRoot"),
      folder("s", "sub", "driveRoot"),
      file("i", "inner.md", "s"),
    ];

    // Act: rebuild rooted at 'sub'.
    const { files } = buildSubtree(items, "s");

    // Assert: only 'inner.md', pathed relative to 'sub'.
    expect(files.map((f) => [f.id, f.relativePath])).toEqual([
      ["i", "inner.md"],
    ]);
  });

  it("produces output IDENTICAL to the per-folder BFS for the same tree", async () => {
    // The flat and BFS paths must be interchangeable — same files/folders/paths
    // — so the reconciler behaves identically regardless of drive type.
    // Arrange a small tree served two ways. Items carry `parents` (as the real
    // API returns) so the fixtures are truly apples-to-apples.
    const tree = {
      root: [
        {
          id: "s",
          name: "sub",
          mimeType: "application/vnd.google-apps.folder",
          parents: ["root"],
        },
        {
          id: "t",
          name: "top.md",
          mimeType: "text/markdown",
          parents: ["root"],
        },
      ],
      s: [
        {
          id: "i",
          name: "inner.md",
          mimeType: "text/markdown",
          parents: ["s"],
        },
      ],
    } as const;

    // BFS path (My Drive): serve per-folder queries.
    const cBfs = client();
    mockedRequestUrl.mockImplementation((params: { url: string }) => {
      const url = decodeURIComponent(params.url).replace(/\+/g, " ");
      if (url.includes("'root' in parents"))
        return Promise.resolve(listResponse([...tree.root])) as never;
      if (url.includes("'s' in parents"))
        return Promise.resolve(listResponse([...tree.s])) as never;
      return Promise.resolve(listResponse([])) as never;
    });
    const bfs = await cBfs.listFiles("root");

    // Flat path via buildSubtree: same items, flattened into one list.
    const flat = buildSubtree(
      [tree.root[0], tree.root[1], tree.s[0]],
      "root"
    );

    // Assert: byte-for-byte equal.
    expect(flat).toEqual(bfs);
  });
});

describe("GoogleDriveClient.listFiles — Shared Drive flat path", () => {
  it("uses a single parent-less paginated query (corpora=drive), not per-folder BFS", async () => {
    // Arrange: two pages of the WHOLE drive, no per-folder queries.
    const c = client();
    mockedRequestUrl
      .mockResolvedValueOnce(
        listResponse(
          [
            {
              id: "s",
              name: "sub",
              mimeType: "application/vnd.google-apps.folder",
              parents: ["root"],
            },
          ],
          "page-2"
        )
      )
      .mockResolvedValueOnce(
        listResponse([
          {
            id: "i",
            name: "inner.md",
            mimeType: "text/markdown",
            parents: ["s"],
          },
        ])
      );

    // Act
    const { files, folders } = await c.listFiles("root", "shared-1");

    // Assert: only 2 requests total (the two pages), NOT one-per-folder.
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
    // Every query is the flat, parent-less drive query.
    for (const call of mockedRequestUrl.mock.calls) {
      const url = decodeURIComponent(call[0].url as string).replace(/\+/g, " ");
      expect(url).toContain("corpora=drive");
      expect(url).not.toContain("in parents");
    }
    // Tree reconstructed correctly.
    expect(folders).toEqual([{ id: "s", relativePath: "sub" }]);
    expect(files.map((f) => f.relativePath)).toEqual(["sub/inner.md"]);
  });
});

describe("mapPool", () => {
  it("preserves input order in the results regardless of completion order", async () => {
    // Arrange: item 0 resolves LAST, item 2 resolves FIRST.
    const delays = [30, 10, 0];
    const worker = (ms: number) =>
      new Promise<number>((r) => setTimeout(() => r(ms * 10), ms));

    // Act
    const out = await mapPool(delays, 8, worker);

    // Assert: result[i] corresponds to items[i], not to finish order.
    expect(out).toEqual([300, 100, 0]);
  });

  it("never exceeds the concurrency limit", async () => {
    // Arrange
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };

    // Act: 20 items, limit 3.
    await mapPool(new Array(20).fill(0), 3, worker);

    // Assert
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("returns an empty array for no items (no worker calls)", async () => {
    // Arrange
    const worker = vi.fn();

    // Act
    const out = await mapPool([], 8, worker);

    // Assert
    expect(out).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
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

describe("GoogleDriveClient.downloadFile — binary, never parses JSON", () => {
  it("returns the arrayBuffer without touching .json (mobile binary bug)", async () => {
    // Arrange: mimic Obsidian mobile, where `.json` is a getter that throws a
    // JSON parse error on binary bodies. downloadFile must never read it.
    const c = client();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      text: "%PDF-1.7…",
      arrayBuffer: bytes.buffer,
      get json(): unknown {
        throw new SyntaxError("JSON Parse error: Unrecognized token '%'");
      },
    } as unknown as Awaited<ReturnType<typeof requestUrl>>);

    // Act
    const buf = await c.downloadFile("file-1");

    // Assert: got the bytes, no JSON parse attempted.
    expect(new Uint8Array(buf)).toEqual(bytes);
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

describe("GoogleDriveClient — native fetch download path", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function okFetch(body = "hi"): Response {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    } as unknown as Response;
  }
  function statusFetch(status: number): Response {
    return {
      ok: false,
      status,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }

  it("uses native fetch when it succeeds (no requestUrl)", async () => {
    const fetchMock = vi.fn(async () => okFetch("data"));
    globalThis.fetch = fetchMock as never;
    const c = client(); // default impl → fetch is attempted

    const buf = await c.downloadFile("d1");

    expect(new TextDecoder().decode(buf)).toBe("data");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedRequestUrl).not.toHaveBeenCalled();
    expect(c.downloadTransport()).toBe("fetch");
  });

  it("retries a transient 5xx on the fetch path, then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      return n === 1 ? statusFetch(503) : okFetch("ok");
    }) as never;
    const c = client();

    const p = c.downloadFile("d1");
    await vi.runAllTimersAsync();
    const buf = await p;

    expect(new TextDecoder().decode(buf)).toBe("ok");
    expect(c.downloadTransport()).toBe("fetch"); // stayed on fetch
    expect(mockedRequestUrl).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("falls back to requestUrl when the FIRST fetch throws (CORS/unavailable)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as never;
    mockedRequestUrl.mockResolvedValue({
      status: 200,
      text: "",
      json: {},
      arrayBuffer: new TextEncoder().encode("viaRequestUrl").buffer,
    } as never);
    const c = client();

    const buf = await c.downloadFile("d1");

    expect(new TextDecoder().decode(buf)).toBe("viaRequestUrl");
    expect(mockedRequestUrl).toHaveBeenCalled();
    expect(c.downloadTransport()).toBe("requestUrl");
  });
});
