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
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Is the (sync-relative) path ignored by at least one pattern?
 *
 * Supported pattern forms (case-insensitive):
 *  - Plain extension: `tmp` or `.tmp` → matches any file with that extension
 *    (convenience, so you can type it like in the extension filter).
 *  - Glob: `*` (any number of characters except „/"), `**` (also across „/"),
 *    `?` (exactly one character except „/"). If the pattern contains a „/", it
 *    is checked against the WHOLE path, otherwise additionally against the file
 *    name (last segment) — so `*.log` also matches `sub/a.log`.
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
 * Translates a glob pattern into an anchored RegExp.
 * `**` → anything (incl. „/"), `*` → anything except „/", `?` → one character
 * except „/". All remaining characters are escaped literally.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
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
