// The strict-proxy guard in proxyAwareFetch and the Cursor executor reads
// proxyOptions.strictProxy and proxyOptions.proxyPoolId. handleChatCore built
// proxyOptions from four fields only, so neither reached an executor and strict
// mode never held on a chat request (upstream cfd8c618 chatCore hunk).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

const dataDir = mkdtempSync(join(tmpdir(), "krouter-strict-proxy-"));
let handleChatCore;
let proxyAwareFetch;
const CHAT_SSE = [
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  await import("../translator/registerAll.js");
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => {
  proxyAwareFetch.mockReset();
  proxyAwareFetch.mockImplementation(() => Promise.resolve(new Response(CHAT_SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } })));
});

const run = (providerSpecificData) => handleChatCore({
  body: { model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "hello" }] },
  modelInfo: { provider: "openai", model: "gpt-4o" },
  credentials: { apiKey: "test-key", connectionId: "conn-openai", providerSpecificData },
  connectionId: "conn-openai",
});

describe("handleChatCore hands the strict-proxy fields to the executor", () => {
  it("forwards strictProxy and the pool id of a strict pool", async () => {
    await run({ connectionProxyPoolId: "pool-strict", strictProxy: true, connectionProxyEnabled: false, connectionProxyUrl: "" });
    expect(proxyAwareFetch).toHaveBeenCalled();
    expect(proxyAwareFetch.mock.calls[0][2]).toMatchObject({ proxyPoolId: "pool-strict", strictProxy: true });
  });

  it("reports no pool and not strict for a connection without a pool", async () => {
    await run({});
    expect(proxyAwareFetch.mock.calls[0][2]).toMatchObject({ proxyPoolId: null, strictProxy: false });
  });
});

// A 401/403 refreshed the token with no proxyOptions, so the request that
// carries the refresh token to the provider's OAuth host left over the direct
// IP, pooled or strict.
describe("handleChatCore refreshes a 401 through the request's proxy", () => {
  it("passes the request's proxyOptions to refreshCredentials", async () => {
    const { getExecutor } = await import("../../open-sse/executors/index.js");
    const refresh = vi.spyOn(getExecutor("openai"), "refreshCredentials").mockResolvedValue({ accessToken: "fresh-token" });
    proxyAwareFetch.mockImplementationOnce(() => Promise.resolve(new Response(
      JSON.stringify({ error: { message: "token expired" } }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));
    try {
      await run({
        connectionProxyPoolId: "pool-1", strictProxy: true,
        connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890",
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0][2]).toMatchObject({
        proxyPoolId: "pool-1", strictProxy: true,
        connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890",
      });
      expect(refresh.mock.calls[0][2]).toEqual(proxyAwareFetch.mock.calls[0][2]);
    } finally {
      refresh.mockRestore();
    }
  });
});
