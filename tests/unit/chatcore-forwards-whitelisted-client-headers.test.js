// 0.5.165 — credentials.rawHeaders had three readers and no writer (upstream aba4c45d):
//   - OpenCode Go passes a caller's own x-opencode-session through (opencode-go.js);
//   - Cursor forces Agent mode for a Claude Code user-agent (cursor.js);
//   - Kiro honours `anthropic-beta: interleaved-thinking` as a thinking budget
//     (openai-to-kiro.js -> kiroConstants.js resolveKiroThinkingBudget).
// handleChatCore never assigned it, so all three were dead. Upstream mutates the
// shared credentials object with every client header; kRouter hands a whitelisted
// subset on a per-request copy, so the kRouter key, cookies and other clients'
// headers never reach an executor or another request.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

const dataDir = mkdtempSync(join(tmpdir(), "krouter-raw-headers-"));
let handleChatCore;
let pickForwardableClientHeaders;
let proxyAwareFetch;
let getExecutor;

const CHAT_SSE = [
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

const CLIENT_HEADERS = {
  authorization: "Bearer sk-krouter-secret",
  "x-api-key": "sk-krouter-secret",
  cookie: "session=dashboard-cookie",
  "user-agent": "claude-cli/2.1.280 (external, cli)",
  "anthropic-beta": "interleaved-thinking-2025-05-14",
  "x-opencode-session": "ses_client_owned_123",
  "x-opencode-project": "proj-1",
  "x-claude-code-session-id": "cc-session-9",
  "x-forwarded-for": "10.0.0.7",
  accept: "text/event-stream",
};

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  await import("../translator/registerAll.js");
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  ({ handleChatCore, pickForwardableClientHeaders } = await import("../../open-sse/handlers/chatCore.js"));
  ({ getExecutor } = await import("../../open-sse/executors/index.js"));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => {
  proxyAwareFetch.mockReset();
  proxyAwareFetch.mockImplementation(() => Promise.resolve(new Response(CHAT_SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } })));
});
afterEach(() => { vi.restoreAllMocks(); });

const chatBody = (model) => ({ model, stream: true, messages: [{ role: "user", content: "hello" }] });

describe("pickForwardableClientHeaders", () => {
  it("keeps only user-agent, anthropic-beta, x-opencode-* and x-claude-code-session-id", () => {
    expect(pickForwardableClientHeaders(CLIENT_HEADERS)).toEqual({
      "user-agent": "claude-cli/2.1.280 (external, cli)",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
      "x-opencode-session": "ses_client_owned_123",
      "x-opencode-project": "proj-1",
      "x-claude-code-session-id": "cc-session-9",
    });
  });

  it("never carries the kRouter key or cookies, whatever their case", () => {
    const out = pickForwardableClientHeaders({ Authorization: "Bearer k", "X-Api-Key": "k", Cookie: "c", "User-Agent": "ua" });
    expect(out).toEqual({ "user-agent": "ua" });
  });

  it("returns an empty object for missing or non-object headers", () => {
    expect(pickForwardableClientHeaders(undefined)).toEqual({});
    expect(pickForwardableClientHeaders(null)).toEqual({});
    expect(pickForwardableClientHeaders("x")).toEqual({});
  });
});

describe("handleChatCore hands executors the whitelisted client headers", () => {
  it("the executor sees rawHeaders without Authorization, x-api-key or cookie", async () => {
    const spy = vi.spyOn(getExecutor("openai"), "execute");
    await handleChatCore({
      body: chatBody("openai/gpt-4o"),
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "provider-key", connectionId: "conn-openai" },
      connectionId: "conn-openai",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: CLIENT_HEADERS },
    });
    const { credentials } = spy.mock.calls[0][0];
    expect(credentials.rawHeaders["user-agent"]).toBe("claude-cli/2.1.280 (external, cli)");
    expect(credentials.rawHeaders.authorization).toBeUndefined();
    expect(credentials.rawHeaders["x-api-key"]).toBeUndefined();
    expect(credentials.rawHeaders.cookie).toBeUndefined();
    expect(credentials.rawHeaders["x-forwarded-for"]).toBeUndefined();
    // The provider's own key is untouched.
    expect(credentials.apiKey).toBe("provider-key");
  });

  it("never mutates the caller's shared credentials object", async () => {
    const shared = { apiKey: "provider-key", connectionId: "conn-openai" };
    await handleChatCore({
      body: chatBody("openai/gpt-4o"),
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: shared,
      connectionId: "conn-openai",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: CLIENT_HEADERS },
    });
    expect(shared).toEqual({ apiKey: "provider-key", connectionId: "conn-openai" });
  });

  it("OpenCode Go keeps the caller's own x-opencode-session upstream", async () => {
    await handleChatCore({
      body: chatBody("ocg/kimi-k2.6"),
      modelInfo: { provider: "opencode-go", model: "kimi-k2.6" },
      credentials: { apiKey: "ocg-key", connectionId: "conn-ocg" },
      connectionId: "conn-ocg",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { "x-opencode-session": "ses_client_owned_123" } },
    });
    expect(proxyAwareFetch).toHaveBeenCalled();
    expect(proxyAwareFetch.mock.calls[0][1].headers["x-opencode-session"]).toBe("ses_client_owned_123");
  });

  it("Kiro reads the interleaved-thinking beta header as a thinking budget", async () => {
    const kiro = getExecutor("kiro");
    const spy = vi.spyOn(kiro, "execute").mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
      url: "https://kiro.test", headers: {}, transformedBody: null,
    });
    const send = (headers) => handleChatCore({
      body: chatBody("kr/claude-sonnet-4.5"),
      modelInfo: { provider: "kiro", model: "claude-sonnet-4.5" },
      credentials: { accessToken: "kiro-token", connectionId: "conn-kiro", providerSpecificData: {} },
      connectionId: "conn-kiro",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers },
    });

    await send({ "anthropic-beta": "interleaved-thinking-2025-05-14" });
    await send({});

    const withBeta = JSON.stringify(spy.mock.calls[0][0].body);
    const without = JSON.stringify(spy.mock.calls[1][0].body);
    expect(withBeta).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(without).not.toContain("<thinking_mode>enabled</thinking_mode>");
  });
});
