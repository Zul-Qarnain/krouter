// 0.5.165 (upstream 0f488c70) — a refusal from the Anthropic API (stop_reason
// "refusal", zero output tokens, no content blocks) must reach an OpenAI-format
// client as finish_reason "content_filter" carrying Anthropic's explanation, not as
// a clean, empty "stop". Streaming and non-streaming must agree, and the reverse
// direction (OpenAI content_filter -> Claude client) must say "refusal".
import { describe, it, expect } from "vitest";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";
import { openaiToClaudeResponse, convertFinishReason } from "../../open-sse/translator/response/openai-to-claude.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const EXPLANATION =
  "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";

function runStream(events) {
  const state = { toolCalls: new Map() };
  const out = [];
  for (const ev of events) {
    const r = claudeToOpenAIResponse(ev, state);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  }
  return { state, out };
}

const REFUSAL_USAGE = { input_tokens: 637, cache_creation_input_tokens: 206779, cache_read_input_tokens: 0, output_tokens: 0 };
const STOP_DETAILS = { type: "refusal", category: "reasoning_extraction", explanation: EXPLANATION };

const refusalStream = [
  { type: "message_start", message: { id: "msg_refusal", model: "claude-opus-5", role: "assistant", content: [], usage: REFUSAL_USAGE } },
  { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: STOP_DETAILS }, usage: REFUSAL_USAGE },
  { type: "message_stop" }
];

describe("claude-to-openai: refusal stop_reason (streaming)", () => {
  it("finishes with content_filter, not stop", () => {
    const { out } = runStream(refusalStream);
    const finishes = out.map(c => c.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishes).toEqual(["content_filter"]);
  });

  it("surfaces Anthropic's explanation as message content", () => {
    const { out } = runStream(refusalStream);
    const text = out.map(c => c.choices?.[0]?.delta?.content || "").join("");
    expect(text).toBe(EXPLANATION);
  });

  it("keeps usage on the final chunk (prompt tokens were billed)", () => {
    const { out } = runStream(refusalStream);
    const final = out.find(c => c.choices?.[0]?.finish_reason === "content_filter");
    expect(final.usage.prompt_tokens).toBe(637 + 206779);
    expect(final.usage.completion_tokens).toBe(0);
  });

  it("leaves a normal end_turn untouched", () => {
    const { out } = runStream([
      { type: "message_start", message: { id: "m", model: "claude-opus-5", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    ]);
    const finishes = out.map(c => c.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishes).toEqual(["stop"]);
    expect(out.map(c => c.choices?.[0]?.delta?.content || "").join("")).toBe("ok");
  });
});

describe("Claude upstream, OpenAI client, non-streaming: same mapping as streaming", () => {
  const claudeMessage = (stop_reason, extra = {}) => ({
    id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5",
    content: [], stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 }, ...extra
  });

  it("refusal becomes content_filter with the explanation as content", () => {
    const json = translateNonStreamingResponse(
      claudeMessage("refusal", { stop_details: STOP_DETAILS }), FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(json.choices[0].finish_reason).toBe("content_filter");
    expect(json.choices[0].message.content).toBe(EXPLANATION);
  });

  it("max_tokens becomes length", () => {
    const json = translateNonStreamingResponse(
      claudeMessage("max_tokens", { content: [{ type: "text", text: "partial" }] }), FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(json.choices[0].finish_reason).toBe("length");
    expect(json.choices[0].message.content).toBe("partial");
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["tool_use", "tool_calls"],
    ["pause_turn", "stop"],
  ])("%s becomes %s, never a raw Claude value", (stopReason, expected) => {
    const json = translateNonStreamingResponse(
      claudeMessage(stopReason, { content: [{ type: "text", text: "x" }] }), FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(json.choices[0].finish_reason).toBe(expected);
  });
});

describe("OpenAI upstream, Claude client: content_filter becomes refusal", () => {
  it("maps the finish reason both ways", () => {
    expect(convertFinishReason("content_filter")).toBe("refusal");
    expect(convertFinishReason("stop")).toBe("end_turn");
    expect(convertFinishReason("length")).toBe("max_tokens");
  });

  it("the streaming message_delta says refusal", () => {
    const state = { toolCalls: new Map() };
    openaiToClaudeResponse({ id: "chatcmpl-abcdefgh", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] }, state);
    const out = openaiToClaudeResponse({ id: "chatcmpl-abcdefgh", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }, state);
    const delta = out.find((e) => e.type === "message_delta");
    expect(delta.delta.stop_reason).toBe("refusal");
  });

  it("the non-streaming Claude message says refusal", () => {
    const json = translateNonStreamingResponse({
      id: "chatcmpl-1", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
      usage: { prompt_tokens: 3, completion_tokens: 0 }
    }, FORMATS.OPENAI, FORMATS.CLAUDE);
    expect(json.stop_reason).toBe("refusal");
  });
});
