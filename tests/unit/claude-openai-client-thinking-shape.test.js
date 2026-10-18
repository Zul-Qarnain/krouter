// 0.5.166 — the thinking shape an OpenAI-format client gets on Claude.
//
// ac9120fd: Opus 5.5, Sonnet 5.5 and Fable think on every turn and take
// output_config.effort; a budget switch ({type:"enabled", budget_tokens}) is the
// old shape (kRouter 0.5.164 notes Fable answers it with 400). These models get
// the effort and no thinking switch, never "disabled" from reasoning_effort none.
//
// 90b06934: Claude returns thinking text only with thinking.display "summarized",
// and the redact-thinking beta blanks it. An OpenAI client that sets
// reasoning_effort is asking for reasoning_content, so ask Claude for summaries
// and drop redact-thinking for that request.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { selectAnthropicBeta } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const REDACT = "redact-thinking-2026-02-12";
const chat = (model, extra = {}) => ({ model, messages: [{ role: "user", content: "Is 391 prime?" }], ...extra });
const toClaude = (model, extra) => translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, chat(model, extra), true, null, "claude");

describe("always-thinking models get effort, not a budget switch (ac9120fd)", () => {
  it.each([
    ["none", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"],
  ])("Opus 5.5 reasoning_effort %s -> effort %s", (effort, expected) => {
    const out = toClaude("claude-opus-5-5", { reasoning_effort: effort });
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toEqual({ effort: expected });
  });

  it.each(["claude-sonnet-5-5", "claude-fable-5-1"])("%s gets effort for reasoning_effort high", (model) => {
    const out = toClaude(model, { reasoning_effort: "high" });
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("a budget thinking block from the client becomes an effort", () => {
    const out = toClaude("claude-opus-5-5", { thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("no reasoning ask sends neither field", () => {
    const out = toClaude("claude-opus-5-5");
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toBeUndefined();
  });

  it("models that can turn thinking off keep the budget shape", () => {
    const out = toClaude("claude-opus-5", { reasoning_effort: "high" });
    expect(out.thinking).toMatchObject({ type: "enabled", budget_tokens: 16384 });
    expect(out.output_config).toBeUndefined();
  });

  it("reasoning_effort none still means no thinking on models that can turn it off", () => {
    const out = toClaude("claude-opus-5", { reasoning_effort: "none" });
    expect(out.thinking).toBeUndefined();
  });
});

describe("OpenAI clients asking for reasoning get Claude's summaries (90b06934)", () => {
  it("reasoning_effort asks for summarized thinking", () => {
    const out = toClaude("claude-opus-5", { reasoning_effort: "high" });
    expect(out.thinking.display).toBe("summarized");
  });

  it("an explicit display from the client is kept", () => {
    const out = openaiToClaudeRequest("claude-opus-5", chat("claude-opus-5", {
      reasoning_effort: "high", thinking: { type: "enabled", budget_tokens: 4096, display: "omitted" },
    }), true);
    expect(out.thinking.display).toBe("omitted");
  });

  it("no reasoning ask leaves display unset", () => {
    expect(toClaude("claude-opus-5").thinking?.display).toBeUndefined();
    expect(toClaude("claude-opus-5", { reasoning_effort: "none" }).thinking?.display).toBeUndefined();
  });

  it("non-Claude models on a Claude-format provider never get the field", () => {
    const out = openaiToClaudeRequest("kimi-k2.7", chat("kimi-k2.7", { reasoning_effort: "high" }), true);
    expect(out.thinking).toMatchObject({ type: "enabled" });
    expect(out.thinking.display).toBeUndefined();
  });

  it("selectAnthropicBeta drops redact-thinking only when summaries were asked for", () => {
    expect(selectAnthropicBeta("claude-opus-5")).toContain(REDACT);
    expect(selectAnthropicBeta("claude-opus-5", { thinking: { type: "enabled", display: "omitted" } })).toContain(REDACT);
    expect(selectAnthropicBeta("claude-opus-5", { thinking: { type: "enabled", display: "summarized" } })).not.toContain(REDACT);
  });

  it("the claude executor sends the beta set that matches the body", () => {
    const executor = new DefaultExecutor("claude");
    const summarized = executor.buildHeaders({ accessToken: "t" }, true, null, "claude-opus-5", { thinking: { type: "enabled", display: "summarized" } });
    const plain = executor.buildHeaders({ accessToken: "t" }, true, null, "claude-opus-5", { thinking: { type: "enabled" } });
    expect(summarized["Anthropic-Beta"]).not.toContain(REDACT);
    expect(plain["Anthropic-Beta"]).toContain(REDACT);
  });
});
