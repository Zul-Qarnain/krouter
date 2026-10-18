// 0.5.166 — RTK compresses tool results on the translated body. openai-to-cursor
// rewrites role:"tool" messages into user text (<tool_result> XML), so for Cursor
// the post-translate pass found nothing to compress and every tool output went
// out in full. Cursor now runs RTK on a copy of the source body before
// translation and skips the post-translate pass; every other provider is
// unchanged (upstream c933eefc, RTK half). Unlike upstream, the client's body is
// never compressed in place: a combo retry or the response cache would otherwise
// see the compressed copy.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

await import("../translator/registerAll.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function makeLongDiff() {
  const lines = ["diff --git a/foo.js b/foo.js", "index abc..def 100644", "--- a/foo.js", "+++ b/foo.js", "@@ -1,3 +1,200 @@"];
  for (let i = 0; i < 200; i++) lines.push(`+added line ${i} UNIQUE_PADDING_${i} ${"x".repeat(20)}`);
  return lines.join("\n");
}

const conversation = (diff) => ([
  { role: "user", content: "run git diff" },
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "git diff" }) } }] },
  { role: "tool", tool_call_id: "call_1", content: diff },
  { role: "user", content: "summarize" },
]);

const run = ({ provider, model, body, rtkEnabled = true, headers = { accept: "application/json" } }) => handleChatCore({
  body,
  modelInfo: { provider, model },
  credentials: { apiKey: "test-key", providerSpecificData: {} },
  connectionId: "test-conn",
  rtkEnabled,
  clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers },
});

describe("RTK on Cursor runs before the openai-to-cursor rewrite", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ id: "c1", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api2.cursor.sh/agent", headers: {}, transformedBody: null,
    });
  });

  it("compresses a role:tool git diff that Cursor's translator turns into user XML", async () => {
    await run({ provider: "cursor", model: "default", body: { model: "cu/default", stream: false, messages: conversation(makeLongDiff()) } });
    const dispatched = executeMock.mock.calls[0][0].body;
    const blob = JSON.stringify(dispatched.messages);
    expect(dispatched.messages.some((m) => m.role === "tool")).toBe(false);
    expect(blob).toContain("<tool_result>");
    expect(blob).toContain("lines truncated");
    expect(blob).not.toContain("UNIQUE_PADDING_150");
  });

  it("never compresses the client's own body in place", async () => {
    const diff = makeLongDiff();
    const body = { model: "cu/default", stream: false, messages: conversation(diff) };
    await run({ provider: "cursor", model: "default", body });
    expect(body.messages[2].content).toBe(diff);
  });

  it("the X-9Router-Token-Saver: off bypass still holds on Cursor", async () => {
    await run({
      provider: "cursor", model: "default",
      body: { model: "cu/default", stream: false, messages: conversation(makeLongDiff()) },
      headers: { accept: "application/json", "x-9router-token-saver": "off" },
    });
    expect(JSON.stringify(executeMock.mock.calls[0][0].body.messages)).toContain("UNIQUE_PADDING_150");
  });

  it("RTK disabled leaves Cursor's tool output whole", async () => {
    await run({ provider: "cursor", model: "default", rtkEnabled: false, body: { model: "cu/default", stream: false, messages: conversation(makeLongDiff()) } });
    expect(JSON.stringify(executeMock.mock.calls[0][0].body.messages)).toContain("UNIQUE_PADDING_150");
  });

  it("other providers keep the post-translate pass", async () => {
    await run({ provider: "openai", model: "gpt-4o", body: { model: "openai/gpt-4o", stream: false, messages: conversation(makeLongDiff()) } });
    const toolMsg = executeMock.mock.calls[0][0].body.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toContain("lines truncated");
    expect(toolMsg.content).not.toContain("UNIQUE_PADDING_150");
  });
});
