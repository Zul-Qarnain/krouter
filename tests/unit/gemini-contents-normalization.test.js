/**
 * 0.5.165 (upstream 8d1db46b + e7b5f09d + 30464bc2 + 625df74d) — one
 * normalizeGeminiContents() shared by the gemini translator, the Claude ->
 * Antigravity envelope and the Antigravity executor.
 *
 * Google answers 400 INVALID_ARGUMENT for every shape below:
 *   - adjacent same-role turns (Antigravity thought-stripping creates them);
 *   - a turn whose parts became empty after stripping;
 *   - a history that does not open on a user turn;
 *   - a history that ends on a model turn, or on an unanswered functionCall;
 *   - a `$ref` key inside functionResponse.response, which Gemini reads as a
 *     pointer into functionResponse.parts.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeGeminiContents,
  sanitizeFunctionResponsePayload,
} from "../../open-sse/translator/helpers/geminiHelper.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

describe("normalizeGeminiContents merges and prunes turns", () => {
  it("merges adjacent same-role turns", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "Prompt" }] },
      { role: "model", parts: [{ text: "Part A" }] },
      { role: "model", parts: [{ text: "Part B" }] },
    ]);
    expect(out[1].role).toBe("model");
    expect(out[1].parts).toEqual([{ text: "Part A" }, { text: "Part B" }]);
  });

  it("drops turns whose parts are empty or all-empty objects", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [] },
      { role: "model", parts: [{}] },
      { role: "user", parts: [{ text: "again" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].parts).toEqual([{ text: "hi" }, { text: "again" }]);
  });

  it("forces a leading user turn", () => {
    const out = normalizeGeminiContents([{ role: "model", parts: [{ text: "prefill" }] }]);
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "..." }] });
    expect(out[1]).toEqual({ role: "model", parts: [{ text: "prefill" }] });
  });

  it("does not mutate the input array or its turns", () => {
    const input = [
      { role: "user", parts: [{ text: "a" }] },
      { role: "user", parts: [{ text: "b" }] },
    ];
    normalizeGeminiContents(input);
    expect(input[0].parts).toHaveLength(1);
    expect(input).toHaveLength(2);
  });

  it("handles empty, null and undefined input", () => {
    expect(normalizeGeminiContents([])).toEqual([]);
    expect(normalizeGeminiContents(null)).toEqual([]);
    expect(normalizeGeminiContents(undefined)).toEqual([]);
  });
});

describe("normalizeGeminiContents guards a terminal model turn", () => {
  it("appends a user Continue turn after a trailing model text turn", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: "user", parts: [{ text: "Continue." }] });
  });

  it("answers an unanswered functionCall with a functionResponse", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "run" }] },
      { role: "model", parts: [{ functionCall: { id: "call_1", name: "search", args: { q: "t" } } }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { id: "call_1", name: "search", response: { result: "Continue." } } }],
    });
  });

  it("answers every unanswered call in the final turn", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "run" }] },
      {
        role: "model",
        parts: [
          { functionCall: { id: "call_1", name: "fn_1" } },
          { functionCall: { id: "call_2", name: "fn_2" } },
        ],
      },
    ]);
    expect(out[2].parts.map((p) => p.functionResponse.id)).toEqual(["call_1", "call_2"]);
  });

  it("prefers the functionResponse shape when the turn has text AND a call", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "run" }] },
      { role: "model", parts: [{ text: "Executing..." }, { functionCall: { id: "call_3", name: "exec" } }] },
    ]);
    expect(out[2].parts[0].functionResponse.id).toBe("call_3");
  });

  it("falls back to name 'tool' and omits the id when the call carries neither", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "Go" }] },
      { role: "model", parts: [{ functionCall: {} }] },
    ]);
    expect(out[2].parts[0]).toEqual({
      functionResponse: { name: "tool", response: { result: "Continue." } },
    });
  });

  it("appends Continue after a thought-only trailing model turn", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "Solve" }] },
      { role: "model", parts: [{ thought: true, text: "Let 2x = 4..." }, { thoughtSignature: "sig", text: "" }] },
    ]);
    expect(out[2]).toEqual({ role: "user", parts: [{ text: "Continue." }] });
  });

  it("leaves a history that already ends on a user turn alone", () => {
    const out = normalizeGeminiContents([{ role: "user", parts: [{ text: "question" }] }]);
    expect(out).toEqual([{ role: "user", parts: [{ text: "question" }] }]);
  });
});

describe("functionResponse $ref sanitization", () => {
  const schemaResult = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/$defs/Config",
    $defs: { Config: { properties: { a: { $ref: "#/$defs/A" } } } },
    list: [{ $ref: "#/$defs/B" }, "plain", 5, null],
  };

  it("renames $ref recursively and leaves other values untouched", () => {
    const out = sanitizeFunctionResponsePayload(schemaResult);
    expect(out.$ref).toBeUndefined();
    expect(out._ref).toBe("#/$defs/Config");
    expect(out.$defs.Config.properties.a._ref).toBe("#/$defs/A");
    expect(out.list).toEqual([{ _ref: "#/$defs/B" }, "plain", 5, null]);
    expect(out.$schema).toBe(schemaResult.$schema);
    expect(sanitizeFunctionResponsePayload("str")).toBe("str");
    expect(sanitizeFunctionResponsePayload(null)).toBeNull();
  });

  it("normalizeGeminiContents sanitizes functionResponse without mutating the input", () => {
    const contents = [
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "webfetch", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "webfetch", response: { result: schemaResult } } }] },
    ];
    const out = normalizeGeminiContents(contents);
    const resp = out[2].parts[0].functionResponse.response;
    expect(JSON.stringify(resp)).not.toContain('"$ref"');
    expect(resp.result._ref).toBe("#/$defs/Config");
    expect(contents[2].parts[0].functionResponse.response.result.$ref).toBe("#/$defs/Config");
  });

  it("renames only $ref, never a key that happens to name an Object.prototype member", () => {
    // Real tool output (webfetch / read / MCP) is arbitrary JSON and may carry a
    // key called "constructor", "toString" or "__proto__". Only $ref is reserved.
    const result = JSON.parse('{"constructor":1,"__proto__":{"a":1},"$ref":"x","toString":"t"}');
    const out = sanitizeFunctionResponsePayload(result);

    expect(Object.keys(out).sort()).toEqual(["__proto__", "_ref", "constructor", "toString"]);
    expect(out.constructor).toBe(1);
    expect(out.toString).toBe("t");
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__").value).toEqual({ a: 1 });
    expect(out._ref).toBe("x");
    expect(Object.hasOwn(out, "$ref")).toBe(false);

    // It is the JSON on the wire that Gemini reads, so the keys must survive it.
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse('{"constructor":1,"__proto__":{"a":1},"_ref":"x","toString":"t"}'));

    // The rename must not reach Object.prototype, and `out` keeps a normal prototype.
    expect(Object.prototype.a).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("passes every inherited Object.prototype name through unchanged", () => {
    const names = ["valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];
    const out = sanitizeFunctionResponsePayload(JSON.parse(JSON.stringify(Object.fromEntries(names.map(n => [n, n])))));
    for (const n of names) expect(out[n]).toBe(n);
    expect(Object.keys(out).sort()).toEqual([...names].sort());
  });

  it("an openai -> gemini JSON-schema tool result carries no $ref key", () => {
    const out = openaiToGeminiRequest("gemini-3-flash", {
      messages: [
        { role: "user", content: "fetch it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "webfetch", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: JSON.stringify(schemaResult) },
        { role: "user", content: "thanks" },
      ],
    }, true);
    const frs = out.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    expect(frs).toHaveLength(1);
    expect(JSON.stringify(frs[0].functionResponse.response)).not.toContain('"$ref"');
    expect(frs[0].functionResponse.response.result._ref).toBe("#/$defs/Config");
  });
});

describe("openai -> gemini applies the normalizer", () => {
  it("emits a functionResponse for an intermediate call whose result is the empty string", () => {
    const out = openaiToGeminiRequest("gemini-3-flash", {
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "" },
        { role: "user", content: "and now?" },
      ],
    }, true);
    const frs = out.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    expect(frs).toHaveLength(1);
    expect(frs[0].functionResponse.id).toBe("c1");
  });

  it("never emits two adjacent same-role turns", () => {
    const out = openaiToGeminiRequest("gemini-3-flash", {
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "x" },
        { role: "assistant", content: "y" },
        { role: "user", content: "c" },
      ],
    }, true);
    const roles = out.contents.map((c) => c.role);
    expect(roles.every((r, i) => i === 0 || r !== roles[i - 1])).toBe(true);
  });
});
