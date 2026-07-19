/**
 * Central i18n module. Translations automatically follow the UI language set
 * in Obsidian; unknown/unsupported languages and the test environment (no
 * `window`) fall back to English.
 *
 * Usage:
 *   import { t } from "./i18n";
 *   t("statusReady")                     // simple lookup
 *   t("uploadAction", { path: "a.md" })  // with {path} placeholders
 *
 * IMPORTANT: On import, this module must have NO top-level runtime dependency
 * on `window`/`moment` — otherwise the Node tests break. Language detection
 * (`detectLocale`) is therefore defensively encapsulated and only called
 * when needed (from `initLocale()` at plugin start).
 */

import { en, Messages } from "./locales/en";
import { de } from "./locales/de";
import { it } from "./locales/it";
import { fr } from "./locales/fr";

/** Supported UI languages. English is the default & fallback. */
export type Locale = "en" | "de" | "it" | "fr";

/** Key of a translation (derived from the authoritative English source). */
export type MessageKey = keyof Messages;

/** Parameters for placeholder interpolation (`{name}` → value). */
export type MessageParams = Record<string, string | number>;

/** Locale → dictionary. `en` is complete; the others fall back to it. */
const DICTS: Record<Locale, Partial<Messages>> = { en, de, it, fr };

/** Currently active language. Defaults to English until `initLocale()` runs. */
let activeLocale: Locale = "en";

/**
 * Determines the Obsidian UI language defensively. Obsidian stores the chosen
 * language in `window.localStorage["language"]` (empty/"en" = English). Any
 * exception (no `window`, no `localStorage`, access error) results in "en", so
 * that this module also works outside of Obsidian (tests).
 */
export function detectLocale(): Locale {
  try {
    const raw = window.localStorage.getItem("language");
    return normalizeLocale(raw);
  } catch {
    return "en";
  }
}

/** Maps a raw language code to a supported locale (otherwise "en"). */
function normalizeLocale(raw: string | null | undefined): Locale {
  if (!raw) return "en";
  // Obsidian sometimes uses codes like "pt-BR"; only the primary subtag counts here.
  const base = raw.toLowerCase().split("-")[0];
  if (base === "de" || base === "it" || base === "fr") return base;
  return "en";
}

/** Sets the active language based on the detected Obsidian UI language. */
export function initLocale(): void {
  activeLocale = detectLocale();
}

/** Sets the active language explicitly (mainly for tests). */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

/** Currently active language. */
export function getLocale(): Locale {
  return activeLocale;
}

/**
 * Translates a key into the active language. Lookup order:
 * active language → English (fallback) → the key itself (last resort,
 * should never become visible). `{name}` placeholders are filled from `params`.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template =
    DICTS[activeLocale][key] ?? en[key] ?? (key as unknown as string);
  return params ? interpolate(template, params) : template;
}

/** Replaces `{name}` placeholders in the template with the values from `params`. */
function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export type { Messages };
