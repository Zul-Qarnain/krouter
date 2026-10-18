// 0.5.165 — the image endpoint never wrote a usage row, so every /v1/images
// request was free as far as the dashboard was concerned (upstream e10da160).
// Codex now reports exact token counts on response.completed; the handler has to
// turn that into a saveRequestUsage row attributed to the connection, the API key
// and the endpoint that served it — the same row shape the embeddings handler
// already writes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  handleImageGenerationCore: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => "sk-test-key"),
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
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: mocks.handleImageGenerationCore,
}));

const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");

const USAGE = { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540, cached_tokens: 1024 };

const post = (body) => new Request("http://localhost/v1/images/generations", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

// Report `usage` through the core's onUsage hook, then succeed.
const coreReporting = (usage) => async ({ onUsage }) => {
  if (usage !== undefined) await onUsage?.(usage);
  return { success: true, response: new Response("{}", { status: 200 }) };
};

describe("image generation usage reaches the usage table", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderCredentials.mockResolvedValue({ accessToken: "t", connectionId: "conn-1" });
    mocks.saveRequestUsage.mockResolvedValue(undefined);
  });

  it("writes a usage row attributed to the connection, key and endpoint", async () => {
    mocks.handleImageGenerationCore.mockImplementation(coreReporting(USAGE));

    const response = await handleImageGeneration(post({ model: "codex/gpt-image-2.5", prompt: "a cat" }));

    expect(response.status).toBe(200);
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      model: "gpt-image-2.5",
      connectionId: "conn-1",
      apiKey: "sk-test-key",
      endpoint: "/v1/images/generations",
      tokens: USAGE,
      status: "success",
    }));
  });

  it("writes nothing when the provider reported no usage", async () => {
    mocks.handleImageGenerationCore.mockImplementation(coreReporting(undefined));
    await handleImageGeneration(post({ model: "codex/gpt-image-2.5", prompt: "a cat" }));
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("writes nothing for a usage frame with unusable token counts", async () => {
    mocks.handleImageGenerationCore.mockImplementation(coreReporting({ prompt_tokens: -5, completion_tokens: 1 }));
    await handleImageGeneration(post({ model: "codex/gpt-image-2.5", prompt: "a cat" }));
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("never fails the image response when the usage write rejects", async () => {
    mocks.handleImageGenerationCore.mockImplementation(coreReporting(USAGE));
    mocks.saveRequestUsage.mockRejectedValue(new Error("db locked"));

    const response = await handleImageGeneration(post({ model: "codex/gpt-image-2.5", prompt: "a cat" }));
    expect(response.status).toBe(200);
  });
});
