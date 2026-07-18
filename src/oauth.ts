import * as http from "http";
import { AddressInfo } from "net";
import { requestUrl } from "obsidian";
import { OAUTH_SCOPE, PluginSettings } from "./types";
import { log } from "./logger";
import { t } from "./i18n";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Verwaltet den OAuth-2.0-Flow gegen Google für eine vom Nutzer selbst
 * angelegte Cloud-App ("Desktop"/Loopback-Flow).
 *
 * - Erstanmeldung: openLogin() startet einen lokalen HTTP-Server auf 127.0.0.1,
 *   öffnet die Google-Consent-Seite und fängt den Redirect mit dem Auth-Code ab.
 * - Danach: getAccessToken() tauscht den gespeicherten Refresh-Token
 *   gegen einen kurzlebigen Access-Token (mit In-Memory-Cache).
 */
export class OAuthManager {
  private settings: PluginSettings;
  private cachedAccessToken: string | null = null;
  private cachedTokenExpiryMs = 0;

  constructor(settings: PluginSettings) {
    this.settings = settings;
  }

  /** Ist genug konfiguriert, um Tokens zu holen? */
  isConfigured(): boolean {
    return Boolean(
      this.settings.clientId &&
        this.settings.clientSecret &&
        this.settings.refreshToken
    );
  }

  /**
   * Startet den interaktiven Login. Öffnet den Browser und wartet auf den
   * Redirect. Speichert den Refresh-Token in den Settings (Aufrufer muss
   * anschließend saveSettings() aufrufen).
   *
   * @returns E-Mail des angemeldeten Kontos (best effort) oder null.
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
   * Liefert einen gültigen Access-Token; erneuert bei Bedarf über den
   * Refresh-Token. Wirft, wenn nicht konfiguriert.
   */
  async getAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(t("oauthNotSignedIn"));
    }
    // Cache mit 60s Sicherheitsmarge.
    if (this.cachedAccessToken && Date.now() < this.cachedTokenExpiryMs) {
      return this.cachedAccessToken;
    }
    return this.refreshAccessToken();
  }

  /** Erzwingt eine Token-Erneuerung. */
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

  /** Löscht Tokens (Logout). */
  reset(): void {
    this.settings.refreshToken = "";
    this.cachedAccessToken = null;
    this.cachedTokenExpiryMs = 0;
  }

  /**
   * Startet einen einmaligen lokalen HTTP-Server, baut die Consent-URL,
   * öffnet den Browser und resolved sobald Google auf 127.0.0.1 redirected.
   */
  private awaitAuthCode(
    openBrowser: (url: string) => void
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const state = randomToken();
      let settled = false;
      // Wird in server.listen() gesetzt und im Callback wiederverwendet,
      // damit Consent- und Token-Austausch-redirect_uri exakt übereinstimmen.
      let redirectUri = "";

      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "", "http://127.0.0.1");
          log.info("HTTP-Request auf Loopback:", reqUrl.pathname);
          // Browser fragt oft /favicon.ico an -> ignorieren, nicht als Fehler werten.
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
          // Server erst schließen, wenn die Response rausgeschrieben ist.
          res.on("finish", () => server.close());

          if (error) return reject(new Error(t("oauthError", { error })));
          if (!code) return reject(new Error(t("oauthNoCode")));
          if (returnedState !== state)
            return reject(new Error(t("oauthStateMismatch")));

          // WICHTIG: exakt dieselbe redirect_uri wie beim Consent verwenden,
          // sonst lehnt Google den Token-Austausch mit redirect_uri_mismatch ab.
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

      // Port 0 = beliebiger freier Port.
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
            prompt: "consent", // erzwingt Refresh-Token auch bei erneutem Login
            state,
          }).toString();
        openBrowser(authUrl);
      });

      // Timeout nach 5 Minuten.
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
  // Kein Krypto-Bedarf hier über CSRF-State hinaus; einfache, ausreichende Entropie.
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += Math.floor((1 + Math.random()) * 0x100000000)
      .toString(16)
      .slice(1);
  }
  return s;
}
