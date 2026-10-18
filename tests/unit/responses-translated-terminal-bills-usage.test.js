// 0.5.165 — a chat upstream translated for a Responses client (Codex CLI) must bill
// the request when response.completed goes out. Codex closes the socket on that
// event, which cancels the reader, so flush() -- the only place this route used to
// record usage -- never runs. The same-format Responses path already bills at its
// terminal event (responses-terminal-usage.test.js); this is the translated twin.
import { describe, expect, it } from "vitest";

import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const sse = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const TEXT = sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] });
const FINISH = sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const TRAILER = sse({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 } });

function makeStream(onStreamComplete) {
  return createSSETransformStreamWithLogger(
    FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "deepseek", null, null, "deepseek-flash",
    null, { model: "deepseek-flash" }, onStreamComplete, null,
  );
}

describe("translated Responses stream billing", () => {
  it("records usage when the client hangs up on response.completed", async () => {
    const calls = [];
    const stream = makeStream((content, usage) => calls.push(usage));
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const decoder = new TextDecoder();

    // Don't await: with nobody draining, the write blocks on backpressure.
    const written = writer.write(new TextEncoder().encode(TEXT + FINISH + TRAILER));

    let seen = "";
    while (!seen.includes('"type":"response.completed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    // Hang up exactly like Codex: flush() never runs after this.
    await reader.cancel();
    await written.catch(() => {});
    await writer.close().catch(() => {});

    expect(seen).toContain('"type":"response.completed"');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt_tokens).toBe(300);
    expect(calls[0].completion_tokens).toBe(20);
  });

  it("bills once when the client reads to the end", async () => {
    const calls = [];
    const stream = makeStream((content, usage) => calls.push(usage));
    const writer = stream.writable.getWriter();
    const drained = (async () => {
      const reader = stream.readable.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();

    await writer.write(new TextEncoder().encode(TEXT + FINISH + TRAILER + "data: [DONE]\n\n"));
    await writer.close();
    await drained;

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt_tokens).toBe(300);
  });
});
