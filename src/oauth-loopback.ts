/**
 * Desktop-only OAuth loopback helper.
 *
 * Runs a one-shot local HTTP server on 127.0.0.1 to catch Google's redirect
 * (the "Desktop app" client flow). Node's `http`/`net` are loaded at RUNTIME via
 * `require()` (not a static `import`), so this module never references a Node
 * built-in on mobile — `oauth.ts` also only loads it lazily inside its desktop
 * branch. The `import type` below is erased at compile time (types only), so it
 * adds no runtime dependency.
 */

import type * as http from "http";
import type { AddressInfo } from "net";
import { log } from "./logger";
import { t } from "./i18n";

/** Result of a successful loopback capture. */
export interface LoopbackResult {
  /** The authorization code returned by Google. */
  code: string;
  /** The exact redirect_uri used, to be replayed on the token exchange. */
  redirectUri: string;
}

/**
 * Starts a one-shot local HTTP server on a free port, builds the consent URL
 * (via `buildAuthUrl`, which receives the concrete redirect_uri), opens the
 * browser and resolves once Google redirects to 127.0.0.1 with the auth code.
 *
 * @param state          CSRF state expected back on the redirect.
 * @param buildAuthUrl   Builds the full consent URL for a given redirect_uri.
 * @param openBrowser    Opens the consent URL in the system browser.
 */
export function awaitLoopbackAuthCode(
  state: string,
  buildAuthUrl: (redirectUri: string) => string,
  openBrowser: (url: string) => void
): Promise<LoopbackResult> {
  // Load Node built-ins at runtime; this file is only ever imported on desktop.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const httpMod = require("http") as typeof http;

  return new Promise((resolve, reject) => {
    let settled = false;
    // Set in server.listen() and reused in the callback, so that the consent
    // and token-exchange redirect_uri match exactly.
    let redirectUri = "";

    const server = httpMod.createServer(
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        try {
          const reqUrl = new URL(req.url ?? "", "http://127.0.0.1");
          log.info("HTTP request on loopback:", reqUrl.pathname);
          // The browser often requests /favicon.ico -> ignore it, don't treat it as an error.
          if (reqUrl.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const returnedState = reqUrl.searchParams.get("state");
          const code = reqUrl.searchParams.get("code");
          const error = reqUrl.searchParams.get("error");

          const ok = !error && !!code && returnedState === state;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:3rem">` +
              `<h2>${ok ? t("oauthPageSuccess") : t("oauthPageFailure")}</h2>` +
              `<p>${t("oauthPageClose")}</p>` +
              `</body></html>`
          );

          if (settled) return;
          settled = true;
          // Only close the server once the response has been written out.
          res.on("finish", () => server.close());

          if (error) return reject(new Error(t("oauthError", { error })));
          if (!code) return reject(new Error(t("oauthNoCode")));
          if (returnedState !== state)
            return reject(new Error(t("oauthStateMismatch")));

          // IMPORTANT: use exactly the same redirect_uri as during consent,
          // otherwise Google rejects the token exchange with redirect_uri_mismatch.
          resolve({ code, redirectUri });
        } catch (e) {
          if (!settled) {
            settled = true;
            server.close();
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      }
    );

    server.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // Port 0 = any free port.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      log.info("Loopback server listening, redirect_uri=" + redirectUri);
      openBrowser(buildAuthUrl(redirectUri));
    });

    // Timeout after 5 minutes.
    window.setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error(t("oauthTimeout")));
      }
    }, 5 * 60 * 1000);
  });
}
