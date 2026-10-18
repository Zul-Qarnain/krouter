/**
 * 0.5.166 — Kiro executor integrity fixes (upstream b44bb09f, executor hunks).
 *
 * A. Tool-call bytes never reached totalContentLength, so the /4 estimator in
 *    finish() reported OUT 0 -- or the Math.max floor of 1 -- for every turn
 *    whose whole answer was a tool call.
 * B. model_context_window_exceeded / max_tokens after real output hard-failed
 *    as kiro_terminal_incomplete, throwing away a usable answer. A truncated
 *    turn is what finish_reason "length" is for. A truncation with no semantic
 *    output still fails closed (kRouter keys this on real text/reasoning/code,
 *    not on chunkIndex, so empty content deltas do not count as output).
 * C. One unusable tool fragment cleared every buffered tool and the text.
 *
 * The cache-token half (D) shipped in v0.5.142; the canonicalizer guard (E)
 * has no home here (kRouter has no kiroConversation.js).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args)
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");

const encoder = new TextEncoder();
const credentials = {
  accessToken: "test-token",
  providerSpecificData: { kiroToolCallRepair: true }
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const bytes = new Uint8Array(1 + nameBytes.length + 3 + valueBytes.length);
  let offset = 0;
  bytes[offset++] = nameBytes.length;
  bytes.set(nameBytes, offset);
  offset += nameBytes.length;
  bytes[offset++] = 7;
  new DataView(bytes.buffer).setUint16(offset, valueBytes.length, false);
  offset += 2;
  bytes.set(valueBytes, offset);
  return bytes;
}

function concat(chunks) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function checksum(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
  view.setUint32(bytes.byteLength - 4, crc32(bytes.subarray(0, bytes.byteLength - 4)), false);
  return bytes;
}

function frame(eventType, payload) {
  const headers = concat([encodeHeader(":event-type", eventType)]);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headers.byteLength + payloadBytes.byteLength + 4;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.byteLength, false);
  bytes.set(headers, 12);
  bytes.set(payloadBytes, 12 + headers.byteLength);
  return checksum(bytes);
}

function response(frames) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const value of frames) controller.enqueue(value);
      controller.close();
    }
  }), { status: 200, statusText: "OK" });
}

function execute(overrides = {}) {
  return new KiroExecutor().execute({
    model: "kr/claude-opus-4.8",
    body: { conversationState: { currentMessage: { userInputMessage: { content: "base", modelId: "m" } } } },
    stream: true,
    credentials,
    ...overrides
  });
}

// Output is held behind the ": kiro-validation" heartbeat until clean EOF, so
// every assertion drains the whole response.
async function run(frames) {
  fetchMock.mockResolvedValueOnce(response(frames));
  return (await execute()).response.text();
}

// Repair retry off: a hard failure surfaces from the first attempt.
async function runNoRepair(frames) {
  fetchMock.mockResolvedValueOnce(response(frames));
  const result = await execute({
    credentials: { accessToken: "test-token", providerSpecificData: { kiroToolCallRepair: false } }
  });
  return result.response.text();
}

// The estimator runs only when metering and context usage both arrived and the
// upstream reported no token totals of its own -- the production shape.
const METERED = () => [
  frame("meteringEvent", { usage: 2, unit: "credit" }),
  frame("contextUsageEvent", { contextUsagePercentage: 10 })
];

function usageFrom(body) {
  const usages = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.includes('"usage"'))
    .map((line) => JSON.parse(line.slice(6)).usage)
    .filter(Boolean);
  return usages[usages.length - 1];
}

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("A: tool-call bytes count as output tokens", () => {
  it("does not report a tool-only turn as OUT 1", async () => {
    const body = await run([
      frame("toolUseEvent", {
        toolUseId: "call_a",
        name: "tool_call",
        input: { name: "mcp_search", arguments: { query: "why is the router reporting zero output" } }
      }),
      frame("metadataEvent", { stopReason: "tool_use" }),
      ...METERED()
    ]);

    const usage = usageFrom(body);
    expect(usage).toBeDefined();
    expect(usage.completion_tokens).toBeGreaterThan(10);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  });

  it("still counts plain text output", async () => {
    const body = await run([
      frame("assistantResponseEvent", { content: "x".repeat(400) }),
      frame("metadataEvent", { stopReason: "end_turn" }),
      ...METERED()
    ]);
    expect(usageFrom(body).completion_tokens).toBe(100);
  });
});

describe("C: one unusable tool fragment does not take the whole turn with it", () => {
  it("ships the valid call and drops only the invalid one", async () => {
    const body = await run([
      frame("toolUseEvent", {
        toolUseId: "good",
        name: "tool_call",
        input: { name: "mcp_search", arguments: { q: "router" } }
      }),
      frame("toolUseEvent", { toolUseId: "bad", name: "tool_call", input: { arguments: { q: "router" } } }),
      frame("metadataEvent", { stopReason: "tool_use" }),
      ...METERED()
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain('\\"name\\":\\"mcp_search\\"');
    expect(body).not.toContain('"id":"bad"');
    expect(body).toContain('"finish_reason":"tool_calls"');
  });

  it("keeps a complete call when a later fragment of another tool is rejected", async () => {
    const body = await run([
      frame("toolUseEvent", { toolUseId: "good", name: "read_file", input: { path: "a.txt" } }),
      // Name changes mid-tool: the frame-loop catch used to clear every buffered tool.
      frame("toolUseEvent", { toolUseId: "flaky", name: "read_file", input: "{\"path\":" }),
      frame("toolUseEvent", { toolUseId: "flaky", name: "write_file", input: "\"b.txt\"}" }),
      frame("metadataEvent", { stopReason: "tool_use" })
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain('"id":"good"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain("invalid_kiro_tool_call");
  });

  it("keeps streamed text when the only tool call is unusable", async () => {
    const body = await run([
      frame("assistantResponseEvent", { content: "Here is what I found." }),
      frame("toolUseEvent", { toolUseId: "bad", name: "tool_call", input: { arguments: {} } }),
      frame("metadataEvent", { stopReason: "tool_use" }),
      ...METERED()
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("Here is what I found.");
    expect(body).not.toContain("invalid_kiro_tool_call");
  });

  it("still hard-fails when nothing usable was produced at all", async () => {
    const body = await runNoRepair([
      frame("toolUseEvent", { toolUseId: "bad", name: "tool_call", input: { arguments: {} } }),
      frame("metadataEvent", { stopReason: "tool_use" })
    ]);
    expect(body).toContain("invalid_kiro_tool_call");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("B: truncation after output closes as length, not as a failure", () => {
  it.each(["model_context_window_exceeded", "max_tokens"])(
    "keeps the text and reports finish_reason length for %s",
    async (stopReason) => {
      const body = await run([
        frame("assistantResponseEvent", { content: "Partial but usable answer." }),
        frame("toolUseEvent", { toolUseId: "t1", name: "read_file", input: { path: "a.txt" } }),
        frame("metadataEvent", { stopReason }),
        ...METERED()
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body).toContain("Partial but usable answer.");
      expect(body).toContain('"finish_reason":"length"');
      expect(body).not.toContain("kiro_terminal_incomplete");
    }
  );

  it("reports stop_disposition length so the integrity gate keeps the bytes", async () => {
    let terminal;
    const transformed = new KiroExecutor().transformEventStreamToSSE(
      response([
        frame("assistantResponseEvent", { content: "Partial but usable answer." }),
        frame("metadataEvent", { stopReason: "model_context_window_exceeded" })
      ]),
      "kr/claude-opus-4.8",
      { onTerminalState: (value) => { terminal = value; } }
    );

    const body = await transformed.text();

    expect(body).toContain('"finish_reason":"length"');
    expect(terminal.stop_disposition).toBe("length");
  });

  it("still fails a truncation that produced nothing", async () => {
    const body = await run([
      frame("metadataEvent", { stopReason: "model_context_window_exceeded" })
    ]);
    expect(body).toContain("kiro_terminal_incomplete");
  });

  it("still fails a truncation whose only deltas were empty content", async () => {
    const body = await run([
      frame("assistantResponseEvent", { content: "" }),
      frame("metadataEvent", { stopReason: "model_context_window_exceeded" })
    ]);
    expect(body).toContain("kiro_terminal_incomplete");
    expect(body).not.toContain('"finish_reason":"length"');
  });

  it("still fails closed for cancelled after output", async () => {
    const body = await run([
      frame("assistantResponseEvent", { content: "private-cancelled" }),
      frame("metadataEvent", { stopReason: "cancelled" })
    ]);
    expect(body).toContain("kiro_terminal_incomplete");
    expect(body).not.toContain("private-cancelled");
  });
});
