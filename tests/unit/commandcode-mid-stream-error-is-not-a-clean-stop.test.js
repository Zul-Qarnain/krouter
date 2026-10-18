// 0.5.165 (upstream 092c84ea) — two halves of the same failure.
//
// 1. A `type:"error"` event that arrives AFTER content started flowing was turned
//    into assistant content plus finish_reason:"stop". HTTP 200 was already sent,
//    so the client saw a half-written answer that looked finished and cached it.
//    Now the translator throws, and the stream handler's in-band terminal frame
//    (0.5.165 p2-stream-abort) reports the abort to the client instead.
//    The leading-error case is unaffected: inspectAndWrapCommandCodeResponse
//    still converts it to a real HTTP status before the stream is committed.
//
// 2. "Network connection lost." is the most common of those errors and it is
//    transient. execute() now retries a 502/503/504 verdict up to twice before
//    giving up on the account.
import { describe, it, expect, vi } from "vitest";
import { convertCommandCodeToOpenAI } from "../../open-sse/translator/response/commandcode-to-openai.js";
import {
  CommandCodeExecutor,
  inspectAndWrapCommandCodeResponse,
} from "../../open-sse/executors/commandcode.js";

const ndjson = (lines) => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      controller.close();
    },
  });
};
const response = (lines) => new Response(ndjson(lines), {
  status: 200,
  headers: { "Content-Type": "application/x-ndjson" },
});
const sseContent = (text) => text
  .split("\n")
  .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
  .map((l) => JSON.parse(l.slice(6)))
  .map((c) => c.choices?.[0]?.delta?.content || "")
  .join("");

describe("a mid-stream Command Code error aborts rather than faking a stop", () => {
  it("throws with the readable message instead of emitting it as content", () => {
    const state = {};
    convertCommandCodeToOpenAI(JSON.stringify({ type: "text-delta", delta: "partial" }), state);
    expect(() => convertCommandCodeToOpenAI(
      JSON.stringify({ type: "error", error: { type: "server_error", message: "Boom" } }),
      state,
    )).toThrow(/Boom/);
  });

  it("stringifies an object error rather than showing [object Object]", () => {
    try {
      convertCommandCodeToOpenAI(JSON.stringify({ type: "error", error: { code: 500 } }), {});
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error.message).toContain("500");
      expect(error.message).not.toContain("[object Object]");
    }
  });

  it("never reports finish_reason stop for the errored turn", () => {
    const state = {};
    convertCommandCodeToOpenAI(JSON.stringify({ type: "text-delta", delta: "partial" }), state);
    try {
      convertCommandCodeToOpenAI(JSON.stringify({ type: "error", error: "nope" }), state);
    } catch { /* expected */ }
    expect(state.finishReason).not.toBe("stop");
  });

  it("errors the response stream so the client's terminal frame fires", async () => {
    const wrapped = await inspectAndWrapCommandCodeResponse(response([
      { type: "start" },
      { type: "text-delta", delta: "half an answer" },
      { type: "error", error: { message: "Network connection lost." } },
      { type: "finish" },
    ]), "cc-model");

    expect(wrapped.status).toBe(200); // headers are long gone by then
    await expect(wrapped.text()).rejects.toThrow(/Network connection lost/);
  });

  it("still maps a leading error to a real status before anything is committed", async () => {
    const wrapped = await inspectAndWrapCommandCodeResponse(response([
      { type: "start" },
      { type: "error", error: { message: "rate limit exceeded" } },
    ]), "cc-model");

    expect(wrapped.status).toBe(429);
    const body = await wrapped.json();
    expect(body.error.message).toContain("rate limit exceeded");
  });
});

describe("CommandCodeExecutor retries a transient upstream stream error", () => {
  const runWithUpstreams = async (upstreams) => {
    const exec = new CommandCodeExecutor();
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(exec));
    let calls = 0;
    const spy = vi.spyOn(proto, "execute").mockImplementation(async () => {
      const lines = upstreams[Math.min(calls, upstreams.length - 1)];
      calls++;
      return { response: response(lines) };
    });
    try {
      const result = await exec.execute({ model: "cc-model" });
      return { result, calls: () => calls };
    } finally {
      spy.mockRestore();
    }
  };

  it("retries a 503 verdict and serves the recovered stream", async () => {
    const { result, calls } = await runWithUpstreams([
      [{ type: "error", error: { type: "server_error", message: "Network connection lost." } }],
      [{ type: "start" }, { type: "text-delta", delta: "recovered" }, { type: "finish" }],
    ]);

    expect(calls()).toBe(2);
    expect(result.response.status).toBe(200);
    expect(sseContent(await result.response.text())).toBe("recovered");
  });

  it("gives up after two retries and hands the error status to fallback", async () => {
    const { result, calls } = await runWithUpstreams([
      [{ type: "error", error: { type: "server_error", message: "Service temporarily unavailable." } }],
    ]);

    expect(calls()).toBe(3);
    expect(result.response.status).toBe(503);
  });

  it("does not retry a verdict another account could not fix", async () => {
    const { result, calls } = await runWithUpstreams([
      [{ type: "error", error: { message: "rate limit exceeded" } }],
    ]);

    expect(calls()).toBe(1);
    expect(result.response.status).toBe(429);
  });

  it("does not retry a healthy stream", async () => {
    const { result, calls } = await runWithUpstreams([
      [{ type: "start" }, { type: "text-delta", delta: "fine" }, { type: "finish" }],
    ]);

    expect(calls()).toBe(1);
    expect(sseContent(await result.response.text())).toBe("fine");
  });
}, 20000);
