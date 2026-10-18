// 0.5.165 (kRouter-own) — Gemini CLI's 429 names the wait in
// error.details[RetryInfo].retryDelay ("34.07s"). parseError copied it to
// `retryAfter` only, a field nothing downstream reads, so the account lock
// ignored it and fell back to generic backoff. It now also sets resetsAtMs,
// which parseUpstreamError hands to markAccountUnavailable (capped at 6h there).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GeminiCLIExecutor } from "../../open-sse/executors/gemini-cli.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const body = (retryDelay) => JSON.stringify({
  error: {
    code: 429,
    message: "You have exhausted your capacity on this model.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
    ],
  },
});
const res429 = (text) => new Response(text, { status: 429, headers: { "Content-Type": "application/json" } });

describe("GeminiCLIExecutor.parseError retryDelay", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  const exec = new GeminiCLIExecutor();

  it("turns a seconds string into resetsAtMs", () => {
    const out = exec.parseError(res429(""), body("34.074824224s"));
    expect(out.resetsAtMs).toBe(NOW + 34_075);
    expect(out.retryAfter).toBe("34.074824224s");
  });

  it("accepts the proto {seconds, nanos} form", () => {
    const out = exec.parseError(res429(""), body({ seconds: 7200, nanos: 500_000_000 }));
    expect(out.resetsAtMs).toBe(NOW + 7_200_500);
  });

  it("leaves resetsAtMs unset for a missing or junk delay", () => {
    expect(exec.parseError(res429(""), body("soon")).resetsAtMs).toBeUndefined();
    expect(exec.parseError(res429(""), JSON.stringify({ error: { code: 429 } })).resetsAtMs).toBeUndefined();
    expect(exec.parseError(res429(""), "not json").resetsAtMs).toBeUndefined();
  });

  it("reaches the lock path through parseUpstreamError", async () => {
    const out = await parseUpstreamError(res429(body("3600s")), exec);
    expect(out.statusCode).toBe(429);
    expect(out.resetsAtMs).toBe(NOW + 3_600_000);
  });
});
