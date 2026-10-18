// 0.5.165 (upstream 8f4e3800) — a combo seat that answers HTTP 200 with no
// content, no tool calls and no reasoning, and with no real finish (missing,
// in_progress or incomplete), gave the client an empty answer although later
// members could have answered. On a non-final seat that now falls through.
// A finish of "length" (the caller's budget ran out) stays a success, and the
// final seat's answer is always returned as-is.
import { describe, expect, it } from "vitest";
import { handleComboChat, isZeroContentResponse } from "../../open-sse/services/combo.js";

const quietLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});
const chat = (message, finish_reason) => ({ object: "chat.completion", choices: [{ index: 0, message, finish_reason }] });
const GOOD = chat({ role: "assistant", content: "hello" }, "stop");

async function runCombo(firstBody, { stream = false } = {}) {
  const calls = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: ["p/first", "p/second"],
    handleSingleModel: async (_b, m) => {
      calls.push(m);
      if (m === "p/first") {
        if (stream) {
          return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return json(200, firstBody);
      }
      return json(200, GOOD);
    },
    log: quietLog,
    autoSwitch: false,
  });
  return { res, calls, body: await res.json().catch(() => null) };
}

describe("isZeroContentResponse", () => {
  it("flags an OpenAI completion with empty content and no finish", () => {
    expect(isZeroContentResponse(chat({ role: "assistant", content: "" }, null))).toBe(true);
    expect(isZeroContentResponse(chat({ role: "assistant", content: "" }, "in_progress"))).toBe(true);
    expect(isZeroContentResponse(chat({ role: "assistant", content: "  " }, "incomplete"))).toBe(true);
    expect(isZeroContentResponse({ object: "chat.completion", choices: [] })).toBe(true);
  });

  it("flags a Claude message with no blocks and no stop_reason", () => {
    expect(isZeroContentResponse({ type: "message", role: "assistant", content: [], stop_reason: null })).toBe(true);
  });

  it("does not flag real output", () => {
    expect(isZeroContentResponse(GOOD)).toBe(false);
    expect(isZeroContentResponse(chat({ role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }] }, null))).toBe(false);
    expect(isZeroContentResponse(chat({ role: "assistant", content: "", reasoning_content: "thinking..." }, null))).toBe(false);
    expect(isZeroContentResponse({ type: "message", content: [{ type: "tool_use", id: "t", name: "f", input: {} }], stop_reason: null })).toBe(false);
    expect(isZeroContentResponse({ type: "message", content: [{ type: "thinking", thinking: "hmm" }], stop_reason: null })).toBe(false);
  });

  it("keeps a real finish as a success even when empty", () => {
    expect(isZeroContentResponse(chat({ role: "assistant", content: "" }, "length"))).toBe(false);
    expect(isZeroContentResponse(chat({ role: "assistant", content: "" }, "stop"))).toBe(false);
    expect(isZeroContentResponse({ type: "message", content: [], stop_reason: "max_tokens" })).toBe(false);
  });

  it("leaves shapes it does not know alone (Responses objects, junk)", () => {
    expect(isZeroContentResponse({ object: "response", status: "completed", output: [] })).toBe(false);
    expect(isZeroContentResponse(null)).toBe(false);
    expect(isZeroContentResponse("text")).toBe(false);
  });
});

describe("handleComboChat on a zero-content 200", () => {
  it("falls through to the next member", async () => {
    const { res, calls, body } = await runCombo(chat({ role: "assistant", content: "" }, null));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["p/first", "p/second"]);
    expect(body.choices[0].message.content).toBe("hello");
  });

  it("returns a 'length' finish from the first seat untouched", async () => {
    const { calls } = await runCombo(chat({ role: "assistant", content: "" }, "length"));
    expect(calls).toEqual(["p/first"]);
  });

  it("never peeks into a streaming response", async () => {
    const { calls } = await runCombo(null, { stream: true });
    expect(calls).toEqual(["p/first"]);
  });

  it("returns the final seat's empty answer rather than an error", async () => {
    const calls = [];
    const empty = chat({ role: "assistant", content: "" }, null);
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel: async (_b, m) => { calls.push(m); return json(200, empty); },
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["p/only"]);
  });

  it("reports the later seat's real error, not a 200, when everything after the empty seat fails", async () => {
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/first", "p/second"],
      handleSingleModel: async (_b, m) => (m === "p/first"
        ? json(200, chat({ role: "assistant", content: "" }, null))
        : json(503, { error: { message: "upstream down" } })),
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.status).toBe(503);
  });
});
