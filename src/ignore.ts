/**
 * Ignore-Filter: Pfade, die vom Sync AUSGESCHLOSSEN werden — komplementär zum
 * `allowedExtensions`-Whitelist-Filter. Der Ignore-Filter versteht sowohl reine
 * Dateiendungen als auch Glob-artige Muster.
 *
 * Wie der Endungsfilter MUSS er auf BEIDEN Seiten (lokal UND Drive) identisch
 * greifen, sonst sähe der Reconciler eine gefilterte Datei nur auf einer Seite
 * und würde sie als „auf einer Seite gelöscht" fehlinterpretieren.
 *
 * Reine Funktionen ohne Obsidian-Abhängigkeit → in `test/unit/ignore.test.ts`
 * getestet.
 */

/**
 * Zerlegt die kommagetrennte Musterliste in getrimmte, nicht-leere Einträge.
 * Leere Liste bedeutet: nichts ignorieren.
 */
export function parseIgnorePatterns(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Ist der (sync-relative) Pfad durch mindestens ein Muster ignoriert?
 *
 * Unterstützte Musterformen (case-insensitive):
 *  - Reine Endung: `tmp` oder `.tmp` → matcht jede Datei mit dieser Endung
 *    (Bequemlichkeit, damit man wie beim Endungsfilter tippen kann).
 *  - Glob: `*` (beliebig viele Zeichen außer „/"), `**` (auch über „/" hinweg),
 *    `?` (genau ein Zeichen außer „/"). Enthält das Muster ein „/", wird es
 *    gegen den GANZEN Pfad geprüft, sonst zusätzlich gegen den Dateinamen
 *    (letztes Segment) — so matcht `*.log` auch `sub/a.log`.
 */
export function isIgnored(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);

  for (const raw of patterns) {
    const pat = raw.toLowerCase();

    // Reine Endung (kein Glob-Zeichen, kein „/") → als „*.<ext>" behandeln.
    if (!/[*?/]/.test(pat)) {
      const ext = pat.startsWith(".") ? pat.slice(1) : pat;
      if (base.endsWith("." + ext)) return true;
      // Zusätzlich exakter Dateiname (z.B. Muster „.gitignore" oder „notes").
      if (base === pat || base === ext) return true;
      continue;
    }

    const re = globToRegExp(pat);
    if (pat.includes("/")) {
      if (re.test(lower)) return true;
    } else {
      // Ohne „/" gegen den Dateinamen matchen (greift auf jeder Tiefe).
      if (re.test(base)) return true;
    }
  }
  return false;
}

/**
 * Übersetzt ein Glob-Muster in eine anker­gebundene RegExp.
 * `**` → beliebig (inkl. „/"), `*` → beliebig außer „/", `?` → ein Zeichen
 * außer „/". Alle übrigen Zeichen werden literal escaped.
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
      // RegExp-Sonderzeichen escapen.
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + "$");
}
