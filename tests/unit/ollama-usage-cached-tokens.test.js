/**
 * Ollama reports prompt-cache reads as prompt_eval_cached_count, a subset of
 * prompt_eval_count (cache-INCLUSIVE, like OpenAI). kRouter dropped it:
 *   - streaming: extractUsage() built usage from prompt_eval_count/eval_count only,
 *     so cached prompts were billed at the full input rate;
 *   - non-streaming: extractUsageFromResponse() had no Ollama branch at all, so a
 *     stream:false Ollama request recorded no usage row whatsoever.
 *
 * Ported from upstream 46627249 (usageTracking + requestDetail hunks).
 */
import { describe, expect, it } from "vitest";
import { extractUsage } from "../../open-sse/utils/usageTracking.js";
import { extractUsageFromResponse } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("Ollama streaming usage (extractUsage)", () => {
  it("surfaces prompt_eval_cached_count as cached_tokens on the done chunk", () => {
    const u = extractUsage({ model: "gpt-oss:120b", done: true, prompt_eval_count: 100, eval_count: 20, prompt_eval_cached_count: 80 });
    expect(u.prompt_tokens).toBe(100); // cache-INCLUSIVE, unchanged
    expect(u.completion_tokens).toBe(20);
    expect(u.total_tokens).toBe(120);
    expect(u.cached_tokens).toBe(80);
  });

  it("reports zero cached tokens when Ollama sends no cache count", () => {
    const u = extractUsage({ model: "llama3", done: true, prompt_eval_count: 26, eval_count: 282 });
    expect(u.prompt_tokens).toBe(26);
    expect(u.cached_tokens).toBe(0);
  });
});

describe("Ollama non-streaming usage (extractUsageFromResponse)", () => {
  it("reads the top-level prompt_eval_count/eval_count of a done body", () => {
    const u = extractUsageFromResponse({ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 26, eval_count: 282, message: { role: "assistant", content: "hi" } });
    expect(u).toEqual({ prompt_tokens: 26, completion_tokens: 282, total_tokens: 308, cached_tokens: 0 });
  });

  it("carries prompt_eval_cached_count as cached_tokens", () => {
    const u = extractUsageFromResponse({ model: "gpt-oss:120b", done: true, prompt_eval_count: 100, eval_count: 20, prompt_eval_cached_count: 80 });
    expect(u.prompt_tokens).toBe(100);
    expect(u.completion_tokens).toBe(20);
    expect(u.cached_tokens).toBe(80);
  });

  it("ignores a body that is not the final (done) Ollama message", () => {
    expect(extractUsageFromResponse({ model: "x", done: false, prompt_eval_count: 5 })).toBeNull();
  });

  it("leaves OpenAI-shaped bodies on their own branch", () => {
    const u = extractUsageFromResponse({ done: true, usage: { prompt_tokens: 9, completion_tokens: 3 } });
    expect(u.prompt_tokens).toBe(9);
    expect(u.total_tokens).toBeUndefined();
  });
});
