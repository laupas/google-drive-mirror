import { Platform, requestUrl } from "obsidian";
import { MOBILE_REDIRECT_URI, OAUTH_SCOPE, PluginSettings } from "./types";
import { log } from "./logger";
import { t } from "./i18n";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Manages the OAuth 2.0 flow against Google for a Cloud app created by the
 * user themselves. Cross-platform (desktop + mobile), with PKCE on both:
 *
 * - Desktop ("Desktop app" client, with secret): loopback flow. A local HTTP
 *   server on 127.0.0.1 catches the redirect. The Node-only server lives in
 *   `oauth-loopback.ts` and is imported LAZILY so mobile never loads `http`.
 * - Mobile (iOS/Android client, no secret): the consent page redirects to
 *   `obsidian://gdrive-auth`, which Obsidian delivers back to the plugin via a
 *   protocol handler; `main.ts` forwards it to `handleMobileRedirect()`.
 *
 * Both paths use PKCE (code_verifier/code_challenge), so no secret is required
 * for the code exchange — the client secret is only sent when present.
 * getAccessToken() exchanges the stored refresh token for a short-lived access
 * token (with in-memory cache).
 */
export class OAuthManager {
  private settings: PluginSettings;
  private cachedAccessToken: string | null = null;
  private cachedTokenExpiryMs = 0;

  /** Pending mobile login awaiting the obsidian:// redirect, if any. */
  private pendingMobile: {
    state: string;
    resolve: (v: { code: string }) => void;
    reject: (e: Error) => void;
  } | null = null;

  constructor(settings: PluginSettings) {
    this.settings = settings;
  }

  /** Is enough configured to fetch tokens? */
  isConfigured(): boolean {
    return Boolean(this.effectiveClientId() && this.settings.refreshToken);
  }

  /**
   * Starts the interactive login. Opens the system browser and waits for the
   * redirect (loopback on desktop, obsidian:// on mobile). Stores the refresh
   * token in the settings (the caller must subsequently call saveSettings()).
   */
  async openLogin(openBrowser: (url: string) => void): Promise<void> {
    const clientId = this.effectiveClientId();
    if (!clientId) {
      throw new Error(t("oauthCredentialsMissing"));
    }

    const state = randomToken();
    const codeVerifier = randomVerifier();
    const codeChallenge = await pkceChallenge(codeVerifier);

    log.info("Login gestartet, warte auf Redirect…");
    const { code, redirectUri } = Platform.isMobileApp
      ? await this.awaitMobileAuthCode(clientId, state, codeChallenge, openBrowser)
      : await this.awaitLoopbackAuthCode(clientId, state, codeChallenge, openBrowser);

    log.info(
      "Auth-Code empfangen, tausche gegen Token (redirect_uri=" +
        redirectUri +
        ")"
    );
    const tokenResp = await this.exchangeCodeForTokens(
      code,
      redirectUri,
      clientId,
      codeVerifier
    );
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
   * Called by the obsidian:// protocol handler (wired in main.ts) with the
   * query params of the redirect. Forwards the auth code to the pending mobile
   * login, if one is waiting.
   */
  handleMobileRedirect(params: Record<string, string>): void {
    const pending = this.pendingMobile;
    if (!pending) return; // no login in progress — ignore stray callbacks
    this.pendingMobile = null;

    if (params.error) {
      pending.reject(new Error(t("oauthError", { error: params.error })));
      return;
    }
    if (params.state !== pending.state) {
      pending.reject(new Error(t("oauthStateMismatch")));
      return;
    }
    if (!params.code) {
      pending.reject(new Error(t("oauthNoCode")));
      return;
    }
    pending.resolve({ code: params.code });
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
    const params: Record<string, string> = {
      client_id: this.effectiveClientId(),
      refresh_token: this.settings.refreshToken,
      grant_type: "refresh_token",
    };
    // Only "Desktop app" clients carry a secret; mobile (PKCE) clients don't.
    if (this.settings.clientSecret) {
      params.client_secret = this.settings.clientSecret;
    }
    const body = new URLSearchParams(params);

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
   * The client ID to use for the current platform: the mobile client ID on
   * mobile when set, otherwise the desktop clientId. (A PKCE mobile client
   * needs no secret, so the desktop clientId also works on mobile if the user
   * registered obsidian:// on it — but Google's Desktop client type won't
   * accept that redirect, hence the dedicated mobileClientId.)
   */
  private effectiveClientId(): string {
    if (Platform.isMobileApp && this.settings.mobileClientId) {
      return this.settings.mobileClientId;
    }
    return this.settings.clientId;
  }

  /** Builds the Google consent URL for a given redirect_uri (with PKCE). */
  private buildAuthUrl(
    clientId: string,
    redirectUri: string,
    state: string,
    codeChallenge: string
  ): string {
    return (
      GOOGLE_AUTH_ENDPOINT +
      "?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPE,
        access_type: "offline",
        prompt: "consent", // forces a refresh token even on repeated login
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      }).toString()
    );
  }

  /**
   * Desktop: run the loopback server (lazy-loaded so `http`/`net` are never
   * imported on mobile) and wait for the redirect.
   */
  private async awaitLoopbackAuthCode(
    clientId: string,
    state: string,
    codeChallenge: string,
    openBrowser: (url: string) => void
  ): Promise<{ code: string; redirectUri: string }> {
    const { awaitLoopbackAuthCode } = await import("./oauth-loopback");
    return awaitLoopbackAuthCode(
      state,
      (redirectUri) =>
        this.buildAuthUrl(clientId, redirectUri, state, codeChallenge),
      openBrowser
    );
  }

  /**
   * Mobile: open the consent page (system browser) and wait for the
   * obsidian:// redirect to be delivered via handleMobileRedirect().
   */
  private awaitMobileAuthCode(
    clientId: string,
    state: string,
    codeChallenge: string,
    openBrowser: (url: string) => void
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      // Abandon any earlier, unfinished attempt.
      if (this.pendingMobile) {
        this.pendingMobile.reject(new Error(t("oauthTimeout")));
      }

      const timeout = window.setTimeout(() => {
        if (this.pendingMobile?.state === state) {
          this.pendingMobile = null;
          reject(new Error(t("oauthTimeout")));
        }
      }, 5 * 60 * 1000);

      this.pendingMobile = {
        state,
        resolve: ({ code }) => {
          window.clearTimeout(timeout);
          resolve({ code, redirectUri: MOBILE_REDIRECT_URI });
        },
        reject: (e) => {
          window.clearTimeout(timeout);
          reject(e);
        },
      };

      log.info("Mobile-Login: öffne Consent, warte auf obsidian:// Redirect");
      openBrowser(
        this.buildAuthUrl(clientId, MOBILE_REDIRECT_URI, state, codeChallenge)
      );
    });
  }

  private async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    clientId: string,
    codeVerifier: string
  ): Promise<TokenResponse> {
    const params: Record<string, string> = {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    };
    // Desktop clients carry a secret; PKCE-only mobile clients don't.
    if (this.settings.clientSecret) {
      params.client_secret = this.settings.clientSecret;
    }
    const body = new URLSearchParams(params);

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

/**
 * A high-entropy PKCE code_verifier (RFC 7636): 43–128 chars from the
 * unreserved set. We build 64 chars from the allowed alphabet.
 */
function randomVerifier(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let s = "";
  for (let i = 0; i < 64; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

/**
 * PKCE S256 challenge: BASE64URL(SHA-256(verifier)). Uses WebCrypto
 * (`crypto.subtle`), available on both desktop and Obsidian mobile.
 */
export async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

/** BASE64URL without padding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
