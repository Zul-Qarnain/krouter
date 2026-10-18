// 0.5.165 (upstream e74db4d0 + 11222eff) — strict Responses upstreams (OpenAI
// /v1/responses, Codex, Muse Spark) reject the whole request with
// InputValidationError on: a nameless function_call or function tool, arguments
// that are not one JSON string, a function_call_output whose output is not a
// string (null used to become the string "null"), a missing call_id, and names
// over 128 characters.
import { describe, expect, it } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

const assistantCall = (tool_calls) => ({ role: "assistant", content: null, tool_calls });
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: args } });

function translate(messages, extra = {}) {
  return openaiToOpenAIResponsesRequest("gpt-x", { messages, ...extra }, true);
}

const fnCalls = (out) => out.input.filter((i) => i.type === "function_call");
const fnOutputs = (out) => out.input.filter((i) => i.type === "function_call_output");

describe("function_call items", () => {
  it("skips nameless calls instead of inventing a _unknown tool", () => {
    const out = translate([
      { role: "user", content: "go" },
      assistantCall([call("c1", "", "{}"), call("c2", "   ", "{}"), call("c3", "read_file", "{}")]),
    ]);
    expect(fnCalls(out).map((c) => c.name)).toEqual(["read_file"]);
  });

  it("sends arguments as exactly one JSON string", () => {
    const out = translate([
      { role: "user", content: "go" },
      assistantCall([
        call("c1", "a", { path: "x" }),
        call("c2", "b", '{"ok":true}'),
        call("c3", "c", '{"partial":'),
        call("c4", "d", undefined),
      ]),
    ]);
    const args = fnCalls(out).map((c) => c.arguments);
    expect(args).toEqual(['{"path":"x"}', '{"ok":true}', "{}", "{}"]);
    for (const a of args) expect(typeof a).toBe("string");
  });

  it("clamps names to 128 characters on both the call and the tool declaration", () => {
    const long = "t".repeat(200);
    const out = translate(
      [{ role: "user", content: "go" }, assistantCall([call("c1", long, "{}")])],
      { tools: [{ type: "function", function: { name: long, parameters: { type: "object", properties: {} } } }] },
    );
    expect(fnCalls(out)[0].name).toHaveLength(128);
    expect(out.tools[0].name).toHaveLength(128);
    expect(fnCalls(out)[0].name).toBe(out.tools[0].name);
  });

  it("gives a call with no id a unique fallback call_id", () => {
    const out = translate([
      { role: "user", content: "go" },
      assistantCall([call(undefined, "a", "{}"), call(undefined, "b", "{}"), call("", "c", "{}")]),
    ]);
    const ids = fnCalls(out).map((c) => c.call_id);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.startsWith("call_")).toBe(true);
      expect(id.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("still clamps an overlong call_id to 64 and keeps it paired with its output", () => {
    const longId = "call_" + "x".repeat(100);
    const out = translate([
      { role: "user", content: "go" },
      assistantCall([call(longId, "a", "{}")]),
      { role: "tool", tool_call_id: longId, content: "done" },
    ]);
    expect(fnCalls(out)[0].call_id).toHaveLength(64);
    expect(fnOutputs(out)[0].call_id).toBe(fnCalls(out)[0].call_id);
  });
});

describe("function_call_output items", () => {
  it("always sends a string output", () => {
    const out = translate([
      { role: "user", content: "go" },
      assistantCall([call("c1", "a", "{}"), call("c2", "b", "{}"), call("c3", "c", "{}"), call("c4", "d", "{}")]),
      { role: "tool", tool_call_id: "c1", content: null },
      { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      { role: "tool", tool_call_id: "c3", content: { ok: 1 } },
      { role: "tool", tool_call_id: "c4", content: "plain" },
    ]);
    expect(fnOutputs(out).map((o) => o.output)).toEqual(["", "AB", '{"ok":1}', "plain"]);
  });

  it("never throws on circular or BigInt tool content", () => {
    const circular = {};
    circular.self = circular;
    const messages = [
      { role: "user", content: "go" },
      assistantCall([call("c1", "a", "{}"), call("c2", "b", "{}")]),
      { role: "tool", tool_call_id: "c1", content: [1n, circular, { text: "ok" }] },
      { role: "tool", tool_call_id: "c2", content: circular },
    ];
    expect(() => translate(messages)).not.toThrow();
    const outputs = fnOutputs(translate(messages)).map((o) => o.output);
    for (const o of outputs) expect(typeof o).toBe("string");
    expect(outputs[0]).toContain("ok");
  });
});

describe("tool declarations", () => {
  it("drops nameless function tools and keeps hosted tools", () => {
    const out = translate([{ role: "user", content: "go" }], {
      tools: [
        { type: "function", function: { name: "", parameters: {} } },
        { type: "function", function: { parameters: {} } },
        { type: "function", function: { name: "ok_tool", parameters: { type: "object" } } },
        { type: "web_search" },
      ],
    });
    expect(out.tools.map((t) => t.name || t.type)).toEqual(["ok_tool", "web_search"]);
  });

  it("keeps kRouter's multi-message instruction merging", () => {
    const out = translate([
      { role: "system", content: "one" },
      { role: "developer", content: [{ type: "text", text: "two" }] },
      { role: "user", content: "go" },
    ]);
    expect(out.instructions).toBe("one\n\ntwo");
  });
});
