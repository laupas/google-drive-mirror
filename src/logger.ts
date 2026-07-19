/**
 * Central logger for the whole plugin. Uniform prefix, one switch.
 *
 * `info`/`debug` are only output when debug logging is active in the settings
 * — so the console stays free of non-error messages in the default
 * configuration (Obsidian guideline: only errors by default).
 * `warn`/`error` always run.
 */
const PREFIX = "[GDrive Sync]";

let debugEnabled = false;

/** Toggles info/debug logging globally (set from the settings). */
export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

export const log = {
  /** Informational message — only when debug logging is active. */
  info(...args: unknown[]): void {
    if (debugEnabled) console.log(PREFIX, ...args);
  },
  /** Detailed debug message — only when debug logging is active. */
  debug(...args: unknown[]): void {
    if (debugEnabled) console.debug(PREFIX, ...args);
  },
  /** Warning — always visible. */
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  /** Error — always visible. */
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};
