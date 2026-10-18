/**
 * 0.5.166 (upstream 6e4f82db) — Gemini validates that functionCall ids are
 * unique across the WHOLE conversation and rejects the entire request with
 * 400 INVALID_ARGUMENT when one repeats. An OpenAI tool_call_id is only unique
 * within its own assistant turn, so a long agent session can replay call_51859
 * at turn 14 and again at turn 22.
 *
 * Uniqueness is per OCCURRENCE: the emitted id is rewritten, the content lookup
 * still keys on the ORIGINAL id and consumes one queued result per occurrence.
 */
import { describe, expect, it } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const pair = (id, name, args) => ({
  role: "assistant",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args || {}) } }],
});
const result = (id, content) => ({ role: "tool", tool_call_id: id, content });

function emitted(body) {
  const out = openaiToGeminiRequest("gemini-3-flash", { model: "gemini-3-flash", ...body }, false);
  const calls = [];
  const resps = [];
  for (const c of out.contents || []) {
    for (const p of c.parts || []) {
      if (p.functionCall) calls.push({ id: p.functionCall.id, name: p.functionCall.name });
      if (p.functionResponse) resps.push({ id: p.functionResponse.id, name: p.functionResponse.name });
    }
  }
  return { calls, resps };
}

describe("duplicate tool_call_ids are uniquified", () => {
  const twoTurns = {
    messages: [
      { role: "user", content: "run step 1" },
      pair("call_51859", "bash", { command: "echo 1" }),
      result("call_51859", "1"),
      { role: "user", content: "run step 2" },
      pair("call_51859", "bash", { command: "echo 2" }),
      result("call_51859", "2"),
    ],
  };

  it("emits a distinct id for each occurrence", () => {
    const { calls } = emitted(twoTurns);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
  });

  it("leaves the FIRST occurrence untouched", () => {
    expect(emitted(twoTurns).calls[0].id).toBe("call_51859");
  });

  it("keeps every functionResponse pointing at its own functionCall", () => {
    const { calls, resps } = emitted(twoTurns);
    expect(resps.map((r) => r.id)).toEqual(calls.map((c) => c.id));
  });

  it("handles the same id reused for a DIFFERENT tool name", () => {
    const { calls, resps } = emitted({
      messages: [
        pair("call_x", "edit", { f: "a" }), result("call_x", "ok"),
        pair("call_x", "bash", { c: "ls" }), result("call_x", "done"),
      ],
    });
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(resps[0].id).toBe(calls[0].id);
    expect(resps[1].id).toBe(calls[1].id);
    expect(resps[1].name).toBe("bash");
  });

  it("uniquifies three collisions of one id", () => {
    const { calls, resps } = emitted({
      messages: [
        pair("c", "t", {}), result("c", "1"),
        pair("c", "t", {}), result("c", "2"),
        pair("c", "t", {}), result("c", "3"),
      ],
    });
    expect(new Set(calls.map((x) => x.id)).size).toBe(3);
    expect(resps.map((r) => r.id)).toEqual(calls.map((c) => c.id));
  });

  it("does not collide when an id already ends in the suffix it would generate", () => {
    const { calls } = emitted({
      messages: [
        pair("call-2", "a", {}), result("call-2", "1"),
        pair("call", "b", {}), result("call", "2"),
        pair("call", "c", {}), result("call", "3"),
      ],
    });
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
  });

  it("leaves an already-unique conversation completely unchanged", () => {
    const { calls, resps } = emitted({
      messages: [
        pair("call_a", "alpha", {}), result("call_a", "1"),
        pair("call_b", "beta", {}), result("call_b", "2"),
      ],
    });
    expect(calls.map((c) => c.id)).toEqual(["call_a", "call_b"]);
    expect(resps.map((r) => r.id)).toEqual(["call_a", "call_b"]);
  });

  it("uniquifies duplicates among sibling calls in ONE turn", () => {
    const { calls, resps } = emitted({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "dup", type: "function", function: { name: "one", arguments: "{}" } },
            { id: "dup", type: "function", function: { name: "two", arguments: "{}" } },
          ],
        },
        result("dup", "1"),
        result("dup", "2"),
      ],
    });
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(resps).toHaveLength(2);
  });
});

describe("response CONTENT still resolves per occurrence", () => {
  it("gives each turn its own tool result, not the first one twice", () => {
    const out = openaiToGeminiRequest("gemini-3-flash", {
      model: "gemini-3-flash",
      messages: [
        pair("same", "bash", { command: "echo 1" }), result("same", "FIRST"),
        pair("same", "bash", { command: "echo 2" }), result("same", "SECOND"),
      ],
    }, false);
    const texts = [];
    for (const c of out.contents || []) {
      for (const p of c.parts || []) {
        if (p.functionResponse) texts.push(JSON.stringify(p.functionResponse.response));
      }
    }
    expect(texts.join(" ")).toContain("FIRST");
    expect(texts.join(" ")).toContain("SECOND");
  });

  it("the response NAME comes from its own call, not a later duplicate", () => {
    const { resps } = emitted({
      messages: [
        pair("id", "first_tool", {}), result("id", "1"),
        pair("id", "second_tool", {}), result("id", "2"),
      ],
    });
    expect(resps[0].name).toBe("first_tool");
    expect(resps[1].name).toBe("second_tool");
  });
});
