// 0.5.166 — a token refresh must not re-onboard Antigravity / Gemini-CLI
// accounts (upstream 1442cc73). Eagerly calling loadCodeAssist/onboardUser
// after every refresh, across several accounts at once, trips Google's
// anti-abuse limiter. The chat path resolves a missing projectId on demand
// (src/sse/handlers/chat.js), so the refresh only drops the cached value.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const projectIdMocks = vi.hoisted(() => ({
  getProjectIdForConnection: vi.fn(async () => "proj-fresh"),
  invalidateProjectId: vi.fn(),
  removeConnection: vi.fn(),
}));

vi.mock("open-sse/services/projectId.js", () => projectIdMocks);
vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnectionById: vi.fn(async () => null),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
}));
vi.mock("@/shared/services/healthCache.js", () => ({
  getCachedConnectionById: vi.fn(async () => null),
  updateCachedConnection: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

const originalFetch = global.fetch;
const originalFlag = process.env.EAGER_PROJECT_ID_REFRESH;

function mockGoogleTokenEndpoint() {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({
    access_token: `ya29.fresh-${Math.random()}`,
    expires_in: 3599,
  }), { status: 200 }));
}

function nearExpiryCreds(provider) {
  return {
    connectionId: `${provider}-${Math.random()}`,
    accessToken: "ya29.old",
    refreshToken: `1//rt-${Math.random()}`,
    expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    projectId: "proj-stored",
  };
}

describe("token refresh resolves the Google projectId lazily", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.EAGER_PROJECT_ID_REFRESH;
    mockGoogleTokenEndpoint();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.EAGER_PROJECT_ID_REFRESH;
    else process.env.EAGER_PROJECT_ID_REFRESH = originalFlag;
  });

  it.each(["antigravity", "gemini-cli"])("%s: refresh does not call loadCodeAssist/onboardUser", async (provider) => {
    const out = await checkAndRefreshToken(provider, nearExpiryCreds(provider));

    expect(out.accessToken).toMatch(/^ya29\.fresh-/);
    expect(projectIdMocks.getProjectIdForConnection).not.toHaveBeenCalled();
    // The stale cached projectId is still dropped so an on-demand lookup is real.
    expect(projectIdMocks.invalidateProjectId).toHaveBeenCalledTimes(1);
    // The stored projectId rides along untouched.
    expect(out.projectId).toBe("proj-stored");
  });

  it("EAGER_PROJECT_ID_REFRESH=true keeps the old eager re-fetch as an opt-in", async () => {
    process.env.EAGER_PROJECT_ID_REFRESH = "true";
    const creds = nearExpiryCreds("antigravity");

    await checkAndRefreshToken("antigravity", creds);

    expect(projectIdMocks.getProjectIdForConnection).toHaveBeenCalledTimes(1);
    expect(projectIdMocks.getProjectIdForConnection.mock.calls[0][0]).toBe(creds.connectionId);
  });
});
