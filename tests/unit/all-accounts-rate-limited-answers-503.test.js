// 0.5.166 — when every account for a provider is cooling down, the chat,
// embeddings, web-fetch and web-search handlers answered with the LAST upstream
// status (or the stored lastErrorCode): a stale 401 or 400. Claude Code reads a
// 401 as "your key is bad" and stops, though the accounts are only parked. They
// now always answer 503 with Retry-After (upstream 15687d19; search.js has the
// same pattern and gets the same fix).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  handleChatCore: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
  handleFetchCore: vi.fn(),
  handleSearchCore: vi.fn(),
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
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (modelStr) => {
    const [provider, ...rest] = String(modelStr).split("/");
    return { provider, model: rest.join("/") };
  }),
  getComboModels: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(() => "masked"),
}));
vi.mock("@/shared/services/connectionHealth", () => ({ recordOutcome: vi.fn() }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn(async () => {}) }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.handleEmbeddingsCore }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.handleFetchCore }));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.handleSearchCore }));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
const { handleFetch } = await import("@/sse/handlers/fetch.js");
const { handleSearch } = await import("@/sse/handlers/search.js");

const parked = (lastErrorCode) => ({
  allRateLimited: true,
  lastError: "Unauthorized",
  lastErrorCode,
  retryAfter: new Date(Date.now() + 30_000).toISOString(),
  retryAfterHuman: "reset after 30s",
});
const account = { apiKey: "k", connectionId: "conn-1", connectionName: "Account 1" };
const post = (path, body) => new Request(`http://localhost${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const expect503 = async (response) => {
  expect(response.status).toBe(503);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  const json = await response.json();
  expect(json.error.message).toContain("reset after 30s");
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
});

describe("every account parked answers 503", () => {
  it("chat: a stored 401 lastErrorCode does not leak out as the status", async () => {
    mocks.getProviderCredentials.mockResolvedValue(parked(401));
    await expect503(await handleChat(post("/v1/chat/completions", { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] })));
  });

  it("chat: the last upstream status of this request is not reused either", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(account).mockResolvedValueOnce(parked(null));
    mocks.handleChatCore.mockResolvedValue({ success: false, status: 401, error: "token expired", response: new Response("{}", { status: 401 }) });
    await expect503(await handleChat(post("/v1/chat/completions", { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] })));
  });

  it("embeddings", async () => {
    mocks.getProviderCredentials.mockResolvedValue(parked(400));
    await expect503(await handleEmbeddings(post("/v1/embeddings", { model: "openai/text-embedding-3-small", input: "hi" })));
  });

  it("web fetch", async () => {
    mocks.getProviderCredentials.mockResolvedValue(parked(401));
    await expect503(await handleFetch(post("/v1/web/fetch", { provider: "tavily", url: "https://example.com/a" })));
  });

  it("web search", async () => {
    mocks.getProviderCredentials.mockResolvedValue(parked(401));
    await expect503(await handleSearch(post("/v1/search", { provider: "tavily", query: "kRouter" })));
  });
});
