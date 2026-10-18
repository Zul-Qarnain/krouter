// 0.5.166 — Codex refresh-token reuse must never happen (upstream 0bc7f86e).
//
// OpenAI rotates the Codex refresh token on every refresh and revokes the whole
// session when an already-rotated token is presented again. Three background
// writers (usage poll, quota auto-ping, token warmer) and the chat path each
// hold their own snapshot of a connection. These tests drive the real refresh
// pipeline (executor -> oauthCredentialManager -> refreshCodexToken) against a
// fake OpenAI token endpoint that rotates and detects reuse, with an in-memory
// connection store standing in for SQLite.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = new Map();
const cache = new Map();

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(async (id) => (store.has(id) ? { ...store.get(id) } : null)),
  updateProviderConnection: vi.fn(async (id, data) => {
    if (!store.has(id)) return null;
    const merged = { ...store.get(id), ...data };
    store.set(id, merged);
    return merged;
  }),
}));
vi.mock("@/shared/services/healthCache.js", () => ({
  getCachedConnectionById: vi.fn(async (id) => (cache.has(id) ? { ...cache.get(id) } : null)),
  updateCachedConnection: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn(async () => ({})) }));
vi.mock("open-sse/services/quotaPreflight.js", () => ({
  getQuotaCacheInfo: vi.fn(() => null),
  forceRefreshQuota: vi.fn(async () => {}),
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
  invalidateProjectId: vi.fn(),
  removeConnection: vi.fn(),
}));

const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

const originalFetch = global.fetch;
const MIN = 60 * 1000;
let seq = 0;

// Fake auth.openai.com/oauth/token: one live refresh token per account; using
// an older one is "reuse" and revokes the family, as OpenAI does.
function installOpenAiTokenServer(initialRefreshToken) {
  const state = { live: initialRefreshToken, used: new Set(), calls: 0, reuses: 0, presented: [] };
  global.fetch = vi.fn(async (url, init) => {
    if (!String(url).includes("auth.openai.com/oauth/token")) throw new Error(`unexpected fetch ${url}`);
    state.calls += 1;
    const presented = JSON.parse(init.body).refresh_token;
    state.presented.push(presented);
    if (presented !== state.live) {
      if (state.used.has(presented)) state.reuses += 1;
      return new Response(JSON.stringify({ error: { code: "refresh_token_reused", message: "already used" } }), { status: 401 });
    }
    state.used.add(presented);
    seq += 1;
    state.live = `rt-${seq}-next`;
    return new Response(JSON.stringify({
      access_token: `at-${seq}`,
      refresh_token: state.live,
      id_token: `id-${seq}`,
      expires_in: 3600,
    }), { status: 200 });
  });
  return state;
}

function seedCodexConnection(id, refreshToken, { expiresInMs = 5 * MIN } = {}) {
  const row = {
    id,
    provider: "codex",
    authType: "oauth",
    accessToken: `at-old-${id}`,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    lastRefreshAt: new Date(Date.now() - 55 * MIN).toISOString(),
    providerSpecificData: { accountId: "acct-1" },
  };
  store.set(id, row);
  return { ...row };
}

describe("Codex refresh-token reuse (usage poll / auto-ping / warmer path)", () => {
  beforeEach(() => {
    store.clear();
    cache.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("a second writer holding a stale snapshot does not refresh again with the rotated token", async () => {
    const id = `cx-stale-${Date.now()}`;
    const rt = `rt-stale-${Math.random()}`;
    const snapshot = seedCodexConnection(id, rt); // e.g. the warmer's copy
    const server = installOpenAiTokenServer(rt);

    // Writer A (auto-ping) refreshes first and rotates the token.
    const a = await refreshAndUpdateCredentials({ ...snapshot }, false, null);
    expect(a.refreshed).toBe(true);
    expect(store.get(id).refreshToken).toBe(server.live);

    // Past the 10 s in-process de-dup window, writer B still holds the old row.
    vi.setSystemTime(new Date(Date.now() + 15 * 1000));
    const b = await refreshAndUpdateCredentials({ ...snapshot }, false, null);

    expect(server.reuses).toBe(0);
    expect(server.calls).toBe(1);
    expect(b.refreshed).toBe(false);
    expect(b.connection.refreshToken).toBe(server.live);
    expect(b.connection.accessToken).toBe(store.get(id).accessToken);
  });

  it("two concurrent refreshers on one snapshot make a single network refresh", async () => {
    const id = `cx-concurrent-${Date.now()}`;
    const rt = `rt-concurrent-${Math.random()}`;
    const snapshot = seedCodexConnection(id, rt);
    const server = installOpenAiTokenServer(rt);

    const [a, b] = await Promise.all([
      refreshAndUpdateCredentials({ ...snapshot }, false, null),
      refreshAndUpdateCredentials({ ...snapshot }, false, null),
    ]);

    expect(server.calls).toBe(1);
    expect(server.reuses).toBe(0);
    expect(a.connection.accessToken).toBe(b.connection.accessToken);
  });

  it("does not refresh a Codex token that still has most of its life left", async () => {
    const id = `cx-fresh-${Date.now()}`;
    const rt = `rt-fresh-${Math.random()}`;
    const snapshot = seedCodexConnection(id, rt, { expiresInMs: 45 * MIN });
    const server = installOpenAiTokenServer(rt);

    const r = await refreshAndUpdateCredentials({ ...snapshot }, false, null);

    expect(r.refreshed).toBe(false);
    expect(server.calls).toBe(0);
  });

  it("throws instead of carrying on with a dead token when the refresh token is rejected", async () => {
    const id = `cx-dead-${Date.now()}`;
    const snapshot = seedCodexConnection(id, `rt-dead-${Math.random()}`);
    installOpenAiTokenServer("rt-someone-else-holds-the-live-one");

    await expect(refreshAndUpdateCredentials({ ...snapshot }, false, null)).rejects.toThrow(/re-authorize/i);
    // The stored row keeps its tokens; nothing pretends the refresh worked.
    expect(store.get(id).accessToken).toBe(snapshot.accessToken);
    expect(store.get(id).refreshToken).toBe(snapshot.refreshToken);
  });
});

describe("Codex refresh-token reuse (chat path checkAndRefreshToken)", () => {
  beforeEach(() => {
    store.clear();
    cache.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  const proxyPsd = {
    accountId: "acct-1",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.local:8080",
  };

  it("adopts the token another writer just stored instead of refreshing with the rotated one", async () => {
    const id = `cx-chat-${Date.now()}`;
    const oldRt = `rt-chat-old-${Math.random()}`;
    const liveRt = `rt-chat-live-${Math.random()}`;
    // The request's credentials were read before the warmer rotated the token.
    const requestCreds = {
      connectionId: id,
      accessToken: "at-stale",
      refreshToken: oldRt,
      expiresAt: new Date(Date.now() + 4 * MIN).toISOString(),
      lastRefreshAt: new Date(Date.now() - 56 * MIN).toISOString(),
      providerSpecificData: proxyPsd,
    };
    // The health cache has not synced yet; the DB already holds the new pair.
    cache.set(id, { ...requestCreds, id, providerSpecificData: { accountId: "acct-1" } });
    store.set(id, {
      id,
      provider: "codex",
      accessToken: "at-live",
      refreshToken: liveRt,
      expiresAt: new Date(Date.now() + 60 * MIN).toISOString(),
      lastRefreshAt: new Date(Date.now() - 1000).toISOString(),
      providerSpecificData: { accountId: "acct-1" },
    });
    const server = installOpenAiTokenServer(liveRt);
    server.used.add(oldRt);

    const out = await checkAndRefreshToken("codex", requestCreds);

    expect(server.calls).toBe(0);
    expect(server.reuses).toBe(0);
    expect(out.accessToken).toBe("at-live");
    expect(out.refreshToken).toBe(liveRt);
    // Request-scoped proxy fields resolved by auth.js survive the adoption.
    expect(out.providerSpecificData).toEqual(proxyPsd);
    // The caller's object is never mutated.
    expect(requestCreds.refreshToken).toBe(oldRt);
  });

  it("refreshes with the newest stored refresh token when the stored access token is also near expiry", async () => {
    const id = `cx-chat-near-${Date.now()}`;
    const oldRt = `rt-near-old-${Math.random()}`;
    const liveRt = `rt-near-live-${Math.random()}`;
    const requestCreds = {
      connectionId: id,
      accessToken: "at-stale",
      refreshToken: oldRt,
      expiresAt: new Date(Date.now() + 2 * MIN).toISOString(),
      lastRefreshAt: new Date(Date.now() - 58 * MIN).toISOString(),
      providerSpecificData: proxyPsd,
    };
    const newer = {
      id,
      accessToken: "at-newer",
      refreshToken: liveRt,
      expiresAt: new Date(Date.now() + 3 * MIN).toISOString(),
      lastRefreshAt: new Date(Date.now() - 57 * MIN).toISOString(),
      providerSpecificData: { accountId: "acct-1" },
    };
    cache.set(id, newer);
    store.set(id, { ...newer, provider: "codex" });
    const server = installOpenAiTokenServer(liveRt);
    server.used.add(oldRt);

    const out = await checkAndRefreshToken("codex", requestCreds);

    expect(server.reuses).toBe(0);
    expect(server.presented).toEqual([liveRt]);
    expect(out.accessToken).toMatch(/^at-\d+$/);
    expect(out.providerSpecificData.connectionProxyEnabled).toBe(true);
  });

  it("keeps the request's proxy fields when adopting a fresher token from the health cache", async () => {
    const id = `cx-chat-cache-${Date.now()}`;
    const rt = `rt-cache-${Math.random()}`;
    const requestCreds = {
      connectionId: id,
      accessToken: "at-stale",
      refreshToken: rt,
      expiresAt: new Date(Date.now() + 1 * MIN).toISOString(),
      providerSpecificData: proxyPsd,
    };
    cache.set(id, {
      id,
      accessToken: "at-cached",
      refreshToken: rt,
      expiresAt: new Date(Date.now() + 60 * MIN).toISOString(),
      lastRefreshAt: Date.now(),
      providerSpecificData: { accountId: "acct-1" },
    });
    const server = installOpenAiTokenServer(rt);

    const out = await checkAndRefreshToken("codex", requestCreds);

    expect(server.calls).toBe(0);
    expect(out.accessToken).toBe("at-cached");
    expect(out.providerSpecificData).toEqual(proxyPsd);
  });
});
