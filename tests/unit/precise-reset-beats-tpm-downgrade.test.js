// 0.5.165 (kRouter-own) — a 429 that says "rate limit" AND carries a precise
// reset (Codex usage_limit_reached resets_at, a Retry-After, Google retryDelay)
// was cut to the 90s TPM lock whenever the quota cache looked healthy, and that
// cache fails open when it is cold. The provider told us when the model comes
// back; follow that (still capped at MAX_QUOTA_RESET_COOLDOWN_MS).
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
// Daily quota looks healthy (or the cache is cold, which fails open the same way).
vi.mock("open-sse/services/quotaPreflight.js", () => ({
  isAccountAboveThreshold: vi.fn(() => true),
  warmQuotaCache: vi.fn(),
  invalidateQuotaCache: vi.fn(),
  recordQuotaCacheHit: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { markAccountUnavailable } from "../../src/sse/services/auth.js";
import { MAX_QUOTA_RESET_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const lockMs = (row, model) => new Date(row[`modelLock_${model}`]).getTime() - NOW;

describe("markAccountUnavailable: precise reset vs TPM downgrade", () => {
  beforeEach(() => {
    db.rows = {};
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("follows a resetsAtMs 3h out instead of the 90s TPM lock", async () => {
    db.rows.cx1 = { id: "cx1", provider: "codex" };
    const out = await markAccountUnavailable("cx1", 429, "Rate limit reached for gpt-5.5", "codex", "gpt-5.5", NOW + 3 * HOUR);
    expect(out.shouldFallback).toBe(true);
    expect(out.cooldownMs).toBe(3 * HOUR);
    expect(lockMs(db.rows.cx1, "gpt-5.5")).toBe(3 * HOUR);
    expect(db.rows.cx1.lastError).not.toMatch(/TPM/);
  });

  it("still caps a far-away reset at MAX_QUOTA_RESET_COOLDOWN_MS", async () => {
    db.rows.cx2 = { id: "cx2", provider: "codex" };
    const out = await markAccountUnavailable("cx2", 429, "Rate limit reached", "codex", "gpt-5.5", NOW + 40 * HOUR);
    expect(out.cooldownMs).toBe(MAX_QUOTA_RESET_COOLDOWN_MS);
    expect(lockMs(db.rows.cx2, "gpt-5.5")).toBe(MAX_QUOTA_RESET_COOLDOWN_MS);
  });

  it("keeps the TPM downgrade for a rate-limit 429 that carries no reset", async () => {
    db.rows.ag1 = { id: "ag1", provider: "antigravity" };
    const out = await markAccountUnavailable("ag1", 429, "Individual quota reached", "antigravity", "gemini-3-pro", null);
    expect(out.cooldownMs).toBe(90 * 1000);
    expect(db.rows.ag1.lastError).toMatch(/TPM/);
  });

  it("ignores a reset that already passed", async () => {
    db.rows.ag2 = { id: "ag2", provider: "antigravity" };
    const out = await markAccountUnavailable("ag2", 429, "Too many requests", "antigravity", "gemini-3-pro", NOW - 1000);
    expect(out.cooldownMs).toBe(90 * 1000);
  });
});
