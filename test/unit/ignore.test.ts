import { describe, expect, it } from "vitest";
import { isIgnored, parseIgnorePatterns } from "../../src/ignore";

describe("parseIgnorePatterns", () => {
  it("splits, trims and drops empty entries", () => {
    expect(parseIgnorePatterns(" *.tmp , , .log ,")).toEqual(["*.tmp", ".log"]);
  });

  it("empty input → empty list", () => {
    expect(parseIgnorePatterns("")).toEqual([]);
    expect(parseIgnorePatterns("   ")).toEqual([]);
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
