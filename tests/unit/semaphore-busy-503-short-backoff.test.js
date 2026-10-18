// 0.5.166 (kRouter-own) — when every concurrency slot on an account is taken,
// chatCore answers 503 "Account <id> busy, try another". That matched no error
// rule, so markAccountUnavailable wrote the 30s transient default lock to the DB:
// a burst of parallel IDE requests parked every account for 30s although the
// slots free up within seconds. It now gets the short overloaded backoff
// (2s, doubling). Other 5xx keep the 30s default.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({ rows: {} }));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  validateApiKey: vi.fn(async () => true),
  updateProviderConnection: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
  updateProviderConnectionAtomic: vi.fn(async (id, compute) => {
    const existing = db.rows[id] || { id };
    const patch = compute(existing);
    if (!patch) return null;
    db.rows[id] = { ...existing, ...patch };
    return db.rows[id];
  }),
}));
vi.mock("@/shared/services/healthCache.js", () => ({
  getCachedConnections: vi.fn(async () => []),
  lockAccountInMemory: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

// The exact text chatCore's semaphore timeout produces.
const BUSY = "Account 1a2b3c4d busy, try another";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

describe("busy 503 from the per-account concurrency limit", () => {
  it("gets the short doubling backoff, not the 30s default", () => {
    const first = checkFallbackError(503, BUSY, 0);
    expect(first.shouldFallback).toBe(true);
    expect(first.cooldownMs).toBe(2000);
    expect(first.newBackoffLevel).toBe(1);
    expect(checkFallbackError(503, BUSY, 1).cooldownMs).toBe(4000);
  });

  it("leaves other 5xx on the transient default", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(checkFallbackError(status, "upstream exploded").cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
    }
  });

  describe("lock written by markAccountUnavailable", () => {
    beforeEach(() => { db.rows = {}; vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => vi.useRealTimers());

    it("parks the model for 2s and keeps failing over to the next account", async () => {
      db.rows.k1 = { id: "k1", provider: "kiro" };
      const out = await markAccountUnavailable("k1", 503, BUSY, "kiro", "claude-sonnet-5");
      expect(out.shouldFallback).toBe(true);
      expect(out.cooldownMs).toBe(2000);
      expect(new Date(db.rows.k1["modelLock_claude-sonnet-5"]).getTime() - NOW).toBe(2000);
      expect(db.rows.k1.backoffLevel).toBe(1);
    });
  });
});
