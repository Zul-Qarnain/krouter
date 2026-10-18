// 0.5.165 (kRouter-own) — when every account of a member is parked, the
// single-model handler answers via unavailableResponse(), which puts the wait
// ONLY in the Retry-After header (seconds). handleComboChat read retryAfter from
// the JSON body alone, so a combo whose members were all parked lost the wait
// and the client got no Retry-After. Read the header too.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { unavailableResponse } from "../../open-sse/utils/error.js";

const quietLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

describe("handleComboChat Retry-After", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("carries the earliest header Retry-After of parked members to the client", async () => {
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel: async (_b, m) => (m === "p/a"
        ? unavailableResponse(429, "[p/a] rate limited", iso(NOW + 120_000), "reset after 2m")
        : unavailableResponse(429, "[p/b] rate limited", iso(NOW + 45_000), "reset after 45s")),
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  it("accepts an HTTP-date Retry-After", async () => {
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel: async () => new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(NOW + 30_000).toUTCString() },
      }),
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("still prefers a body retryAfter when one is present", async () => {
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel: async () => new Response(JSON.stringify({ error: { message: "slow down" }, retryAfter: iso(NOW + 10_000) }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "300" },
      }),
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("ignores a junk Retry-After header", async () => {
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel: async () => new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "soon" },
      }),
      log: quietLog,
      autoSwitch: false,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
