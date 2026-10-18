/**
 * The HuggingFace ASR route rejects a model id that would rewrite the URL.
 *
 * `/v1/audio/transcriptions` takes the model id straight from the client:
 * `parseModel` (open-sse/services/model.js:192-198) splits on the first slash
 * and hands the remainder through with no catalog check, so the id reaches
 * `transcribeHuggingFace`, which interpolates it into a URL path. The existing
 * guard only rejects `..` and `//`, so `whisper-large-v3?x=1` still turns the
 * path into a query string and `#frag` truncates it.
 *
 * kRouter-own hardening, matching the guard upstream cf663f53 wrote for the
 * HuggingFace image path (`model.includes("..") || model.includes("//") ||
 * /[?#]/.test(model)`) and described there as mirroring sttCore's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";

const originalFetch = global.fetch;

function formDataWithFile() {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "audio.wav", { type: "audio/wav" }));
  return fd;
}

async function transcribe(model) {
  return handleSttCore({
    provider: "huggingface",
    model,
    formData: formDataWithFile(),
    credentials: { apiKey: "hf_test_token" },
  });
}

describe("HuggingFace STT model-id guard", () => {
  beforeEach(() => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("accepts a normal Hub model id", async () => {
    const result = await transcribe("openai/whisper-large-v3");

    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("openai/whisper-large-v3");
  });

  it("rejects a model id that injects a query string", async () => {
    const result = await transcribe("openai/whisper-large-v3?x=1");

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/invalid model id/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a model id that injects a fragment", async () => {
    const result = await transcribe("openai/whisper-large-v3#frag");

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still rejects traversal and double slashes", async () => {
    for (const model of ["../../admin", "org//model"]) {
      global.fetch.mockClear();
      const result = await transcribe(model);

      expect(result.success, model).toBe(false);
      expect(result.status, model).toBe(400);
      expect(global.fetch, model).not.toHaveBeenCalled();
    }
  });
});
