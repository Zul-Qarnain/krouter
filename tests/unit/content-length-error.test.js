import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// 0.5.94 — Regression tests for input-size errors that should NOT fan out
// through every account. Reported: Kiro returning 400 with
//   {"message":"Input content length exceeds threshold.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}
// was burning all 5 accounts.
describe("input-size errors (do not fan out)", () => {
  it("Kiro reason code — CONTENT_LENGTH_EXCEEDS_THRESHOLD", () => {
    const r = checkFallbackError(
      400,
      '{"message":"Input content length exceeds threshold.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}',
    );
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("Kiro human message — Input content length exceeds threshold", () => {
    const r = checkFallbackError(400, "Input content length exceeds threshold.");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("OpenAI-shape — context length exceeded", () => {
    const r = checkFallbackError(400, "This model's maximum context length is 200000 tokens.");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("Anthropic-shape — prompt is too long", () => {
    const r = checkFallbackError(400, "prompt is too long: 250000 tokens > 200000 maximum");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("HTTP 413 — payload too large", () => {
    const r = checkFallbackError(413, "Request too large: payload too large for endpoint");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("case-insensitive match on the reason blob", () => {
    const r = checkFallbackError(400, '{"reason":"content_length_exceeds_threshold"}');
    expect(r.shouldFallback).toBe(false);
  });

  it("unrelated 400 is request-scoped: no account lock, no failover (0.5.165)", () => {
    const r = checkFallbackError(400, '{"error":"something else"}');
    // Matches no text rule. 0.5.165 (upstream 20a43f5a): an unmatched 4xx is about
    // the request, so it no longer takes the 30s transient default. A combo still
    // advances to its next member on requestScoped.
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(r.requestScoped).toBe(true);
  });
});
