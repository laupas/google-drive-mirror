/**
 * Test setup: provide a minimal `window` shim in the Node test environment.
 *
 * The plugin uses `window.setTimeout`/`clearTimeout` (Obsidian guideline: use
 * the window timers for popout-window compatibility). Under vitest's `node`
 * environment there is no `window`, so we alias the timer functions (and a
 * throwing `localStorage` the i18n detection tolerates) onto a global `window`.
 */

const g = globalThis as unknown as { window?: unknown };

if (typeof g.window === "undefined") {
  // Delegate at CALL time (not via bind), so vitest's fake timers — which swap
  // out globalThis.setTimeout — are honored by tests that use them.
  g.window = {
    setTimeout: (...args: Parameters<typeof setTimeout>) =>
      globalThis.setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) =>
      globalThis.clearTimeout(...args),
    setInterval: (...args: Parameters<typeof setInterval>) =>
      globalThis.setInterval(...args),
    clearInterval: (...args: Parameters<typeof clearInterval>) =>
      globalThis.clearInterval(...args),
    // i18n's detectLocale() reads this defensively and falls back to "en".
    localStorage: {
      getItem: () => null,
    },
  };
}
