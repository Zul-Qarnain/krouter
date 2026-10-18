// 0.5.165 (upstream ab044e6d, translator half) — the Responses API takes the
// output cap as `max_output_tokens` and reasoning as `reasoning: {effort, summary}`.
// The Chat -> Responses translator copied `max_tokens` verbatim (real OpenAI
// /v1/responses answers 400 "Unsupported parameter: 'max_tokens'"), dropped
// `max_completion_tokens`, and dropped `reasoning_effort` entirely, so a chat
// client's effort never reached Codex / Grok CLI / Copilot /responses.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";

const chat = (extra = {}) => ({
  model: "gpt-x",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("Chat -> Responses output cap", () => {
  it("sends max_tokens as max_output_tokens", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", chat({ max_tokens: 1024 }), true);
    expect(out.max_output_tokens).toBe(1024);
    expect(out).not.toHaveProperty("max_tokens");
  });

  it("sends max_completion_tokens as max_output_tokens", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", chat({ max_completion_tokens: 2048 }), true);
    expect(out.max_output_tokens).toBe(2048);
    expect(out).not.toHaveProperty("max_completion_tokens");
  });

  it("prefers max_output_tokens > max_completion_tokens > max_tokens", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", chat({ max_output_tokens: 10, max_completion_tokens: 20, max_tokens: 30 }), true);
    expect(out.max_output_tokens).toBe(10);
    const out2 = openaiToOpenAIResponsesRequest("gpt-x", chat({ max_completion_tokens: 20, max_tokens: 30 }), true);
    expect(out2.max_output_tokens).toBe(20);
  });

  it("treats 0 or a negative cap as unset", () => {
    expect(openaiToOpenAIResponsesRequest("gpt-x", chat({ max_tokens: 0 }), true)).not.toHaveProperty("max_output_tokens");
    expect(openaiToOpenAIResponsesRequest("gpt-x", chat({ max_tokens: -1, max_completion_tokens: 300 }), true).max_output_tokens).toBe(300);
  });

  it("maps the cap on the input[] pass-through path too", () => {
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], max_tokens: 512, max_completion_tokens: 256 };
    const out = openaiToOpenAIResponsesRequest("gpt-x", body, true);
    expect(out.max_output_tokens).toBe(256);
    expect(out).not.toHaveProperty("max_tokens");
    expect(out).not.toHaveProperty("max_completion_tokens");
    // copy-on-write: the client body keeps its own fields
    expect(body.max_tokens).toBe(512);
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("keeps an explicit max_output_tokens on the input[] path", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", { input: [], max_output_tokens: 64, max_tokens: 999 }, true);
    expect(out.max_output_tokens).toBe(64);
    expect(out).not.toHaveProperty("max_tokens");
  });
});

describe("Chat -> Responses reasoning", () => {
  it("maps reasoning_effort to reasoning {effort, summary}", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", chat({ reasoning_effort: "high" }), true);
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("keeps a Responses-shape reasoning object's effort and summary", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", chat({ reasoning: { effort: "low", summary: "detailed" } }), true);
    expect(out.reasoning).toEqual({ effort: "low", summary: "detailed" });
  });

  it("reasoning_effort wins over reasoning.effort", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", chat({ reasoning_effort: "medium", reasoning: { effort: "low" } }), true);
    expect(out.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it("never forwards foreign reasoning shapes a strict upstream would reject", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-x", chat({ reasoning: { enabled: true, max_tokens: 2000 } }), true);
    expect(out).not.toHaveProperty("reasoning");
  });

  it("sends no reasoning when the client asked for none", () => {
    expect(openaiToOpenAIResponsesRequest("gpt-x", chat(), true)).not.toHaveProperty("reasoning");
  });

  it("reaches the Responses body through translateRequest", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-x", chat({ reasoning_effort: "high", max_tokens: 4096 }), true, {}, "openai-compatible-responses-test");
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.max_output_tokens).toBe(4096);
    expect(out).not.toHaveProperty("max_tokens");
  });
});

describe("Grok CLI keeps the output cap", () => {
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

  it("maps max_tokens / max_completion_tokens to max_output_tokens instead of deleting it", () => {
    const executor = new GrokCliExecutor();
    const out = executor.transformRequest("grok-build", { model: "grok-build", input, max_tokens: 777 }, true, { connectionId: "gcli-cap-test" });
    expect(out.max_output_tokens).toBe(777);
    expect(out).not.toHaveProperty("max_tokens");

    const out2 = new GrokCliExecutor().transformRequest("grok-build", { model: "grok-build", input, max_completion_tokens: 555 }, true, { connectionId: "gcli-cap-test-2" });
    expect(out2.max_output_tokens).toBe(555);
    expect(out2).not.toHaveProperty("max_completion_tokens");
  });

  it("keeps an explicit max_output_tokens", () => {
    const out = new GrokCliExecutor().transformRequest("grok-build", { model: "grok-build", input, max_output_tokens: 99, max_tokens: 777 }, true, { connectionId: "gcli-cap-test-3" });
    expect(out.max_output_tokens).toBe(99);
  });
});
