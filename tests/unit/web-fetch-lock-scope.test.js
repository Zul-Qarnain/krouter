// 0.5.165 — a failed web fetch locked the whole account. Tavily and Exa serve
// search and fetch from one connection, so one failed /v1/web/fetch took that
// connection out of /v1/search (and any provider that also serves chat out of
// chat). Fetch now locks, reads and clears under `webfetch:<provider>`, the same
// way v0.5.153 scoped search to `websearch:<provider>` (upstream e0ffc7e2, lock
// half; its tests/unit/fetch-success-clears-account.test.js ported here).
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildModelLockUpdate, isModelLockActive } from "../../open-sse/services/accountFallback.js";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  handleFetchCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getCombos: vi.fn(async () => []),
}));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.handleFetchCore }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(() => "masked"),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn(async () => {}) }));

const { handleFetch } = await import("@/sse/handlers/fetch.js");

const fetchRequest = (provider) => new Request("http://localhost/v1/web/fetch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider, url: "https://example.com/article" }),
});

describe("web fetch locks are scoped to web fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "tavily-key",
      connectionId: "tavily-connection",
      connectionName: "Tavily",
      _connection: { testStatus: "unavailable", lastError: "old error", modelLock___all: "2026-01-01T00:00:00.000Z" },
    });
    mocks.handleFetchCore.mockImplementation(async ({ onRequestSuccess }) => {
      await onRequestSuccess?.();
      return { success: true, data: { provider: "tavily", content: { text: "ok" } } };
    });
  });

  it("reads credentials and clears the lock under webfetch:<provider> on success", async () => {
    const response = await handleFetch(fetchRequest("tavily"));
    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("tavily", expect.any(Set), "webfetch:tavily");
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "tavily-connection", expect.objectContaining({ connectionName: "Tavily" }), "webfetch:tavily",
    );
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("marks a failure under webfetch:<provider>, not account-wide", async () => {
    mocks.handleFetchCore.mockResolvedValue({ success: false, status: 429, error: "quota exceeded" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    const response = await handleFetch(fetchRequest("tavily"));
    expect(response.status).toBe(429);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("tavily-connection", 429, "quota exceeded", "tavily", "webfetch:tavily");
  });

  it("a fetch lock leaves the same connection usable for search and chat", () => {
    const conn = buildModelLockUpdate("webfetch:tavily", 60_000);
    expect(isModelLockActive(conn, "webfetch:tavily")).toBe(true);
    expect(isModelLockActive(conn, "websearch:tavily")).toBe(false);
    expect(isModelLockActive(conn, "gpt-4o")).toBe(false);
  });
});
