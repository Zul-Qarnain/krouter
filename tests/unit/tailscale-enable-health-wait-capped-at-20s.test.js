// 0.5.165 (upstream e7c269b8) — enabling Tailscale Funnel waited out the full
// 180 s HEALTH_CHECK.timeoutMs when the *.ts.net name did not resolve yet, so the
// dashboard toggle hung for about three minutes before it reported success.
// The timeout is non-fatal there (the watchdog re-verifies later), so the enable
// flow now waits 20 s; everything else keeps the 180 s budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/tunnel/shared/dnsResolver.js", () => ({
  resolveDns: vi.fn(async () => false), // DNS still propagating: never reachable
}));

vi.mock("../../src/lib/tunnel/tailscale/tailscale.js", () => ({
  startFunnel: vi.fn(async () => ({ tunnelUrl: "https://abc123.tail0.ts.net" })),
  stopFunnel: vi.fn(),
  isTailscaleRunning: vi.fn(() => true),
  isTailscaleRunningStrict: vi.fn(async () => true),
  isTailscaleLoggedIn: vi.fn(() => true),
  isTailscaleLoggedInStrict: vi.fn(async () => true),
  startLogin: vi.fn(async () => ({})),
  startDaemonWithPassword: vi.fn(async () => {}),
  provisionCert: vi.fn(async () => {}),
}));

vi.mock("../../src/lib/tunnel/shared/state.js", () => ({
  loadState: vi.fn(() => ({ shortId: "abc123" })),
  generateShortId: vi.fn(() => "abc123"),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => ({})),
}));

vi.mock("@/mitm/manager", () => ({
  getCachedPassword: vi.fn(() => ""),
  loadEncryptedPassword: vi.fn(async () => ""),
  initDbHooks: vi.fn(),
}));

const { waitForHealth } = await import("../../src/lib/tunnel/tailscale/healthCheck.js");
const { enableTailscale } = await import("../../src/lib/tunnel/tailscale/manager.js");
const { HEALTH_CHECK } = await import("../../src/lib/tunnel/tailscale/config.js");

const ENABLE_WAIT_MS = 20000;

describe("Tailscale health wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("honours a caller-supplied timeoutMs", async () => {
    let message;
    waitForHealth("https://abc123.tail0.ts.net", { cancelled: false }, { timeoutMs: 5000 })
      .then(() => { message = "ok"; }, (e) => { message = e.message; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(message).toBe("Health check timeout after 5000ms");
  });

  it("keeps the 180 s default when no timeout is given", async () => {
    let settled = false;
    const outcome = waitForHealth("https://abc123.tail0.ts.net").then(
      () => "ok",
      (e) => e.message,
    ).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK.timeoutMs);
    expect(await outcome).toBe(`Health check timeout after ${HEALTH_CHECK.timeoutMs}ms`);
  });

  it("enable returns success within ~20 s when the funnel URL is not reachable yet", async () => {
    let result;
    enableTailscale(4567).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(ENABLE_WAIT_MS + 3000);
    expect(result).toEqual({ success: true, tunnelUrl: "https://abc123.tail0.ts.net" });
  });
});
