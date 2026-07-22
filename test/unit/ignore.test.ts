import { describe, expect, it } from "vitest";
import {
  extensionAllowed,
  isFilteredByTargetSettings,
  isIgnored,
  isUnderExcludedFolder,
  parseIgnorePatterns,
} from "../../src/ignore";
import { DEFAULT_IGNORE_PATTERNS } from "../../src/types";

describe("parseIgnorePatterns", () => {
  it("splits, trims and drops empty entries", () => {
    expect(parseIgnorePatterns(" *.tmp , , .log ,")).toEqual(["*.tmp", ".log"]);
  });

  it("empty input → empty list", () => {
    expect(parseIgnorePatterns("")).toEqual([]);
    expect(parseIgnorePatterns("   ")).toEqual([]);
  });

  it("strips wrapping single/double quotes (paste with quotes)", () => {
    // Users often paste a quoted, comma-separated list; the quotes must not
    // become part of the pattern or nothing would ever match.
    expect(parseIgnorePatterns('".git", ".exe"')).toEqual([".git", ".exe"]);
    expect(parseIgnorePatterns("'*.tmp', 'drafts/*'")).toEqual([
      "*.tmp",
      "drafts/*",
    ]);
    // A quote only inside the pattern is left untouched.
    expect(parseIgnorePatterns('a"b')).toEqual(['a"b']);
  });
});

describe("isIgnored", () => {
  it("no patterns → never ignored", () => {
    expect(isIgnored("a.tmp", [])).toBe(false);
  });

  it("plain extension matches with or without leading dot, case-insensitive", () => {
    expect(isIgnored("note.tmp", ["tmp"])).toBe(true);
    expect(isIgnored("note.TMP", [".tmp"])).toBe(true);
    expect(isIgnored("sub/deep/note.tmp", ["tmp"])).toBe(true);
    expect(isIgnored("note.md", ["tmp"])).toBe(false);
  });

  it("plain extension does not match a substring of the name", () => {
    // "tmp" must not match "tmpl" or "atmp.md"
    expect(isIgnored("file.tmpl", ["tmp"])).toBe(false);
  });

  it("exact filename pattern (no glob, no slash)", () => {
    expect(isIgnored(".DS_Store", [".DS_Store"])).toBe(true);
    expect(isIgnored("sub/.DS_Store", [".DS_Store"])).toBe(true);
    expect(isIgnored("notes", ["notes"])).toBe(true);
  });

  it("*.ext glob matches on any depth (filename-only pattern)", () => {
    expect(isIgnored("a.log", ["*.log"])).toBe(true);
    expect(isIgnored("sub/a.log", ["*.log"])).toBe(true);
    expect(isIgnored("a.txt", ["*.log"])).toBe(false);
  });

  it("* does not cross a slash", () => {
    expect(isIgnored("drafts/a.md", ["drafts/*"])).toBe(true);
    expect(isIgnored("drafts/sub/a.md", ["drafts/*"])).toBe(false);
  });

  it("** crosses slashes", () => {
    expect(isIgnored("drafts/sub/a.md", ["drafts/**"])).toBe(true);
    expect(isIgnored("x/node_modules/y/z.js", ["**/node_modules/**"])).toBe(
      true
    );
  });

  it("trailing /** matches the parent entry AND its whole subtree", () => {
    // ".git/**" excludes the ".git" folder itself and everything beneath it.
    expect(isIgnored(".git", [".git/**"])).toBe(true);
    expect(isIgnored(".git/config", [".git/**"])).toBe(true);
    expect(isIgnored(".git/a/b.exe", [".git/**"])).toBe(true);
    // ...but only anchored at the root (no leading "**/").
    expect(isIgnored("sub/.git/config", [".git/**"])).toBe(false);
    // A sibling that merely starts with the same name is not matched.
    expect(isIgnored(".github/x", [".git/**"])).toBe(false);
  });

  it("leading **/ matches zero or more leading segments (any depth incl. top)", () => {
    const pat = ["**/.git/**"];
    expect(isIgnored(".git", pat)).toBe(true); // top-level, zero prefix
    expect(isIgnored(".git/config", pat)).toBe(true);
    expect(isIgnored("sub/.git/config", pat)).toBe(true);
    expect(isIgnored("a/b/.git/x/y.exe", pat)).toBe(true);
    expect(isIgnored("notes.md", pat)).toBe(false);
    expect(isIgnored("gitfoo/x", pat)).toBe(false);
  });

  it("? matches exactly one non-slash char", () => {
    expect(isIgnored("a1.md", ["a?.md"])).toBe(true);
    expect(isIgnored("a12.md", ["a?.md"])).toBe(false);
    expect(isIgnored("a/.md", ["a?.md"])).toBe(false);
  });

  it("pattern with slash is anchored to the whole path", () => {
    expect(isIgnored("temp/a.md", ["temp/*"])).toBe(true);
    expect(isIgnored("sub/temp/a.md", ["temp/*"])).toBe(false);
    expect(isIgnored("sub/temp/a.md", ["**/temp/*"])).toBe(true);
  });

  it("any of several patterns matches", () => {
    const pats = ["*.tmp", "drafts/*", ".DS_Store"];
    expect(isIgnored("x.tmp", pats)).toBe(true);
    expect(isIgnored("drafts/note.md", pats)).toBe(true);
    expect(isIgnored("sub/.DS_Store", pats)).toBe(true);
    expect(isIgnored("keep.md", pats)).toBe(false);
  });
});

describe("extensionAllowed", () => {
  it("empty whitelist allows everything", () => {
    expect(extensionAllowed("a.tmp", "")).toBe(true);
    expect(extensionAllowed("a.tmp", "   ")).toBe(true);
  });

  it("matches case-insensitively, with or without leading dot", () => {
    expect(extensionAllowed("note.MD", "md, pdf")).toBe(true);
    expect(extensionAllowed("note.pdf", ".md,.pdf")).toBe(true);
    expect(extensionAllowed("note.txt", "md,pdf")).toBe(false);
  });

  it("a file without an extension only passes an empty whitelist", () => {
    expect(extensionAllowed("README", "md")).toBe(false);
    expect(extensionAllowed("README", "")).toBe(true);
  });
});

describe("isUnderExcludedFolder", () => {
  it("matches the folder itself and its subtree, not siblings", () => {
    const folders = ["drafts", "a/b"];
    expect(isUnderExcludedFolder("drafts", folders)).toBe(true);
    expect(isUnderExcludedFolder("drafts/x.md", folders)).toBe(true);
    expect(isUnderExcludedFolder("a/b/c/x.md", folders)).toBe(true);
    expect(isUnderExcludedFolder("draftsX/x.md", folders)).toBe(false);
    expect(isUnderExcludedFolder("a/bc.md", folders)).toBe(false);
  });
});

describe("isFilteredByTargetSettings", () => {
  const opts = (o: Partial<{
    allowedExtensions: string;
    ignorePatterns: string;
    excludeFolders: string;
  }> = {}) => ({
    allowedExtensions: "",
    ignorePatterns: "",
    excludeFolders: "",
    ...o,
  });

  it("nothing configured → nothing filtered", () => {
    expect(isFilteredByTargetSettings("a/b.md", false, opts())).toBe(false);
    expect(isFilteredByTargetSettings("a", true, opts())).toBe(false);
  });

  it("ignore patterns filter files and folders", () => {
    expect(
      isFilteredByTargetSettings("x.tmp", false, opts({ ignorePatterns: "*.tmp" }))
    ).toBe(true);
    expect(
      isFilteredByTargetSettings("sub/drafts", true, opts({ ignorePatterns: "drafts" }))
    ).toBe(true);
  });

  it("excluded folders filter the folder and its subtree", () => {
    expect(
      isFilteredByTargetSettings("drafts", true, opts({ excludeFolders: "drafts" }))
    ).toBe(true);
    expect(
      isFilteredByTargetSettings("drafts/x.md", false, opts({ excludeFolders: "drafts" }))
    ).toBe(true);
  });

  it("extension whitelist filters non-matching files but never folders", () => {
    const o = opts({ allowedExtensions: "md" });
    expect(isFilteredByTargetSettings("x.tmp", false, o)).toBe(true);
    expect(isFilteredByTargetSettings("x.md", false, o)).toBe(false);
    // A folder has no extension and must not be flagged by the whitelist.
    expect(isFilteredByTargetSettings("somefolder", true, o)).toBe(false);
  });
});

describe("DEFAULT_IGNORE_PATTERNS", () => {
  const patterns = parseIgnorePatterns(DEFAULT_IGNORE_PATTERNS);

  it("ignores .exe files at any depth", () => {
    expect(isIgnored("tool.exe", patterns)).toBe(true);
    expect(isIgnored("bin/tool.exe", patterns)).toBe(true);
    expect(isIgnored("deep/nested/setup.exe", patterns)).toBe(true);
  });

  it("ignores .git repository contents (folder + subtree) at any depth", () => {
    // The .git folder entry itself, at the top level and nested.
    expect(isIgnored(".git", patterns)).toBe(true);
    expect(isIgnored("repo/.git", patterns)).toBe(true);
    // Contents of a .git folder.
    expect(isIgnored(".git/config", patterns)).toBe(true);
    expect(isIgnored("repo/.git/HEAD", patterns)).toBe(true);
    expect(isIgnored("a/b/.git/objects/ab/cd", patterns)).toBe(true);
  });

  it("does not ignore normal notes or a .gitignore file", () => {
    expect(isIgnored("note.md", patterns)).toBe(false);
    expect(isIgnored("bin/readme.md", patterns)).toBe(false);
    // A file literally named .gitignore is NOT under a .git/ folder.
    expect(isIgnored(".gitignore", patterns)).toBe(false);
    // "executable" contains "exe" but is not a .exe file.
    expect(isIgnored("executable.md", patterns)).toBe(false);
  });
});
