/**
 * Zentraler Logger für das gesamte Plugin. Einheitlicher Prefix, ein Schalter.
 *
 * `info`/`debug` werden nur ausgegeben, wenn Debug-Logging in den Settings
 * aktiv ist — so bleibt die Konsole in der Standardkonfiguration frei von
 * Nicht-Fehler-Meldungen (Obsidian-Richtlinie: nur Fehler by default).
 * `warn`/`error` laufen immer.
 */
const PREFIX = "[GDrive Sync]";

let debugEnabled = false;

/** Schaltet Info-/Debug-Logging global um (aus den Settings gesetzt). */
export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

export const log = {
  /** Informative Meldung — nur bei aktivem Debug-Logging. */
  info(...args: unknown[]): void {
    if (debugEnabled) console.log(PREFIX, ...args);
  },
  /** Detaillierte Debug-Meldung — nur bei aktivem Debug-Logging. */
  debug(...args: unknown[]): void {
    if (debugEnabled) console.debug(PREFIX, ...args);
  },
  /** Warnung — immer sichtbar. */
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  /** Fehler — immer sichtbar. */
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};
