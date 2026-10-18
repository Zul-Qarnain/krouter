// 0.5.166 (upstream 9f41ee75, fallback half) — Codex answers a model the
// ChatGPT plan cannot use with a 400:
//   "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."
// That is about THIS account's plan, so lock that model on that account and try
// the next account. A plain 400 (bad body) from Codex stays request-scoped.
// Account selection also skips a Codex connection whose enabledModels list
// leaves the requested model out.
import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ rows: {}, conns: [] }));

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
  getCachedConnections: vi.fn(async () => db.conns),
  lockAccountInMemory: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("open-sse/services/quotaPreflight.js", () => ({
  isAccountAboveThreshold: vi.fn(() => true),
  warmQuotaCache: vi.fn(),
  invalidateQuotaCache: vi.fn(),
  recordQuotaCacheHit: vi.fn(),
}));
vi.mock("open-sse/services/accountSelector.js", () => ({
  selectAccount: vi.fn((accounts) => ({ account: accounts[0] })),
  getRoundRobinState: vi.fn(() => ({})),
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";
import { markAccountUnavailable, getProviderCredentials } from "../../src/sse/services/auth.js";

const UNSUPPORTED = JSON.stringify({
  detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
});

describe("checkFallbackError: Codex ChatGPT-plan model rejection", () => {
  it("falls back and holds the model when the provider is codex (id or cx alias)", () => {
    for (const provider of ["codex", "cx"]) {
      const r = checkFallbackError(400, UNSUPPORTED, 0, provider);
      expect(r.shouldFallback).toBe(true);
      expect(r.cooldownMs).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
      expect(r.accountLock).toBeFalsy();
    }
  });

  it("does not apply the codex rule to other providers", () => {
    const r = checkFallbackError(400, UNSUPPORTED, 0, "openai");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("keeps an ordinary Codex 400 request-scoped", () => {
    const r = checkFallbackError(400, "Invalid JSON body", 0, "codex");
    expect(r.shouldFallback).toBe(false);
  });
});

describe("markAccountUnavailable on the Codex plan rejection", () => {
  beforeEach(() => { db.rows = {}; });

  it("locks only that model on that account and asks for the next account", async () => {
    db.rows.acc1 = { id: "acc1", provider: "codex" };
    const out = await markAccountUnavailable("acc1", 400, UNSUPPORTED, "codex", "gpt-5.4");
    expect(out.shouldFallback).toBe(true);
    expect(out.accountLock).toBe(false);
    expect(db.rows.acc1["modelLock_gpt-5.4"]).toBeTruthy();
    expect(db.rows.acc1.modelLock___all).toBeUndefined();
  });
});

describe("getProviderCredentials honours Codex enabledModels", () => {
  beforeEach(() => {
    db.conns = [
      { id: "plus-only", provider: "codex", isActive: true, accessToken: "a", providerSpecificData: { enabledModels: ["gpt-5.5"] } },
      { id: "pro", provider: "codex", isActive: true, accessToken: "b", providerSpecificData: {} },
    ];
  });

  it("skips a codex connection whose enabledModels leave the model out", async () => {
    const creds = await getProviderCredentials("codex", null, "gpt-5.4");
    expect(creds.connectionId).toBe("pro");
  });

  it("still uses it for a model it lists", async () => {
    const creds = await getProviderCredentials("codex", null, "gpt-5.5");
    expect(creds.connectionId).toBe("plus-only");
  });

  it("leaves other providers alone", async () => {
    db.conns = db.conns.map((c) => ({ ...c, provider: "openai" }));
    const creds = await getProviderCredentials("openai", null, "gpt-5.4");
    expect(creds.connectionId).toBe("plus-only");
  });
});
