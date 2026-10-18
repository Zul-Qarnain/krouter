// 0.5.165 (upstream 6aea3875, plus the base.js half of f4f06f29) — real Claude Code
// sends x-claude-code-session-id equal to metadata.user_id.session_id. kRouter sent
// the user_id (cloaking writes one for OAuth) without the header, a fingerprint
// mismatch. The header is derived PER REQUEST from the body the executor is about
// to send, so nothing is cached between callers (the v0.5.123 leak stays fixed).
// buildHeaders needs that body, so BaseExecutor.execute now passes it in.
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { extractClaudeSessionIdFromUserId, applyCloaking } = await import("../../open-sse/utils/claudeCloaking.js");

const jsonUserId = (sid) => JSON.stringify({ device_id: "d", account_uuid: "a", session_id: sid });

describe("extractClaudeSessionIdFromUserId", () => {
  it("reads session_id from the JSON user_id", () => {
    expect(extractClaudeSessionIdFromUserId(jsonUserId("sess-abc"))).toBe("sess-abc");
  });

  it("strips a claude: prefix", () => {
    expect(extractClaudeSessionIdFromUserId(jsonUserId("claude:sess-abc"))).toBe("sess-abc");
    expect(extractClaudeSessionIdFromUserId("claude:legacy-id")).toBe("legacy-id");
  });

  it("accepts the legacy plain-string user_id", () => {
    expect(extractClaudeSessionIdFromUserId("user_123_session_x")).toBe("user_123_session_x");
  });

  it("returns null for junk", () => {
    for (const v of [undefined, null, "", 42, "{not json", JSON.stringify({ device_id: "d" })]) {
      expect(extractClaudeSessionIdFromUserId(v)).toBeNull();
    }
  });

  it("applyCloaking strips a claude: prefix from the session it writes", () => {
    const body = applyCloaking({ messages: [] }, "sk-ant-oat-x", "claude:abc-123");
    expect(JSON.parse(body.metadata.user_id).session_id).toBe("abc-123");
  });
});

describe("DefaultExecutor.buildHeaders x-claude-code-session-id", () => {
  const body = { metadata: { user_id: jsonUserId("sess-abc") } };

  it("is set from metadata.user_id on a Claude OAuth request", () => {
    const headers = new DefaultExecutor("claude").buildHeaders({ accessToken: "sk-ant-oat01-token" }, true, null, "claude-opus-5-5", body);
    expect(headers["x-claude-code-session-id"]).toBe("sess-abc");
  });

  it("is not set for an API key", () => {
    const headers = new DefaultExecutor("claude").buildHeaders({ apiKey: "sk-ant-api03-xxx" }, true, null, "claude-opus-5-5", body);
    expect(headers["x-claude-code-session-id"]).toBeUndefined();
  });

  it("is not set for other providers", () => {
    const headers = new DefaultExecutor("anthropic-compatible-x").buildHeaders(
      { accessToken: "sk-ant-oat01-token", providerSpecificData: {} }, true, null, "claude-opus-5-5", body);
    expect(headers["x-claude-code-session-id"]).toBeUndefined();
  });

  it("is derived per request (two bodies, two ids, no shared state)", () => {
    const executor = new DefaultExecutor("claude");
    const a = executor.buildHeaders({ accessToken: "sk-ant-oat01-a" }, true, null, "claude-opus-5-5", { metadata: { user_id: jsonUserId("A") } });
    const b = executor.buildHeaders({ accessToken: "sk-ant-oat01-b" }, true, null, "claude-opus-5-5", { metadata: { user_id: jsonUserId("B") } });
    const c = executor.buildHeaders({ accessToken: "sk-ant-oat01-c" }, true, null, "claude-opus-5-5");
    expect(a["x-claude-code-session-id"]).toBe("A");
    expect(b["x-claude-code-session-id"]).toBe("B");
    expect(c["x-claude-code-session-id"]).toBeUndefined();
  });
});

describe("BaseExecutor.execute hands the outgoing body to buildHeaders", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
    proxyFetchMock.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  });

  it("the sent header matches the sent body's session_id", async () => {
    const executor = new DefaultExecutor("claude");
    const { headers, transformedBody } = await executor.execute({
      model: "claude-opus-5-5",
      body: { model: "claude-opus-5-5", metadata: { user_id: jsonUserId("sess-live") }, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { accessToken: "sk-ant-oat01-token" },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    expect(headers["x-claude-code-session-id"]).toBe("sess-live");
    expect(JSON.parse(transformedBody.metadata.user_id).session_id).toBe("sess-live");
  });
});
