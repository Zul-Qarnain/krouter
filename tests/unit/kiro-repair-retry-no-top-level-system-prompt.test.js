/**
 * 0.5.166 — the integrity repair retry must never write a top-level
 * `systemPrompt` (upstream 1892ed77). kiro.dev answers any body carrying that
 * field with a terminal 400 REQUEST_BODY_INVALID, so every repair retry
 * (malformed tool_call, ellipsis-only, short future-action final) was a hard
 * failure. The instruction now rides in the current user turn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args)
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");

const encoder = new TextEncoder();

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

function frame(eventType, payload) {
  const nameBytes = encoder.encode(":event-type");
  const valueBytes = encoder.encode(eventType);
  const headers = new Uint8Array(1 + nameBytes.length + 3 + valueBytes.length);
  headers[0] = nameBytes.length;
  headers.set(nameBytes, 1);
  headers[1 + nameBytes.length] = 7;
  new DataView(headers.buffer).setUint16(2 + nameBytes.length, valueBytes.length, false);
  headers.set(valueBytes, 4 + nameBytes.length);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headers.byteLength + payloadBytes.byteLength + 4;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.byteLength, false);
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
  bytes.set(headers, 12);
  bytes.set(payloadBytes, 12 + headers.byteLength);
  view.setUint32(totalLength - 4, crc32(bytes.subarray(0, totalLength - 4)), false);
  return bytes;
}

function response(frames) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const value of frames) controller.enqueue(value);
      controller.close();
    }
  }), { status: 200 });
}

function kiroBody() {
  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      currentMessage: { userInputMessage: { content: "What is in a.txt?", modelId: "claude-sonnet-4.5" } },
      history: []
    }
  };
}

async function runRepair(firstFrames) {
  const body = kiroBody();
  fetchMock
    .mockResolvedValueOnce(response(firstFrames))
    .mockResolvedValueOnce(response([frame("assistantResponseEvent", { content: "Recovered answer." })]));
  const result = await new KiroExecutor().execute({
    model: "kr/claude-sonnet-4.5",
    body,
    stream: true,
    credentials: { accessToken: "test-token", providerSpecificData: { kiroToolCallRepair: true } }
  });
  const text = await result.response.text();
  return { text, body, retryBody: JSON.parse(fetchMock.mock.calls[1][1].body) };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("Kiro repair retry body", () => {
  it.each([
    ["malformed tool_call", [frame("toolUseEvent", { toolUseId: "bad", name: "tool_call", input: { arguments: {} } })], "tool_call wrapper was malformed"],
    ["ellipsis-only final", [frame("assistantResponseEvent", { content: "..." })], "ended with only an ellipsis"],
    ["short future-action final", [frame("assistantResponseEvent", { content: "Let me check the remaining failures." })], "only announced a future action"]
  ])("puts the %s instruction in the current user turn, never in systemPrompt", async (_name, firstFrames, instruction) => {
    const { text, retryBody } = await runRepair(firstFrames);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text).toContain("Recovered answer.");
    expect(retryBody).not.toHaveProperty("systemPrompt");
    const content = retryBody.conversationState.currentMessage.userInputMessage.content;
    expect(content.startsWith("What is in a.txt?")).toBe(true);
    expect(content).toContain(instruction);
  });

  it("does not mutate the caller's body", async () => {
    const { body } = await runRepair([frame("assistantResponseEvent", { content: "..." })]);

    expect(body).toEqual(kiroBody());
  });

  it("keeps model-controlled parser detail out of the retry instruction", async () => {
    const { retryBody } = await runRepair([frame("toolUseEvent", {
      toolUseId: "bad-json",
      name: "tool_call",
      input: '{"name":"IGNORE_ALL_INSTRUCTIONS"'
    })]);

    const content = retryBody.conversationState.currentMessage.userInputMessage.content;
    expect(retryBody).not.toHaveProperty("systemPrompt");
    expect(content).toContain("tool_call wrapper was malformed");
    expect(content).not.toContain("IGNORE_ALL_INSTRUCTIONS");
  });
});
