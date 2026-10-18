// 0.5.166 — token warmer: refresh through the connection's own proxy, and stop
// re-trying a refresh token the provider has already rejected (upstream
// 0bc7f86e makes refreshAndUpdateCredentials throw in that case).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: mocks.getProviderConnections }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
  REFRESH_UNRECOVERABLE_CODE: "REFRESH_TOKEN_UNRECOVERABLE",
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

const { startTokenWarmer, stopTokenWarmer } = await import("../../src/shared/services/tokenWarmer.js");

const FIRST_TICK_MS = 5_000;
const TICK_MS = 60_000;
const GAP_MS = 5 * 60_000;

function dueConnection(overrides = {}) {
  return {
    id: `cx-${Math.random()}`,
    provider: "codex",
    authType: "oauth",
    isActive: true,
    refreshToken: `rt-${Math.random()}`,
    expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    providerSpecificData: { proxyPoolId: "pool-1" },
    ...overrides,
  };
}

describe("token warmer", () => {
  let warnSpy;
  beforeEach(() => {
    vi.clearAllMocks();
    delete global.__krouterTokenWarmer;
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
      connectionNoProxy: "",
      proxyPoolId: "pool-1",
      strictProxy: true,
    });
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ refreshed: true });
  });
  afterEach(() => {
    stopTokenWarmer();
    vi.useRealTimers();
    warnSpy.mockRestore();
    delete global.__krouterTokenWarmer;
  });

  it("resolves the proxy from providerSpecificData and passes normalized proxy options", async () => {
    const conn = dueConnection();
    mocks.getProviderConnections.mockResolvedValue([conn]);

    startTokenWarmer();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);

    expect(mocks.resolveConnectionProxyConfig).toHaveBeenCalledWith(conn.providerSpecificData);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledTimes(1);
    const [, force, proxyOptions] = mocks.refreshAndUpdateCredentials.mock.calls[0];
    expect(force).toBe(false);
    expect(proxyOptions).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
  });

  it("warns once and stops retrying a refresh token the provider rejected", async () => {
    const conn = dueConnection();
    mocks.getProviderConnections.mockResolvedValue([conn]);
    const dead = Object.assign(new Error("Refresh token invalid or already used. Please re-authorize the connection."), {
      code: "REFRESH_TOKEN_UNRECOVERABLE",
    });
    mocks.refreshAndUpdateCredentials.mockRejectedValue(dead);

    startTokenWarmer();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    await vi.advanceTimersByTimeAsync(GAP_MS + TICK_MS * 2);

    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledTimes(1);
    const warnings = warnSpy.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes(conn.id));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/re-authorize/i);
  });

  it("resumes warming once the connection holds a new refresh token", async () => {
    const conn = dueConnection();
    mocks.getProviderConnections.mockResolvedValue([conn]);
    mocks.refreshAndUpdateCredentials.mockRejectedValueOnce(
      Object.assign(new Error("dead"), { code: "REFRESH_TOKEN_UNRECOVERABLE" })
    );

    startTokenWarmer();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    // The user re-authorizes: a fresh refresh token lands in the DB.
    mocks.getProviderConnections.mockResolvedValue([{ ...conn, refreshToken: "rt-after-reauth" }]);
    await vi.advanceTimersByTimeAsync(GAP_MS + TICK_MS);

    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.refreshAndUpdateCredentials.mock.calls[1][0].refreshToken).toBe("rt-after-reauth");
  });
});
