/**
 * GitHub embeddings go to api.githubcopilot.com, not the retired GitHub Models host.
 *
 * `models.github.ai/inference/embeddings` was retired on 2026-07-30. It still
 * resolves, which is what makes the old config so quietly broken: every POST
 * answers `200 text/plain "OK"` (verified 2026-10-18), so kRouter's embeddings
 * core turns a working connection into `Invalid JSON response from github`
 * instead of an embedding. The live route is `api.githubcopilot.com/embeddings`,
 * which needs the short-lived Copilot token and the editor headers the chat
 * executor already sends.
 *
 * Ports upstream 51a1827e, adapted: kRouter has no
 * `open-sse/providers/registry/`, so the endpoint lives in the adapter's
 * ENDPOINTS map rather than in a registry `embeddingConfig`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// executors/index.js pulls in kiro.js -> 'uuid', which is not installed in the
// test environment; the executor layer is irrelevant to URL/header building.
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ refreshCredentials: vi.fn().mockResolvedValue(null) })),
  hasSpecializedExecutor: vi.fn(() => false),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn() }));

import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { getEmbeddingAdapter } from "../../open-sse/handlers/embeddingProviders/index.js";
import { GITHUB_COPILOT } from "../../open-sse/config/appConstants.js";

const RETIRED_HOST = "models.github.ai";

const EMBEDDING_RESPONSE = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 3, total_tokens: 3 },
};

const originalFetch = global.fetch;

async function embed(credentials) {
  return handleEmbeddingsCore({
    body: { input: "Hello world" },
    modelInfo: { provider: "github", model: "text-embedding-3-small" },
    credentials,
    log: null,
  });
}

describe("GitHub embeddings adapter", () => {
  const adapter = getEmbeddingAdapter("github");

  it("is registered for the github provider", () => {
    expect(adapter).toBeTruthy();
  });

  it("does not point at the retired GitHub Models host", () => {
    expect(adapter.buildUrl("text-embedding-3-small", {})).not.toContain(RETIRED_HOST);
  });

  it("posts to the Copilot embeddings endpoint", () => {
    expect(adapter.buildUrl("text-embedding-3-small", {})).toBe("https://api.githubcopilot.com/embeddings");
  });

  it("prefers the short-lived Copilot token over the GitHub OAuth token", () => {
    const headers = adapter.buildHeaders({ accessToken: "gho-oauth", copilotToken: "tid=copilot" });

    expect(headers.Authorization).toBe("Bearer tid=copilot");
  });

  it("reads the Copilot token from providerSpecificData when that is where it lives", () => {
    const headers = adapter.buildHeaders({
      accessToken: "gho-oauth",
      providerSpecificData: { copilotToken: "tid=nested" },
    });

    expect(headers.Authorization).toBe("Bearer tid=nested");
  });

  it("falls back to the OAuth access token when no Copilot token is stored yet", () => {
    const headers = adapter.buildHeaders({ accessToken: "gho-oauth" });

    expect(headers.Authorization).toBe("Bearer gho-oauth");
  });

  it("sends the editor headers api.githubcopilot.com requires", () => {
    const headers = adapter.buildHeaders({ copilotToken: "tid=copilot" });

    expect(headers["copilot-integration-id"]).toBe("vscode-chat");
    expect(headers["editor-version"]).toBe(`vscode/${GITHUB_COPILOT.VSCODE_VERSION}`);
    expect(headers["editor-plugin-version"]).toBe(`copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`);
    expect(headers["user-agent"]).toBe(GITHUB_COPILOT.USER_AGENT);
    expect(headers["x-github-api-version"]).toBe(GITHUB_COPILOT.API_VERSION);
  });

  it("keeps the OpenAI-compatible request body", () => {
    expect(adapter.buildBody("text-embedding-3-small", { input: "hi", encoding_format: "float" })).toEqual({
      model: "text-embedding-3-small",
      input: "hi",
      encoding_format: "float",
    });
  });
});

describe("GitHub embeddings — end to end", () => {
  beforeEach(() => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(EMBEDDING_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("calls the Copilot endpoint with the Copilot token and IDE headers", async () => {
    const result = await embed({ accessToken: "gho-oauth", copilotToken: "tid=copilot" });

    expect(result.success).toBe(true);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/embeddings");
    expect(init.headers.Authorization).toBe("Bearer tid=copilot");
    expect(init.headers["copilot-integration-id"]).toBe("vscode-chat");
    expect(init.headers["editor-version"]).toMatch(/^vscode\//);
  });

  it("never calls the retired GitHub Models host", async () => {
    await embed({ copilotToken: "tid=copilot" });

    expect(global.fetch.mock.calls[0][0]).not.toContain(RETIRED_HOST);
  });

  it("returns the embedding to the client", async () => {
    const result = await embed({ copilotToken: "tid=copilot" });

    const payload = await result.response.json();
    expect(payload.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("other OpenAI-compatible embedding providers are untouched", () => {
  it("openai still posts to api.openai.com", () => {
    expect(getEmbeddingAdapter("openai").buildUrl("text-embedding-3-small", {})).toBe(
      "https://api.openai.com/v1/embeddings"
    );
  });

  it("openai sends a plain bearer header with no editor headers", () => {
    const headers = getEmbeddingAdapter("openai").buildHeaders({ apiKey: "sk-test" });

    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["copilot-integration-id"]).toBeUndefined();
  });
});
