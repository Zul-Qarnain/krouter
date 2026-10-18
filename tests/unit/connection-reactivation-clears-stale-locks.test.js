// 0.5.165 — an OAuth re-login (or a validated key edit) marks the connection
// testStatus "active" but merged with { ...existing, ...data }, so every
// modelLock_*, backoffLevel, rateLimitedUntil and errorCode survived and the
// freshly re-logged account kept being skipped. Only Test connection cleared
// them. Upstream 7fee56ba, adapted:
//   - an account-wide hold that a new login does not lift (the 0.5.164 Anthropic
//     spend cap, GitHub/Kiro monthly quota, a permanent ban) is kept with the
//     status that explains it; Test connection still clears it with a live probe;
//   - routine updates that also write testStatus "active" (a successful request
//     in clearAccountError, a mid-request token refresh) keep other models'
//     locks, so the reset is opt-in on update.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

function closeDb() {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
}

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2001-01-01T00:00:00.000Z";
const SPEND_CAP_REASON = "Anthropic monthly spend cap reached — paused until 2099-01-01 00:00 UTC (raise the cap in Claude Console, then Test connection)";

function mockNextServer() {
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
}

async function lockedOauth(provider, email, extra = {}) {
  const c = await db.createProviderConnection({ provider, authType: "oauth", email, accessToken: "old-token" });
  await db.updateProviderConnection(c.id, {
    testStatus: "unavailable",
    lastError: "Access denied",
    lastErrorAt: "2026-10-01T00:00:00.000Z",
    errorCode: 403,
    backoffLevel: 3,
    rateLimitedUntil: FUTURE,
    modelLock_modelA: FUTURE,
    modelLock_modelB: FUTURE,
    ...extra,
  });
  return c;
}

function relogin(provider, email) {
  return db.createProviderConnection({ provider, authType: "oauth", email, accessToken: "new-token", testStatus: "active" });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-reactivation-"));
  process.env.DATA_DIR = tempDir;
  // The DB adapter is cached on global (survives Next.js hot reload), so a fresh
  // DATA_DIR needs a fresh adapter.
  closeDb();
  vi.resetModules();
  db = await import("@/lib/db/index.js");
});

afterEach(() => {
  vi.doUnmock("next/server");
  vi.resetModules();
  closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("OAuth re-login clears stale routing locks", () => {
  it("drops per-model locks and resets backoff, rateLimitedUntil, errorCode and lastError", async () => {
    const c = await lockedOauth("claude", "me@example.com");

    const back = await relogin("claude", "me@example.com");

    expect(back.id).toBe(c.id);
    const row = await db.getProviderConnectionById(c.id);
    expect(row.accessToken).toBe("new-token");
    expect(row).toMatchObject({ testStatus: "active", backoffLevel: 0 });
    expect(row.modelLock_modelA ?? null).toBeNull();
    expect(row.modelLock_modelB ?? null).toBeNull();
    expect(row.rateLimitedUntil ?? null).toBeNull();
    expect(row.errorCode ?? null).toBeNull();
    expect(row.lastError ?? null).toBeNull();
    expect(row.lastErrorAt ?? null).toBeNull();
  });

  it("keeps an active spend-cap hold (modelLock___all) and the status that explains it", async () => {
    const c = await lockedOauth("claude", "capped@example.com", {
      modelLock___all: FUTURE,
      lastError: SPEND_CAP_REASON,
      errorCode: 429,
      backoffLevel: 0,
    });

    await relogin("claude", "capped@example.com");

    const row = await db.getProviderConnectionById(c.id);
    expect(row.accessToken).toBe("new-token");
    expect(row.modelLock___all).toBe(FUTURE);
    expect(row).toMatchObject({ testStatus: "unavailable", lastError: SPEND_CAP_REASON, errorCode: 429 });
    // The stale per-model locks still go.
    expect(row.modelLock_modelA ?? null).toBeNull();
    expect(row.modelLock_modelB ?? null).toBeNull();
  });

  it("clears an account-wide lock that has already expired", async () => {
    const c = await lockedOauth("claude", "expired@example.com", { modelLock___all: PAST });

    await relogin("claude", "expired@example.com");

    const row = await db.getProviderConnectionById(c.id);
    expect(row.modelLock___all ?? null).toBeNull();
    expect(row.testStatus).toBe("active");
  });

  it("keeps a permanent ban (isPermanentlyBanned / bannedAt) for Test connection to lift", async () => {
    const bannedAt = "2026-10-02T00:00:00.000Z";
    const c = await lockedOauth("antigravity", "banned@example.com", {
      testStatus: "banned",
      lastError: "Verify your account: https://accounts.google.com/signin/continue?x=1",
      isPermanentlyBanned: true,
      bannedAt,
      modelLock___all: PAST,
    });

    await relogin("antigravity", "banned@example.com");

    const row = await db.getProviderConnectionById(c.id);
    expect(row).toMatchObject({ isPermanentlyBanned: true, bannedAt, testStatus: "banned" });
    expect(row.lastError).toMatch(/^Verify your account/);
    expect(row.modelLock_modelA ?? null).toBeNull();
  });

  it("leaves the health state alone when the re-save does not say active", async () => {
    const c = await lockedOauth("claude", "plain@example.com");

    await db.createProviderConnection({ provider: "claude", authType: "oauth", email: "plain@example.com", accessToken: "new-token" });

    const row = await db.getProviderConnectionById(c.id);
    expect(row.modelLock_modelA).toBe(FUTURE);
    expect(row.backoffLevel).toBe(3);
  });
});

describe("updates that write testStatus active", () => {
  it("a routine update (successful request on model A) keeps model B's lock", async () => {
    const c = await lockedOauth("claude", "routine@example.com");

    // clearAccountError's 0.5.100 branch: clear the succeeded model, mark the
    // account active, keep the other models' cooldowns.
    await db.updateProviderConnection(c.id, { modelLock_modelA: null, testStatus: "active", lastError: null, backoffLevel: 0 });

    const row = await db.getProviderConnectionById(c.id);
    expect(row.testStatus).toBe("active");
    expect(row.modelLock_modelB).toBe(FUTURE);
  });

  it("an opted-in reactivation clears every stale per-model lock", async () => {
    const c = await lockedOauth("claude", "validated@example.com");

    await db.updateProviderConnection(c.id, { testStatus: "active" }, { reactivate: true });

    const row = await db.getProviderConnectionById(c.id);
    expect(row).toMatchObject({ testStatus: "active", backoffLevel: 0 });
    expect(row.modelLock_modelA ?? null).toBeNull();
    expect(row.modelLock_modelB ?? null).toBeNull();
    expect(row.errorCode ?? null).toBeNull();
  });

  it("an opted-in reactivation keeps an explicit soft warning", async () => {
    const c = await lockedOauth("claude", "warning@example.com");
    const warningAt = "2026-10-03T00:00:00.000Z";

    await db.updateProviderConnection(
      c.id,
      { testStatus: "active", lastError: "Connected, but credits are exhausted", lastErrorAt: warningAt },
      { reactivate: true },
    );

    const row = await db.getProviderConnectionById(c.id);
    expect(row).toMatchObject({ testStatus: "active", lastError: "Connected, but credits are exhausted", lastErrorAt: warningAt });
    expect(row.modelLock_modelA ?? null).toBeNull();
  });
});

describe("PUT /api/providers/[id] after a successful key validation", () => {
  async function put(id, body) {
    mockNextServer();
    const { PUT } = await import("@/app/api/providers/[id]/route.js");
    return PUT(
      new Request(`https://krouter.local/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  async function lockedKey() {
    const c = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-old" });
    await db.updateProviderConnection(c.id, { testStatus: "unavailable", errorCode: 401, backoffLevel: 2, modelLock_gpt: FUTURE });
    return c;
  }

  it("clears the old key's stale locks when the edit marks it active", async () => {
    const c = await lockedKey();

    const res = await put(c.id, { apiKey: "sk-new", testStatus: "active", lastError: null, lastErrorAt: null });
    expect(res.status).toBe(200);

    const row = await db.getProviderConnectionById(c.id);
    expect(row.apiKey).toBe("sk-new");
    expect(row).toMatchObject({ testStatus: "active", backoffLevel: 0 });
    expect(row.modelLock_gpt ?? null).toBeNull();
    expect(row.errorCode ?? null).toBeNull();
  });

  it("keeps the locks on an edit that does not mark it active (toggle, rename)", async () => {
    const c = await lockedKey();

    const res = await put(c.id, { name: "Renamed" });
    expect(res.status).toBe(200);

    const row = await db.getProviderConnectionById(c.id);
    expect(row.name).toBe("Renamed");
    expect(row.modelLock_gpt).toBe(FUTURE);
    expect(row.backoffLevel).toBe(2);
  });
});
