import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../../open-sse/utils/proxyFetch.js", async (io) => {
  const actual = await io();
  return { ...actual, proxyAwareFetch: vi.fn() };
});
const dataDir = mkdtempSync(join(tmpdir(), "krouter-dbg-"));
let handleChatCore, proxyAwareFetch, translatorIndex;
beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  await import("../translator/registerAll.js");
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  translatorIndex = await import("../../open-sse/translator/index.js");
});
describe("dbg", () => {
  it("prints state", async () => {
    const sse = `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", model: "mimo-v2.6-flash-free", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_client", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    proxyAwareFetch.mockResolvedValue(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const spy = vi.spyOn(translatorIndex, "translateResponse");
    const result = await handleChatCore({
      body: { model: "oc/mimo-v2.6-flash-free", stream: true, tools: [{ type: "function", function: { name: "read", description: "caller", parameters: { type: "object", properties: {} } } }], messages: [{ role: "user", content: "x" }] },
      modelInfo: { provider: "opencode", model: "mimo-v2.6-flash-free" },
      credentials: {},
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    });
    const text = await result.response.text();
    const lines=[];lines.push("TEXT: "+text.slice(0,400));
    lines.push("calls: "+spy.mock.calls.length);
    for (const c of spy.mock.calls) lines.push("map: "+JSON.stringify([...(c[3]?.toolNameMap||[])]));
    writeFileSync("/private/tmp/claude-501/-Users-shofiqulislam-9router-master/25cdc9f0-be3f-4a94-8a15-272bea01e267/scratchpad/dbgout.txt", lines.join("\n"));
    expect(1).toBe(1);
  });
});
