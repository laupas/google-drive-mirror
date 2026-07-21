/**
 * Unit tests for filterEntries() — narrows the settings sync tree by the
 * filter-box query while keeping ancestor folders and matched subtrees visible.
 */

import { describe, it, expect } from "vitest";
import { filterEntries } from "../../src/settings-tab";
import { baseEntry } from "../helpers/factories";

const entries = [
  baseEntry({ path: "Projects", isFolder: true }),
  baseEntry({ path: "Projects/alpha.md", isFolder: false }),
  baseEntry({ path: "Projects/notes.txt", isFolder: false }),
  baseEntry({ path: "Areas", isFolder: true }),
  baseEntry({ path: "Areas/health.md", isFolder: false }),
  baseEntry({ path: "top.md", isFolder: false }),
];

const paths = (list: ReturnType<typeof filterEntries>) =>
  list.map((e) => e.path).sort();

describe("filterEntries", () => {
  it("empty query returns everything unchanged", () => {
    expect(filterEntries(entries, "")).toBe(entries);
  });

  it("matches a file and keeps its ancestor folder", () => {
    expect(paths(filterEntries(entries, "alpha"))).toEqual([
      "Projects",
      "Projects/alpha.md",
    ]);
  });

  it("matching a folder keeps its whole subtree", () => {
    expect(paths(filterEntries(entries, "projects"))).toEqual([
      "Projects",
      "Projects/alpha.md",
      "Projects/notes.txt",
    ]);
  });

  it("is case-insensitive on an already-lowercased query", () => {
    // The caller lowercases the query; paths are compared lowercased.
    expect(paths(filterEntries(entries, "areas"))).toEqual([
      "Areas",
      "Areas/health.md",
    ]);
  });

  it("matches a top-level file with no folder", () => {
    expect(paths(filterEntries(entries, "top"))).toEqual(["top.md"]);
  });

  it("no match → empty list", () => {
    expect(filterEntries(entries, "zzz")).toEqual([]);
  });

  it("matches on a path segment, not only the leaf name", () => {
    // "proj" appears in the folder prefix of the files too.
    expect(paths(filterEntries(entries, "proj"))).toEqual([
      "Projects",
      "Projects/alpha.md",
      "Projects/notes.txt",
    ]);
  });
});
