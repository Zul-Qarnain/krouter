// 0.5.165 (upstream 0dd4d6be) — normalizeCodexTools rebuilds every function tool
// and used to drop `strict`. An explicit boolean from the client (flat Responses
// shape or nested Chat shape, including what the Chat -> Responses translator
// emits) now survives; an unspecified flag stays unset.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function normalize(body) {
  new CodexExecutor().transformRequest("gpt-5.5", body, true, { connectionId: "test-codex-strict", providerSpecificData: {} });
  return body.tools;
}

const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }];
const parameters = { type: "object", properties: { sessionID: { type: "string" } }, required: [] };

describe("Codex tool strict flag", () => {
  it("preserves explicit strict flags without touching optional arguments", () => {
    const tools = normalize({
      model: "gpt-5.5",
      input,
      tools: [
        { type: "function", name: "flat_false", strict: false, parameters },
        { type: "function", name: "flat_true", strict: true, parameters },
        { type: "function", function: { name: "nested_false", strict: false, parameters } },
        { type: "function", function: { name: "nested_true", strict: true, parameters } },
        { type: "function", name: "unspecified", parameters },
        { type: "function", name: "not_boolean", strict: "yes", parameters },
      ],
    });
    expect(tools.map((t) => t.strict)).toEqual([false, true, false, true, undefined, undefined]);
    for (const tool of tools) expect(tool.parameters.required).toEqual([]);
    expect(tools[4]).not.toHaveProperty("strict");
    expect(tools[5]).not.toHaveProperty("strict");
  });

  it("keeps strict from a Chat Completions client through translation", () => {
    const chat = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "probe" }],
      tools: [{ type: "function", function: { name: "lookup", strict: false, parameters } }],
    };
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-5.5", chat, true, {}, "codex");
    const tools = normalize(translated);
    expect(tools[0]).toMatchObject({ type: "function", name: "lookup", strict: false });
  });
});
