// 0.5.166 (upstream 7c2b1fe3) — clients driving reasoning models (Hermes Agent and
// anything following the DeepSeek/Kimi convention) echo the previous turn's
// reasoning_content / reasoning / reasoning_details on every assistant message.
// Groq answers 400, Mistral 422 ("extra_forbidden") and Cerebras 400, so from the
// second turn on these providers fail and a combo silently skips them.
import { describe, expect, it } from "vitest";
import { stripUnsupportedParams, __test__ } from "../../open-sse/translator/helpers/paramSupport.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const toolCalls = [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }];

const makeBody = () => ({
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "hello",
      reasoning_content: "thinking...",
      reasoning: "thinking...",
      reasoning_details: [{ text: "thinking..." }],
      tool_calls: toolCalls,
    },
    { role: "user", content: "again", reasoning_content: "user-side field stays" },
  ],
});

describe("dropMessageFields rule", () => {
  it.each([
    ["groq", "openai/gpt-oss-120b"],
    ["mistral", "codestral-latest"],
    ["cerebras", "gpt-oss-120b"],
  ])("strips replayed reasoning from assistant turns for %s", (provider, model) => {
    const body = makeBody();
    stripUnsupportedParams(provider, model, body);
    expect(body.messages[1]).toEqual({ role: "assistant", content: "hello", tool_calls: toolCalls });
    // only assistant turns are touched
    expect(body.messages[2].reasoning_content).toBe("user-side field stays");
  });

  it("builds new message objects instead of deleting from the caller's", () => {
    const body = makeBody();
    const original = body.messages[1];
    const untouched = body.messages[0];
    stripUnsupportedParams("groq", "llama-3.3-70b-versatile", body);
    expect(original.reasoning_content).toBe("thinking...");
    expect(body.messages[1]).not.toBe(original);
    expect(body.messages[0]).toBe(untouched);
  });

  it("leaves reasoning fields alone for providers that accept or require them", () => {
    const body = { messages: [{ role: "assistant", content: "hello", reasoning_content: "thinking..." }] };
    stripUnsupportedParams("deepseek", "deepseek-reasoner", body);
    stripUnsupportedParams("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", body);
    stripUnsupportedParams("openai", "gpt-5", body);
    expect(body.messages[0].reasoning_content).toBe("thinking...");
  });

  it("accepts provider-only rules (no match) without throwing", () => {
    for (const rule of __test__.STRIP_RULES) {
      expect(() => __test__.matches(rule, "any-model")).not.toThrow();
    }
    expect(() => stripUnsupportedParams("groq", "any-model", { messages: [] })).not.toThrow();
    expect(() => stripUnsupportedParams("groq", "any-model", {})).not.toThrow();
  });

  it("keeps the existing drop rules working", () => {
    const body = { temperature: 0.2, messages: [] };
    stripUnsupportedParams("anthropic-compatible-x", "claude-sonnet-4-6", body);
    expect(body).not.toHaveProperty("temperature");
  });

  it("applies on the real Groq dispatch path", () => {
    const out = new DefaultExecutor("groq").transformRequest("openai/gpt-oss-120b", makeBody());
    expect(out.messages[1]).not.toHaveProperty("reasoning_content");
    expect(out.messages[1]).not.toHaveProperty("reasoning");
    expect(out.messages[1]).not.toHaveProperty("reasoning_details");
  });
});
