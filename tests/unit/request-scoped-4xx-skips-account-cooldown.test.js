// 0.5.166 (upstream 20a43f5a) — an unmatched 4xx is caused by the request
// (malformed body, unsupported parameter, validation), not by the credential.
// It used to fall through to the 30s transient default: the account (model) was
// locked and, with one connection, every request in that window failed with a
// copy of the first error ("all 1 accounts locked ... lastError=[400]").
//
// kRouter adaptation: a combo still advances to its next member on such a 4xx,
// because the next member is a different model that may accept the request.
// Known account-scoped 400 wordings (billing, bad API key) keep failing over.
import { describe, expect, it, vi, beforeEach } from "vitest";

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
import { handleComboChat } from "../../open-sse/services/combo.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

const quietLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("checkFallbackError: request-scoped vs account-scoped 4xx", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: { message: "Unsupported parameter: 'logit_bias'", type: "invalid_request_error" },
    }));
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("treats 409 / 413 / 422 without account wording as request-scoped too", () => {
    for (const status of [409, 413, 422]) {
      const r = checkFallbackError(status, "validation failed");
      expect(r.shouldFallback).toBe(false);
      expect(r.cooldownMs).toBe(0);
    }
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it("keeps failing over on 400s that are really about the account", () => {
    // Anthropic answers an empty credit balance with 400 invalid_request_error,
    // Gemini a bad key with 400 INVALID_ARGUMENT. Another key can still serve.
    const anthropic = checkFallbackError(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
    expect(anthropic.shouldFallback).toBe(true);
    expect(anthropic.cooldownMs).toBeGreaterThan(0);
    const gemini = checkFallbackError(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
    expect(gemini.shouldFallback).toBe(true);
    expect(gemini.cooldownMs).toBeGreaterThan(0);
  });

  it("keeps the old default for Cursor, whose executor reports every Connect error as 400", () => {
    for (const provider of ["cursor", "cu"]) {
      const r = checkFallbackError(400, "Unauthorized request.", 0, provider);
      expect(r.shouldFallback).toBe(true);
      expect(r.cooldownMs).toBeGreaterThan(0);
    }
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(500, "upstream exploded");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});

describe("markAccountUnavailable on a request-scoped 400", () => {
  beforeEach(() => { db.rows = {}; });

  it("writes no lock and hands the error back for this request only", async () => {
    db.rows.c1 = { id: "c1", provider: "openai" };
    const out = await markAccountUnavailable("c1", 400, "Invalid 'messages[2].content': expected a string", "openai", "gpt-5");
    expect(out).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(Object.keys(db.rows.c1).some((k) => k.startsWith("modelLock_"))).toBe(false);
  });
});

describe("combo on a request-scoped 400", () => {
  it("still advances to the next combo member", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "openai/strict-model") {
        return jsonResponse(400, { error: { message: "Unsupported parameter: 'reasoning_effort'" } });
      }
      return jsonResponse(200, { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/strict-model", "anthropic/lenient-model"],
      handleSingleModel,
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["openai/strict-model", "anthropic/lenient-model"]);
  });

  it("still stops on a deterministic input-size 400 (same request fails everywhere)", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      return jsonResponse(400, { error: { message: "prompt is too long: 250000 tokens > 200000 maximum" } });
    };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["anthropic/a", "anthropic/b"],
      handleSingleModel,
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual(["anthropic/a"]);
  });
});
