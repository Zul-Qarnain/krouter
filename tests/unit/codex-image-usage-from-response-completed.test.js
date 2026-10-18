// 0.5.165 — Codex image requests cost real tokens and kRouter recorded none of
// them (upstream e10da160). The Responses stream ends with a response.completed
// frame carrying the exact usage; parseStream threw it away because it only
// looked for the image bytes, so an hour of image generation showed up as zero
// spend on the usage page.
//
// The adapter now reports that usage through an onUsage callback on both paths
// (streamed to the client and collected), and imageGenerationCore threads the
// callback down to it.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const USAGE_FRAME = {
  response: {
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      total_tokens: 1540,
      input_tokens_details: { cached_tokens: 1024 },
      output_tokens_details: { reasoning_tokens: 64 },
    },
  },
};

function codexSse(extraFrames = [USAGE_FRAME]) {
  const frames = [
    "event: response.output_item.done",
    'data: {"item":{"type":"image_generation_call","result":"base64codeximage"}}',
    "",
  ];
  for (const frame of extraFrames) {
    frames.push("event: response.completed", `data: ${JSON.stringify(frame)}`, "");
  }
  frames.push("");
  return new Response(frames.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const credentials = { accessToken: "codex-token", providerSpecificData: { chatgptAccountId: "acct-1" } };

describe("Codex image usage from response.completed", () => {
  it("reports normalized usage on the collected path", async () => {
    const onUsage = vi.fn();
    const result = await codexImageAdapter.parseResponse(codexSse(), { log: null, onUsage });

    expect(result.data[0].b64_json).toBe("base64codeximage");
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      prompt_tokens: 1200,
      completion_tokens: 340,
      total_tokens: 1540,
      cached_tokens: 1024,
      reasoning_tokens: 64,
    });
  });

  it("reports usage before the done frame on the streamed path", async () => {
    const calls = [];
    const onUsage = vi.fn(() => calls.push("usage"));
    const onRequestSuccess = vi.fn(() => calls.push("success"));

    const { sseResponse } = await codexImageAdapter.parseResponse(codexSse(), {
      log: null, streamToClient: true, onUsage, onRequestSuccess,
    });
    const text = await sseResponse.text();

    expect(text).toContain("event: done");
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["usage", "success"]);
  });

  it("stays quiet when the stream reports no usage", async () => {
    const onUsage = vi.fn();
    await codexImageAdapter.parseResponse(codexSse([]), { log: null, onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("ignores a frame whose token counts are not whole non-negative numbers", async () => {
    const onUsage = vi.fn();
    await codexImageAdapter.parseResponse(
      codexSse([{ response: { usage: { input_tokens: -1, output_tokens: "many" } } }]),
      { log: null, onUsage },
    );
    expect(onUsage).not.toHaveBeenCalled();
  });

  describe("threaded through imageGenerationCore", () => {
    const originalFetch = global.fetch;
    beforeEach(() => { global.fetch = vi.fn(); });
    afterEach(() => { global.fetch = originalFetch; });

    it("hands the adapter the caller's onUsage callback", async () => {
      global.fetch.mockResolvedValueOnce(codexSse());
      const onUsage = vi.fn();

      const result = await handleImageGenerationCore({
        body: { prompt: "a green square" },
        modelInfo: { provider: "codex", model: "gpt-image-2.5" },
        credentials,
        log: null,
        onUsage,
      });

      expect(result.success).toBe(true);
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ prompt_tokens: 1200, completion_tokens: 340 }));
    });
  });
});
