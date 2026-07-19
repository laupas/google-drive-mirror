import * as http from "http";
import { AddressInfo } from "net";
import { requestUrl } from "obsidian";
import { OAUTH_SCOPE, PluginSettings } from "./types";
import { log } from "./logger";
import { t } from "./i18n";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Manages the OAuth 2.0 flow against Google for a Cloud app created by the
 * user themselves ("Desktop"/loopback flow).
 *
 * - First sign-in: openLogin() starts a local HTTP server on 127.0.0.1,
 *   opens the Google consent page and catches the redirect with the auth code.
 * - Afterwards: getAccessToken() exchanges the stored refresh token
 *   for a short-lived access token (with in-memory cache).
 */
export class OAuthManager {
  private settings: PluginSettings;
  private cachedAccessToken: string | null = null;
  private cachedTokenExpiryMs = 0;

  constructor(settings: PluginSettings) {
    this.settings = settings;
  }

  /** Is enough configured to fetch tokens? */
  isConfigured(): boolean {
    return Boolean(
      this.settings.clientId &&
        this.settings.clientSecret &&
        this.settings.refreshToken
    );
  }

  /**
   * Starts the interactive login. Opens the browser and waits for the
   * redirect. Stores the refresh token in the settings (the caller must
   * subsequently call saveSettings()).
   *
   * @returns email of the signed-in account (best effort) or null.
   */
  async openLogin(openBrowser: (url: string) => void): Promise<void> {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      throw new Error(t("oauthCredentialsMissing"));
    }

    log.info("Login gestartet, warte auf Redirect…");
    const { code, redirectUri } = await this.awaitAuthCode(openBrowser);
    log.info(
      "Auth-Code empfangen, tausche gegen Token (redirect_uri=" +
        redirectUri +
        ")"
    );
    const tokenResp = await this.exchangeCodeForTokens(code, redirectUri);
    log.info(
      "Token-Antwort erhalten. refresh_token vorhanden:",
      Boolean(tokenResp.refresh_token)
    );

    if (!tokenResp.refresh_token) {
      throw new Error(t("oauthNoRefreshToken"));
    }

    this.settings.refreshToken = tokenResp.refresh_token;
    this.cachedAccessToken = tokenResp.access_token;
    this.cachedTokenExpiryMs = Date.now() + (tokenResp.expires_in - 60) * 1000;
  }

  /**
   * Returns a valid access token; renews it via the refresh token when
   * needed. Throws if not configured.
   */
  async getAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(t("oauthNotSignedIn"));
    }
    // Cache with a 60s safety margin.
    if (this.cachedAccessToken && Date.now() < this.cachedTokenExpiryMs) {
      return this.cachedAccessToken;
    }
    return this.refreshAccessToken();
  }

  /** Forces a token renewal. */
  private async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
      refresh_token: this.settings.refreshToken,
      grant_type: "refresh_token",
    });

    const resp = await requestUrl({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: body.toString(),
      throw: false,
    });

    if (resp.status !== 200) {
      throw new Error(
        t("oauthTokenRefreshFailed", { status: resp.status, text: resp.text })
      );
    }

    const json = resp.json as TokenResponse;
    this.cachedAccessToken = json.access_token;
    this.cachedTokenExpiryMs = Date.now() + (json.expires_in - 60) * 1000;
    return this.cachedAccessToken;
  }

  /** Clears tokens (logout). */
  reset(): void {
    this.settings.refreshToken = "";
    this.cachedAccessToken = null;
    this.cachedTokenExpiryMs = 0;
  }

  /**
   * Starts a one-shot local HTTP server, builds the consent URL,
   * opens the browser and resolves as soon as Google redirects to 127.0.0.1.
   */
  private awaitAuthCode(
    openBrowser: (url: string) => void
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const state = randomToken();
      let settled = false;
      // Set in server.listen() and reused in the callback, so that the
      // consent and token-exchange redirect_uri match exactly.
      let redirectUri = "";

      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "", "http://127.0.0.1");
          log.info("HTTP-Request auf Loopback:", reqUrl.pathname);
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
            reject(e as Error);
          }
        }
      });

      server.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      // Port 0 = any free port.
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        redirectUri = `http://127.0.0.1:${addr.port}/callback`;
        log.info("Loopback-Server lauscht, redirect_uri=" + redirectUri);
        const authUrl =
          GOOGLE_AUTH_ENDPOINT +
          "?" +
          new URLSearchParams({
            client_id: this.settings.clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: OAUTH_SCOPE,
            access_type: "offline",
            prompt: "consent", // forces a refresh token even on repeated login
            state,
          }).toString();
        openBrowser(authUrl);
      });

      // Timeout after 5 minutes.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error(t("oauthTimeout")));
        }
      }, 5 * 60 * 1000);
    });
  }

  private async exchangeCodeForTokens(
    code: string,
    redirectUri: string
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const resp = await requestUrl({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: body.toString(),
      throw: false,
    });

    if (resp.status !== 200) {
      log.error("Token-Austausch fehlgeschlagen:", resp.status, resp.text);
      throw new Error(
        t("oauthCodeExchangeFailed", { status: resp.status, text: resp.text })
      );
    }
    return resp.json as TokenResponse;
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

function randomToken(): string {
  // No crypto need here beyond the CSRF state; simple, sufficient entropy.
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += Math.floor((1 + Math.random()) * 0x100000000)
      .toString(16)
      .slice(1);
  }
  return s;
}
