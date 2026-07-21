/**
 * Desktop-only OAuth loopback helper.
 *
 * Runs a one-shot local HTTP server on 127.0.0.1 to catch Google's redirect
 * (the "Desktop app" client flow). Node's `http` module is loaded via a CommonJS
 * `require("http")` guarded by `Platform.isDesktop`, so there is no static Node
 * import and mobile never evaluates it — `oauth.ts` additionally only imports
 * this module lazily inside its desktop branch. We deliberately do NOT use
 * `await import("http")`: esbuild would leave that as a native ESM dynamic
 * import, which the Electron renderer cannot resolve for a bare Node specifier.
 *
 * We deliberately do NOT reference `@types/node` here (not `import`, not a type
 * query): the Obsidian lint config treats Node types as unavailable, so any such
 * reference degrades to `any` and trips the `no-unsafe-*` rules. Instead we
 * declare the MINIMAL structural interfaces this file actually uses, which keeps
 * everything fully typed with no `any` and no Node dependency.
 */

import { Platform } from "obsidian";
import { log } from "./logger";
import { t } from "./i18n";

/** Minimal shape of Node's `http.IncomingMessage` used here. */
interface NodeRequest {
  url?: string;
}

/** Minimal shape of Node's `http.ServerResponse` used here. */
interface NodeResponse {
  writeHead(status: number, headers?: Record<string, string>): NodeResponse;
  end(body?: string): void;
  on(event: "finish", listener: () => void): void;
}

/** Minimal shape of Node's `http.Server` used here. */
interface NodeServer {
  on(event: "error", listener: (err: Error) => void): void;
  listen(port: number, host: string, listeningListener: () => void): void;
  address(): { port: number } | string | null;
  close(): void;
}

/** Minimal shape of the Node `http` module used here. */
interface NodeHttpModule {
  createServer(
    handler: (req: NodeRequest, res: NodeResponse) => void
  ): NodeServer;
}

/**
 * Minimal shape of the CommonJS `require` present in the Electron renderer.
 * Declared locally (not via `@types/node`) for the same reason as the Node
 * interfaces above: referencing Node types trips the Obsidian lint config.
 */
interface NodeRequire {
  (id: string): unknown;
}
declare const require: NodeRequire;

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
export async function awaitLoopbackAuthCode(
  state: string,
  buildAuthUrl: (redirectUri: string) => string,
  openBrowser: (url: string) => void
): Promise<LoopbackResult> {
  // The loopback flow needs Node's http server, which mobile lacks. Guard the
  // dynamic import with Platform.isDesktop so mobile never loads a Node built-in
  // (oauth.ts additionally only reaches this on its desktop branch).
  if (!Platform.isDesktop) {
    throw new Error(t("oauthLoopbackDesktopOnly"));
  }
  // Load Node's http via CommonJS require, NOT `await import("http")`. esbuild
  // leaves a dynamic `import()` of an external as a native ESM import, which the
  // Electron renderer's module loader cannot resolve for a bare Node specifier
  // ("Failed to resolve module specifier 'http'"). require() resolves the
  // built-in synchronously in the renderer. Guarded by Platform.isDesktop above,
  // and this module is only ever imported from oauth.ts's desktop branch.
  const httpMod = require("http") as NodeHttpModule;

  return new Promise<LoopbackResult>((resolve, reject) => {
    let settled = false;
    // Set in server.listen() and reused in the callback, so that the consent
    // and token-exchange redirect_uri match exactly.
    let redirectUri = "";

    const server: NodeServer = httpMod.createServer(
      (req: NodeRequest, res: NodeResponse) => {
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
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;
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
