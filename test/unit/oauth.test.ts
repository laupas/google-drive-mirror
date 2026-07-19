/**
 * Unit tests for OAuthManager — focused on the testable logic without a real
 * browser/HTTP server: isConfigured(), token cache & refresh, reset().
 * The interactive loopback flow (awaitAuthCode) is not tested here
 * (integration/manual test), since it binds a real HTTP server.
 *
 * Format: AAA. `requestUrl` from the obsidian mock is controlled via vi.mocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { requestUrl } from "obsidian";
import { OAuthManager } from "../../src/oauth";
import { DEFAULT_SETTINGS, PluginSettings } from "../../src/types";

const mockedRequestUrl = vi.mocked(requestUrl);

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Replica of a successful token response from requestUrl. */
function tokenResponse(json: Record<string, unknown>) {
  return { status: 200, json, text: JSON.stringify(json) } as unknown;
}

beforeEach(() => {
  mockedRequestUrl.mockReset();
  vi.useRealTimers();
});

describe("OAuthManager.isConfigured", () => {
  it("ist false, wenn der Refresh-Token fehlt", () => {
    // Arrange
    const mgr = new OAuthManager(
      settings({ clientId: "c", clientSecret: "s", refreshToken: "" })
    );

    // Act
    const result = mgr.isConfigured();

    // Assert
    expect(result).toBe(false);
  });

  it("ist false, wenn Client-ID oder Secret fehlt", () => {
    // Arrange
    const mgr = new OAuthManager(
      settings({ clientId: "", clientSecret: "s", refreshToken: "r" })
    );

    // Act & Assert
    expect(mgr.isConfigured()).toBe(false);
  });

  it("ist true, wenn ID, Secret und Refresh-Token gesetzt sind", () => {
    // Arrange
    const mgr = new OAuthManager(
      settings({ clientId: "c", clientSecret: "s", refreshToken: "r" })
    );

    // Act & Assert
    expect(mgr.isConfigured()).toBe(true);
  });
});

describe("OAuthManager.getAccessToken", () => {
  it("wirft, wenn nicht konfiguriert", async () => {
    // Arrange
    const mgr = new OAuthManager(settings({ refreshToken: "" }));

    // Act & Assert
    await expect(mgr.getAccessToken()).rejects.toThrow(/not signed in/i);
    expect(mockedRequestUrl).not.toHaveBeenCalled();
  });

  it("holt bei erstem Aufruf einen neuen Access-Token über den Refresh-Token", async () => {
    // Arrange
    const mgr = new OAuthManager(
      settings({ clientId: "c", clientSecret: "s", refreshToken: "r" })
    );
    mockedRequestUrl.mockResolvedValue(
      tokenResponse({ access_token: "AT-1", expires_in: 3600 })
    );

    // Act
    const token = await mgr.getAccessToken();

    // Assert
    expect(token).toBe("AT-1");
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
  });

  it("nutzt den Cache und ruft requestUrl beim zweiten Aufruf NICHT erneut", async () => {
    // Arrange
    const mgr = new OAuthManager(
      settings({ clientId: "c", clientSecret: "s", refreshToken: "r" })
    );
    mockedRequestUrl.mockResolvedValue(
      tokenResponse({ access_token: "AT-1", expires_in: 3600 })
    );
    await mgr.getAccessToken(); // fills cache

    // Act
    const token = await mgr.getAccessToken();

    // Assert
    expect(token).toBe("AT-1");
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
  });

  it("erneuert den Token, wenn der Cache abgelaufen ist", async () => {
    // Arrange: fixed clock, short lifetime.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const mgr = new OAuthManager(
      settings({ clientId: "c", clientSecret: "s", refreshToken: "r" })
    );
    // expires_in 60s -> expires immediately after the 60s margin; we set 120s.
    mockedRequestUrl.mockResolvedValueOnce(
      tokenResponse({ access_token: "AT-1", expires_in: 120 })
    );
    mockedRequestUrl.mockResolvedValueOnce(
      tokenResponse({ access_token: "AT-2", expires_in: 120 })
    );
    await mgr.getAccessToken(); // AT-1, valid until +60s

    // Act: advance time past the (120-60)=60s margin.
    vi.advanceTimersByTime(61_000);
    const token = await mgr.getAccessToken();

    // Assert
    expect(token).toBe("AT-2");
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("wirft mit sprechender Meldung, wenn die Token-Erneuerung fehlschlägt", async () => {
    // Arrange
    const mgr = new OAuthManager(
      settings({ clientId: "c", clientSecret: "s", refreshToken: "r" })
    );
    mockedRequestUrl.mockResolvedValue({
      status: 400,
      text: "invalid_grant",
      json: {},
    } as unknown);

    // Act & Assert
    await expect(mgr.getAccessToken()).rejects.toThrow(/Token refresh failed/i);
  });
});

describe("OAuthManager.reset", () => {
  it("löscht Refresh-Token und invalidiert den Access-Token-Cache", async () => {
    // Arrange
    const s = settings({ clientId: "c", clientSecret: "s", refreshToken: "r" });
    const mgr = new OAuthManager(s);
    mockedRequestUrl.mockResolvedValue(
      tokenResponse({ access_token: "AT-1", expires_in: 3600 })
    );
    await mgr.getAccessToken(); // fill cache

    // Act
    mgr.reset();

    // Assert: settings cleared and no longer configured.
    expect(s.refreshToken).toBe("");
    expect(mgr.isConfigured()).toBe(false);
    await expect(mgr.getAccessToken()).rejects.toThrow(/not signed in/i);
  });
});
