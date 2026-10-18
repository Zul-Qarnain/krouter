// 0.5.166 — a stream that aborts after HTTP 200 cannot change its status, so the
// failure has to travel in-band. Before this, only Responses passthrough got a
// terminal frame; every other client saw "200 OK, a few chunks, then nothing" and
// could not tell a truncated reply from a finished one (upstream 93001213).
//
// OpenAI-compatible clients get data: {"error":{...}} then data: [DONE]
// (openai-python raises APIError on any data payload carrying an error key, which
// it checks before [DONE]). Claude clients get `event: error`. A synthetic
// finish_reason is never emitted: a truncated stream must not look like a stop.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { buildStreamErrorBytes } = await import("../../open-sse/utils/streamHelpers.js");
const { pipeWithDisconnect, createStreamController } = await import("../../open-sse/utils/streamHandler.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
// Registers the openai -> claude response translator (the app does this at startup).
await import("../../open-sse/translator/response/openai-to-claude.js");

const encoder = new TextEncoder();
const textOf = (bytes) => new TextDecoder().decode(bytes);
const jsonOf = (sse) => JSON.parse(sse.match(/\{.*\}/s)[0]);

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// Upstream body that sends `chunks`, then fails with `error` (a socket reset by default).
function failingUpstream(chunks, error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      setTimeout(() => controller.error(error), 5);
    },
  });
}

describe("buildStreamErrorBytes", () => {
  // onAbortTerminal callbacks are enqueued verbatim, so a string here would be a
  // silent no-op at runtime (createDisconnectAwareStream swallows the throw).
  it("returns bytes, not a string", () => {
    expect(buildStreamErrorBytes(504, "x", FORMATS.OPENAI)).toBeInstanceOf(Uint8Array);
  });

  it("emits the error frame then [DONE] for OpenAI clients", () => {
    const out = textOf(buildStreamErrorBytes(504, "stream stall timeout", FORMATS.OPENAI));

    expect(out).toContain('data: {"error"');
    expect(out.indexOf("data: [DONE]")).toBeGreaterThan(out.indexOf('data: {"error"'));
    expect(jsonOf(out).error).toEqual({
      message: "stream stall timeout",
      type: "server_error",
      code: "gateway_timeout",
    });
    expect(out).not.toContain("finish_reason");
  });

  it("emits event: error (no [DONE]) for Claude clients", () => {
    const out = textOf(buildStreamErrorBytes(504, "stream stall timeout", FORMATS.CLAUDE));

    expect(out).toContain("event: error\n");
    expect(out).not.toContain("[DONE]");
    expect(jsonOf(out)).toMatchObject({ type: "error", error: { message: "stream stall timeout" } });
    expect(out).not.toContain("stop_reason");
  });
});

describe("abort reason through pipeWithDisconnect", () => {
  const passthrough = () => new TransformStream();
  const capture = () => {
    const seen = [];
    const fn = (message) => { seen.push(message); return buildStreamErrorBytes(504, message, FORMATS.OPENAI); };
    return { seen, fn };
  };

  it("hands the stall reason to onAbortTerminal and delivers the frame", async () => {
    // Real controller: the abort must reach the upstream body for the pipe to end.
    const ctrl = createStreamController({ provider: "test", model: "test" });
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: hi\n\n"));
        ctrl.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });
    const { seen, fn } = capture();

    const text = await readAll(pipeWithDisconnect({ body: upstream }, passthrough(), ctrl, fn, 50));

    expect(seen).toEqual(["stream stall timeout"]);
    expect(text).toContain('"stream stall timeout"');
    expect(text).toContain("data: [DONE]");
  });

  it("reports a lost upstream socket as 'upstream connection lost'", async () => {
    const ctrl = createStreamController({ provider: "test", model: "test" });
    const { seen, fn } = capture();

    const text = await readAll(pipeWithDisconnect({ body: failingUpstream(["data: hi\n\n"]) }, passthrough(), ctrl, fn, 5000));

    expect(seen).toEqual(["upstream connection lost"]);
    expect(text).toContain("data: hi");
    expect(text).toContain('"upstream connection lost"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  // kRouter adaptation: a translator or executor that throws mid-stream (Command
  // Code's in-band error, upstream 092c84ea) is not a lost connection, so its own
  // message reaches the client instead of a misleading "connection lost".
  it("passes a non-network error's own message through, and closes cleanly", async () => {
    const ctrl = createStreamController({ provider: "test", model: "test" });
    const { seen, fn } = capture();
    const upstream = failingUpstream(["data: hi\n\n"], new Error("[CommandCode error: Network connection lost.]"));

    const text = await readAll(pipeWithDisconnect({ body: upstream }, passthrough(), ctrl, fn, 5000));

    expect(seen).toEqual(["[CommandCode error: Network connection lost.]"]);
    expect(text).toContain('"[CommandCode error: Network connection lost.]"');
  });

  it("emits nothing extra when the stream finishes normally", async () => {
    const ctrl = createStreamController({ provider: "test", model: "test" });
    const { seen, fn } = capture();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: hi\n\n"));
        controller.close();
      },
    });

    const text = await readAll(pipeWithDisconnect({ body: upstream }, passthrough(), ctrl, fn, 5000));

    expect(seen).toEqual([]);
    expect(text).toBe("data: hi\n\n");
  });
});

// The wiring in handleStreamingResponse: every client format now gets a terminal
// frame, not only Responses passthrough.
describe("handleStreamingResponse abort terminal per client format", () => {
  async function runAbortedStream({ provider, sourceFormat, targetFormat, chunks }) {
    const streamController = createStreamController({ provider, model: "m" });
    const { response } = handleStreamingResponse({
      providerResponse: { body: failingUpstream(chunks), headers: new Headers() },
      provider, model: "m", sourceFormat, targetFormat,
      userAgent: "test", body: { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      stream: true, requestStartTime: Date.now(), connectionId: null, apiKey: null,
      clientRawRequest: { endpoint: "/v1/chat/completions" }, streamController,
      onStreamComplete: () => {},
    });
    return readAll(response.body);
  }

  const openaiChunk = 'data: {"id":"chatcmpl-abcdefgh","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n';

  it("OpenAI client on an OpenAI provider gets the error frame then [DONE]", async () => {
    const text = await runAbortedStream({ provider: "openai", sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, chunks: [openaiChunk] });

    expect(text).toContain("partial");
    expect(text).toContain('data: {"error":{"message":"upstream connection lost"');
    expect(text.indexOf("data: [DONE]")).toBeGreaterThan(text.indexOf('data: {"error"'));
    expect(text).not.toMatch(/"finish_reason":"(stop|length)"/);
  });

  it("Claude client on a translated OpenAI provider gets event: error", async () => {
    const text = await runAbortedStream({ provider: "openai", sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.OPENAI, chunks: [openaiChunk] });

    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"partial"');
    expect(text).toContain("event: error\n");
    expect(text).toContain('"upstream connection lost"');
    expect(text).not.toContain("message_stop");
    expect(text).not.toContain("stop_reason\":\"end_turn");
    expect(text).not.toContain("[DONE]");
  });

  it("Responses passthrough keeps its response.failed terminal", async () => {
    const text = await runAbortedStream({
      provider: "openai",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      chunks: ['event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n'],
    });

    expect(text).toContain("event: response.failed");
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain('data: {"error"');
  });
});
