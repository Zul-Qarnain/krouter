// 0.5.165 (upstream 49ba54b2 + a07ed95b) — Sonnet 5.5, Opus 5.5 and Fable think on
// every turn. Anthropic answers 400 for thinking {type:"disabled"} and for a forced
// tool_choice (any / tool) on these models. OpenAI clients hit it through
// tool_choice:"required" (LangChain structured output), and the provider-level
// thinking "off" injects `disabled`. The rewrite keys on the model's
// thinkingCanDisable:false caps flag:
//   - Sonnet 5.5: disabled -> between_tools, effort clamped to high
//   - Opus 5.5 / Fable: disabled -> dropped
//   - forced tool_choice -> auto, disable_parallel_tool_use kept
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { prepareClaudeRequest, applyClaudeModelRules } from "../../open-sse/translator/helpers/claudeHelper.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const base = (extra) => ({ max_tokens: 1024, messages: [{ role: "user", content: "hi" }], ...extra });
const prepare = (extra, provider = "claude") => prepareClaudeRequest(base(extra), provider);

describe("thinking disabled on always-thinking Claude models", () => {
  it("Sonnet 5.5 turns thinking down to between_tools and clamps effort to high", () => {
    const out = prepare({ model: "claude-sonnet-5-5", thinking: { type: "disabled" }, output_config: { effort: "max" } });
    expect(out.thinking).toEqual({ type: "between_tools" });
    expect(out.output_config.effort).toBe("high");
  });

  it("Sonnet 5.5 keeps an effort that is already within between_tools' range", () => {
    const out = prepare({ model: "claude-sonnet-5-5", thinking: { type: "disabled" }, output_config: { effort: "medium" } });
    expect(out.output_config.effort).toBe("medium");
  });

  it.each(["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"])("%s drops the disabled switch", (model) => {
    const out = prepare({ model, thinking: { type: "disabled" } });
    expect(out.thinking).toBeUndefined();
  });

  it("leaves models that can turn thinking off untouched", () => {
    const out = prepare({ model: "claude-sonnet-5", thinking: { type: "disabled" } });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("does not clamp a client's effort when thinking was not disabled", () => {
    const out = prepare({ model: "claude-sonnet-5-5", output_config: { effort: "max" } });
    expect(out.output_config.effort).toBe("max");
  });
});

describe("forced tool_choice on always-thinking Claude models", () => {
  it.each(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"])("%s gets auto for any", (model) => {
    expect(prepare({ model, tool_choice: { type: "any" } }).tool_choice).toEqual({ type: "auto" });
  });

  it("keeps disable_parallel_tool_use when a named tool is forced", () => {
    const out = prepare({ model: "claude-opus-5-5", tool_choice: { type: "tool", name: "run", disable_parallel_tool_use: true } });
    expect(out.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("leaves Opus 5 and non-forced choices untouched", () => {
    expect(prepare({ model: "claude-opus-5", tool_choice: { type: "any" } }).tool_choice).toEqual({ type: "any" });
    expect(prepare({ model: "claude-opus-5-5", tool_choice: { type: "none" } }).tool_choice).toEqual({ type: "none" });
  });

  it("does not touch a non-Claude model that also cannot turn thinking off", () => {
    // gemini-3 has thinkingCanDisable:false too; a gateway fronting it keeps its choice.
    const out = prepare({ model: "gemini-3-pro", tool_choice: { type: "any" } }, "anthropic-compatible-gw");
    expect(out.tool_choice).toEqual({ type: "any" });
  });
});

describe("applyClaudeModelRules is copy-on-write", () => {
  it("does not mutate the caller's body or nested objects", () => {
    const outputConfig = { effort: "xhigh" };
    const toolChoice = { type: "any" };
    const input = { model: "claude-sonnet-5-5", thinking: { type: "disabled" }, output_config: outputConfig, tool_choice: toolChoice };
    const out = applyClaudeModelRules(input, "claude-sonnet-5-5");
    expect(out).not.toBe(input);
    expect(input.thinking).toEqual({ type: "disabled" });
    expect(outputConfig.effort).toBe("xhigh");
    expect(toolChoice).toEqual({ type: "any" });
  });

  it("returns the same body when nothing applies", () => {
    const input = { model: "claude-sonnet-5-5", thinking: { type: "adaptive" } };
    expect(applyClaudeModelRules(input, "claude-sonnet-5-5")).toBe(input);
  });
});

describe("every request path is covered", () => {
  it("an OpenAI client with tool_choice required on Sonnet 5.5", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-sonnet-5-5", {
      model: "claude-sonnet-5-5", tool_choice: "required", thinking: { type: "disabled" },
      tools: [{ type: "function", function: { name: "run", parameters: { type: "object", properties: {} } } }],
      messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.tool_choice.type).toBe("auto");
    expect(out.thinking).toEqual({ type: "between_tools" });
  });

  it("a native Claude body (same-format translate) on Opus 5.5", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-opus-5-5", {
      model: "claude-opus-5-5", max_tokens: 1000, thinking: { type: "disabled" }, tool_choice: { type: "any" },
      tools: [{ name: "run", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.thinking).toBeUndefined();
    expect(out.tool_choice).toEqual({ type: "auto" });
  });

  it.each(["claude", "anthropic", "anthropic-compatible-node"])(
    "the %s executor rewrites a passthrough body that skipped the translator", (provider) => {
      // Claude Code -> claude passthrough (and the provider-level "off" injection on it)
      // never reaches prepareClaudeRequest; the executor is the last stop.
      const body = { model: "claude-sonnet-5-5", thinking: { type: "disabled" }, tool_choice: { type: "any" }, messages: [{ role: "user", content: "hi" }] };
      const out = new DefaultExecutor(provider).transformRequest("claude-sonnet-5-5", body, true, { apiKey: "k" });
      expect(out.thinking).toEqual({ type: "between_tools" });
      expect(out.tool_choice).toEqual({ type: "auto" });
      expect(body.thinking).toEqual({ type: "disabled" });
    });

  it("the executor leaves a non-Claude-format provider alone", () => {
    const body = { model: "claude-sonnet-5-5", tool_choice: { type: "any" }, messages: [{ role: "user", content: "hi" }] };
    const out = new DefaultExecutor("openrouter").transformRequest("claude-sonnet-5-5", body, true, { apiKey: "k" });
    expect(out.tool_choice).toEqual({ type: "any" });
  });
});
