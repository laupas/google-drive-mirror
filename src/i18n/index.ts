/**
 * Zentrales i18n-Modul. Übersetzungen folgen automatisch der in Obsidian
 * eingestellten UI-Sprache; unbekannte/nicht unterstützte Sprachen und die
 * Testumgebung (kein `window`) fallen auf Englisch zurück.
 *
 * Verwendung:
 *   import { t } from "./i18n";
 *   t("statusReady")                     // einfacher Lookup
 *   t("uploadAction", { path: "a.md" })  // mit {path}-Platzhaltern
 *
 * WICHTIG: Dieses Modul darf beim Import KEINE Runtime-Abhängigkeit auf
 * `window`/`moment` auf Top-Level haben — sonst brechen die Node-Tests. Die
 * Spracherkennung (`detectLocale`) ist deshalb defensiv gekapselt und wird nur
 * bei Bedarf aufgerufen (aus `initLocale()` beim Plugin-Start).
 */

import { en, Messages } from "./locales/en";
import { de } from "./locales/de";
import { it } from "./locales/it";
import { fr } from "./locales/fr";

/** Unterstützte UI-Sprachen. Englisch ist Default & Fallback. */
export type Locale = "en" | "de" | "it" | "fr";

/** Schlüssel einer Übersetzung (aus der englischen Autoritätsquelle abgeleitet). */
export type MessageKey = keyof Messages;

/** Parameter für Platzhalter-Interpolation (`{name}` → Wert). */
export type MessageParams = Record<string, string | number>;

/** Locale → Wörterbuch. `en` ist vollständig; die anderen fallen darauf zurück. */
const DICTS: Record<Locale, Partial<Messages>> = { en, de, it, fr };

/** Aktuell aktive Sprache. Default Englisch, bis `initLocale()` läuft. */
let activeLocale: Locale = "en";

/**
 * Ermittelt die Obsidian-UI-Sprache defensiv. Obsidian speichert die gewählte
 * Sprache in `window.localStorage["language"]` (leer/"en" = Englisch). Jede
 * Ausnahme (kein `window`, kein `localStorage`, Zugriffsfehler) führt zu "en",
 * damit dieses Modul auch außerhalb von Obsidian (Tests) funktioniert.
 */
export function detectLocale(): Locale {
  try {
    const raw = window.localStorage.getItem("language");
    return normalizeLocale(raw);
  } catch {
    return "en";
  }
}

/** Bildet einen rohen Sprachcode auf eine unterstützte Locale ab (sonst "en"). */
function normalizeLocale(raw: string | null | undefined): Locale {
  if (!raw) return "en";
  // Obsidian nutzt teils Codes wie "pt-BR"; nur das Primär-Subtag zählt hier.
  const base = raw.toLowerCase().split("-")[0];
  if (base === "de" || base === "it" || base === "fr") return base;
  return "en";
}

/** Setzt die aktive Sprache anhand der erkannten Obsidian-UI-Sprache. */
export function initLocale(): void {
  activeLocale = detectLocale();
}

/** Setzt die aktive Sprache explizit (v.a. für Tests). */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

/** Aktuell aktive Sprache. */
export function getLocale(): Locale {
  return activeLocale;
}

/**
 * Übersetzt einen Schlüssel in die aktive Sprache. Lookup-Reihenfolge:
 * aktive Sprache → Englisch (Fallback) → der Schlüssel selbst (letzter Notnagel,
 * sollte nie sichtbar werden). `{name}`-Platzhalter werden aus `params` gefüllt.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template =
    DICTS[activeLocale][key] ?? en[key] ?? (key as unknown as string);
  return params ? interpolate(template, params) : template;
}

/** Ersetzt `{name}`-Platzhalter im Template durch die Werte aus `params`. */
function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export type { Messages };
