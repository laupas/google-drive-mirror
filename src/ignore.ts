/**
 * Ignore filter: paths that are EXCLUDED from the sync — complementary to the
 * `allowedExtensions` whitelist filter. The ignore filter understands both plain
 * file extensions and glob-like patterns.
 *
 * Like the extension filter, it MUST apply identically on BOTH sides (local AND
 * Drive), otherwise the reconciler would see a filtered file on only one side
 * and misinterpret it as "deleted on one side".
 *
 * Pure functions without an Obsidian dependency → tested in
 * `test/unit/ignore.test.ts`.
 */

/**
 * Splits the comma-separated pattern list into trimmed, non-empty entries.
 * An empty list means: ignore nothing.
 */
export function parseIgnorePatterns(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => stripWrappingQuotes(p.trim()))
    .filter((p) => p.length > 0);
}

/**
 * Removes a single pair of matching wrapping quotes (`"…"` or `'…'`) from a
 * pattern. Users often copy/paste a comma-separated list with quotes (e.g.
 * `".git", ".exe"`); without stripping them the pattern would literally contain
 * the quote character and never match a real path. A quote is never a legitimate
 * part of a pattern here, so this is safe. Applied identically on both sides.
 */
function stripWrappingQuotes(p: string): string {
  if (
    p.length >= 2 &&
    ((p.startsWith('"') && p.endsWith('"')) ||
      (p.startsWith("'") && p.endsWith("'")))
  ) {
    return p.slice(1, -1).trim();
  }
  return p;
}

/**
 * Is the (sync-relative) path ignored by at least one pattern?
 *
 * Supported pattern forms (case-insensitive):
 *  - Plain extension: `tmp` or `.tmp` → matches any file with that extension
 *    (convenience, so you can type it like in the extension filter).
 *  - Glob: `*` (any number of characters except „/"), `?` (exactly one
 *    character except „/"), and `**` which spans WHOLE folder levels and may
 *    match ZERO of them. If the pattern contains a „/", it is checked against
 *    the WHOLE path, otherwise additionally against the file name (last
 *    segment) — so `*.log` also matches `sub/a.log`.
 *
 * To exclude a whole folder subtree, write the folder followed by a slash and a
 * double-star (e.g. dot-git slash double-star): that matches the folder entry
 * itself AND everything under it. Prefixing it with a double-star slash makes it
 * match that folder at ANY depth (including the top level), not just anchored to
 * the sync root. See `test/unit/ignore.test.ts` for the exact behavior.
 */
export function isIgnored(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);

  for (const raw of patterns) {
    const pat = raw.toLowerCase();

    // Plain extension (no glob character, no „/") → treat as „*.<ext>".
    if (!/[*?/]/.test(pat)) {
      const ext = pat.startsWith(".") ? pat.slice(1) : pat;
      if (base.endsWith("." + ext)) return true;
      // Additionally an exact file name (e.g. pattern „.gitignore" or „notes").
      if (base === pat || base === ext) return true;
      continue;
    }

    const re = globToRegExp(pat);
    if (pat.includes("/")) {
      if (re.test(lower)) return true;
    } else {
      // Without „/", match against the file name (applies at any depth).
      if (re.test(base)) return true;
    }
  }
  return false;
}

/**
 * Is the extension of the (sync-relative) path allowed by the whitelist?
 * `raw` is the comma-separated `allowedExtensions` string; empty = everything
 * allowed. Comparison is case-insensitive, without a leading dot. Mirrors
 * `SyncEngine.extensionAllowed` — kept pure here so the settings UI can reuse it.
 */
export function extensionAllowed(path: string, raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const allowed = trimmed
    .split(",")
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter((e) => e.length > 0);
  if (allowed.length === 0) return true;
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return allowed.includes(ext);
}

/**
 * Is the (sync-relative) path under one of the excluded folder prefixes?
 * `folders` are sync-relative folder paths (no trailing slash). Mirrors
 * `SyncEngine.isExcluded`.
 */
export function isUnderExcludedFolder(path: string, folders: string[]): boolean {
  for (const ex of folders) {
    if (!ex) continue;
    if (path === ex || path.startsWith(ex + "/")) return true;
  }
  return false;
}

/**
 * Would the (sync-relative, folder-prefix-stripped) path be filtered out of the
 * sync by the target's own settings? This is a read-only, best-effort mirror of
 * the engine's filters for the settings sync-tree "Ignored" column: it combines
 *  - the extension whitelist (`allowedExtensions`),
 *  - the ignore patterns (`ignorePatterns`), and
 *  - the target's own manual `excludeFolders`.
 *
 * It deliberately does NOT include cross-target sibling exclusions (those depend
 * on the live runtime), so it reflects only what the user configured on THIS
 * target. The extension whitelist is applied to files only — a folder has no
 * extension and must not read as "ignored" just because a whitelist is set.
 */
export function isFilteredByTargetSettings(
  path: string,
  isFolder: boolean,
  opts: {
    allowedExtensions: string;
    ignorePatterns: string;
    excludeFolders: string;
  }
): boolean {
  const excluded = parseIgnorePatterns(opts.excludeFolders);
  if (isUnderExcludedFolder(path, excluded)) return true;
  if (isIgnored(path, parseIgnorePatterns(opts.ignorePatterns))) return true;
  if (!isFolder && !extensionAllowed(path, opts.allowedExtensions)) return true;
  return false;
}

/**
 * Translates a glob pattern into an anchored RegExp, with segment-aware `**`
 * (gitignore-style):
 *  - `*`  → any run of characters except „/" (stays inside one path segment).
 *  - `?`  → exactly one character except „/".
 *  - `**` bound to a „/" spans WHOLE segments and may match ZERO of them:
 *      - leading `** /`  → optional prefix of any depth (`(?:.*\/)?`), so
 *        `** /.git/**` also matches the top-level `.git/…` (no leading folder).
 *      - a `/ ** /` in the middle → `/(?:.*\/)?` (one or more, or zero, segments).
 *      - a trailing `/ **` → `(?:/.*)?`, so `.git/**` matches the `.git` entry
 *        itself AND everything beneath it.
 *  - a bare `**` not adjacent to „/" degrades to „anything" (`.*`).
 * All remaining characters are escaped literally.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      const doubled = glob[i + 1] === "*";
      if (doubled) {
        const prevSlash = i === 0 || glob[i - 1] === "/";
        const nextSlash = glob[i + 2] === "/" || i + 2 === glob.length;
        if (prevSlash && glob[i + 2] === "/") {
          // "**/" — optional run of whole segments (incl. zero). We already
          // consume the following "/" here so it isn't emitted literally.
          out += "(?:.*/)?";
          i += 2; // skip the second "*" and the "/"
        } else if (prevSlash && i + 2 === glob.length) {
          // trailing "**" after a "/": match the parent entry and its subtree.
          // The literal "/" was already emitted; make it + the rest optional.
          out = out.replace(/\/$/, "") + "(?:/.*)?";
          i += 1; // skip the second "*"
        } else if (nextSlash) {
          // "**" bordered by "/" on one side only (rare) → cross-segment.
          out += ".*";
          i += 1;
        } else {
          // Bare "**" inside a segment → anything.
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      // Escape RegExp special characters.
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + "$");
}
