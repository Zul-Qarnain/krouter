// 0.5.165 (upstream 122f23ee, envelope half) — Cline (api.cline.bot) wraps a
// non-streaming chat completion in {"success":true,"data":{...choices...}}. kRouter
// handed that envelope straight back, so clients found no top-level `choices` and the
// dashboard model test said "Provider returned no completion choices for this model".
// Only cline / clinepass are unwrapped; no other provider's body is ever rewritten,
// and the error envelope ({"success":false,...}) passes through untouched.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

const COMPLETION = {
  id: "chatcmpl-cline1",
  object: "chat.completion",
  created: 1700000000,
  model: "z-ai/glm-5.3-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
};

async function run(provider, body, { sourceFormat = FORMATS.OPENAI, contentType = "application/json" } = {}) {
  const appendLog = vi.fn();
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const result = await handleNonStreamingResponse({
    providerResponse: new Response(raw, { status: 200, headers: { "content-type": contentType } }),
    provider,
    model: "z-ai/glm-5.3-flash",
    sourceFormat,
    targetFormat: FORMATS.OPENAI,
    body: { model: "z-ai/glm-5.3-flash", stream: false, messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "conn-cline",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    trackDone: vi.fn(),
    appendLog
  });
  return { result, appendLog };
}

describe("Cline non-streaming envelope", () => {
  it.each(["cline", "clinepass"])("%s: the client gets the bare completion", async (provider) => {
    const { result, appendLog } = await run(provider, { success: true, data: COMPLETION });
    const json = await result.response.json();
    expect(json).not.toHaveProperty("success");
    expect(json).not.toHaveProperty("data");
    expect(json.choices[0].message.content).toBe("hello");
    // Usage is read from the inner body, so the request is billed.
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ status: "200 OK", tokens: expect.objectContaining({ prompt_tokens: 9 }) }));
  });

  it("a Claude client still gets a Claude message from the unwrapped body", async () => {
    const { result } = await run("cline", { success: true, data: COMPLETION }, { sourceFormat: FORMATS.CLAUDE });
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("the error envelope passes through untouched", async () => {
    const errorEnvelope = { success: false, error: { message: "insufficient credits" } };
    const { result } = await run("cline", errorEnvelope);
    const json = await result.response.json();
    expect(json.success).toBe(false);
    expect(json.error).toEqual({ message: "insufficient credits" });
  });

  it("other providers' bodies are never unwrapped", async () => {
    const { result } = await run("openrouter", { success: true, data: COMPLETION });
    const json = await result.response.json();
    expect(json.success).toBe(true);
    expect(json.data.choices[0].message.content).toBe("hello");
  });
});

describe("non-streaming SSE error chunk status", () => {
  const sse = (error) => `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\ndata: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`;

  it("keeps an explicit upstream status", async () => {
    const { result } = await run("qoder", sse({ message: "billing", status: 403 }), { contentType: "text/event-stream" });
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
  });

  it("still maps a rate-limit code with no status to 429", async () => {
    const { result } = await run("qoder", sse({ message: "slow down", code: "rate_limit_exceeded" }), { contentType: "text/event-stream" });
    expect(result.status).toBe(429);
  });
});
