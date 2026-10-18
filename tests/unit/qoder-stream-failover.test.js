/**
 * Qoder wraps every reply in `{statusCodeValue, body}` SSE envelopes, so an
 * error arrives inside an HTTP 200 stream. wrapQoderSSE turned those into
 * assistant text with finish_reason "stop", which means a billing block, a
 * duplicate-request 403 or a 503 all counted as a successful completion:
 * chatCore never locked the connection and combo/account failover never fired.
 *
 * Peek the first data line instead and surface it as a real HTTP status
 * (upstream 80afb599 + 2daf25ff + 782c137b).
 */
import { describe, it, expect, vi } from "vitest";
import { __test__ } from "../../open-sse/executors/qoder.js";
import { parseSSEToOpenAIResponse, streamErrorStatus } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const { wrapQoderSSE, isBillingBlock } = __test__;

const frame = (statusCodeValue, body) => `data: ${JSON.stringify({ statusCodeValue, body })}\n\n`;
const duplicate = '{"code":"103","message":"Duplicate request"}';

function upstream(chunks, { keepOpen = false } = {}) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!keepOpen) controller.close();
    },
    cancel,
  }));
  return { response, cancel };
}

async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf + decoder.decode();
}

describe("isBillingBlock", () => {
  it.each([
    ['{"code":"110","message":"Billing daily count exceeded"}', "code 110 string"],
    ['{"code":110,"message":"Billing daily count exceeded"}', "code 110 numeric"],
    ['{"code":"112","message":"quota exhausted"}', "code 112"],
    ['{"code":"10605","message":"queued"}', "code 10605"],
    ['{"message":"upgrade","pricingUrl":"https://qoder.com/pricing"}', "pricingUrl"],
  ])("flags %s (%s)", (inner) => {
    expect(isBillingBlock(inner)).toBe(true);
  });

  it.each([
    ['{"code":"103","message":"Duplicate request"}', "duplicate request"],
    ["Internal server error", "plain text"],
    ['{"code":"1100","message":"unrelated"}', "code 1100 is not 110"],
    ["", "empty"],
  ])("does not flag %s (%s)", (inner) => {
    expect(isBillingBlock(inner)).toBe(false);
  });
});

describe("Qoder first-frame billing blocks", () => {
  it.each([
    ["code 110 as a string", 403, '{"code":"110","message":"Billing daily count exceeded"}'],
    ["code 110 as a number", 403, '{"code":110,"message":"Billing daily count exceeded"}'],
    ["code 112", 429, '{"code":"112","message":"Billing daily count exceeded"}'],
    ["code 10605", 429, '{"code":"10605","message":"Billing daily count exceeded"}'],
  ])("returns HTTP 403 for %s", async (_name, statusCodeValue, body) => {
    const { response } = upstream([frame(statusCodeValue, body)]);
    const wrapped = await wrapQoderSSE(response, "qoder/qmodel_latest");
    expect(wrapped.status).toBe(403);
    expect(wrapped.ok).toBe(false);
    expect((await wrapped.json()).error.message).toContain("Billing daily count exceeded");
  });

  it("returns HTTP 403 when statusCodeValue arrives as the string \"403\"", async () => {
    const env = JSON.stringify({ statusCodeValue: "403", body: '{"code":"110","message":"Billing daily count exceeded"}' });
    const wrapped = await wrapQoderSSE(upstream([`data: ${env}\n\n`]).response, "qoder/qmodel_latest");
    expect(wrapped.status).toBe(403);
  });

  it("returns HTTP 403 for a pricingUrl envelope", async () => {
    const { response } = upstream([frame(402, '{"message":"upgrade","pricingUrl":"https://qoder.com/pricing"}')]);
    const wrapped = await wrapQoderSSE(response, "qoder/auto");
    expect(wrapped.status).toBe(403);
  });

  it("returns HTTP 403 for an object body billing envelope", async () => {
    const { response } = upstream([frame(403, { code: "110", message: "Billing daily count exceeded" })]);
    const wrapped = await wrapQoderSSE(response, "qoder/auto");
    expect(wrapped.status).toBe(403);
    expect((await wrapped.json()).error.message).toContain("Billing daily count exceeded");
  });
});

describe("Qoder first-frame transport errors", () => {
  it.each([
    ["a single chunk", [frame(403, duplicate)]],
    ["a fragmented frame", [frame(403, duplicate).slice(0, 35), frame(403, duplicate).slice(35)]],
    ["a heartbeat prefix", [": keepalive\r\n\r\n", frame(403, duplicate)]],
    ["prefix and frame in one chunk", [`: keepalive\n\nevent: message\n${frame(403, duplicate)}`]],
    ["EOF without a trailing newline", [frame(403, duplicate).trimEnd()]],
    ["an object body", [frame(403, JSON.parse(duplicate))]],
  ])("surfaces a duplicate-request 403 as an HTTP failure: %s", async (_name, chunks) => {
    const wrapped = await wrapQoderSSE(upstream(chunks).response, "qoder/kmodel");
    expect(wrapped.status).toBe(403);
    expect(wrapped.ok).toBe(false);
    expect(wrapped.headers.get("content-type")).toBe("application/json");
    const body = await wrapped.json();
    expect(body.error.message).toBe(duplicate);
    expect(body).not.toHaveProperty("choices");
  });

  it.each([401, 429, 500, 503])("preserves non-billing upstream status %s", async (status) => {
    const wrapped = await wrapQoderSSE(upstream([frame(status, "upstream failure")]).response, "qoder/auto");
    expect(wrapped.status).toBe(status);
    expect(await wrapped.json()).toEqual({ error: { message: "upstream failure", code: status } });
  });

  it.each([0, 302, 600, 403.5])("maps the unusable error status %s to 502", async (status) => {
    const wrapped = await wrapQoderSSE(upstream([frame(status, "invalid upstream status")]).response, "qoder/auto");
    expect(wrapped.status).toBe(502);
  });

  it("cancels the upstream keepalive socket after a first-frame error", async () => {
    const { response, cancel } = upstream([": keepalive\n\n", frame(403, duplicate)], { keepOpen: true });
    const wrapped = await wrapQoderSSE(response, "qoder/auto");
    expect(wrapped.status).toBe(403);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Qoder success frames survive the peek", () => {
  it("replays peeked bytes without losing or duplicating content", async () => {
    const first = JSON.stringify({ choices: [{ delta: { content: "hello" } }] });
    const second = JSON.stringify({ choices: [{ delta: { content: "world" } }] });
    const { response } = upstream([": keepalive\n\n", frame(200, first) + frame(200, second) + "data: [DONE]\n\n"]);
    const wrapped = await wrapQoderSSE(response, "qoder/auto");
    expect(wrapped.status).toBe(200);
    expect(await drain(wrapped)).toBe(`data: ${first}\n\ndata: ${second}\n\ndata: [DONE]\n\n`);
  });

  it("replays a multi-byte character split across the peek boundary", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "héllo" } }] });
    const bytes = new TextEncoder().encode(frame(200, inner) + "data: [DONE]\n\n");
    // Cut inside the two-byte "é" so the peek's decoder holds a partial char.
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const wrapped = await wrapQoderSSE(new Response(stream), "qoder/auto");
    expect(await drain(wrapped)).toBe(`data: ${inner}\n\ndata: [DONE]\n\n`);
  });

  it("starts forwarding success before the upstream closes", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "hello" } }] });
    const { response } = upstream([": keepalive\n\n", frame(200, inner)], { keepOpen: true });
    const wrapped = await wrapQoderSSE(response, "qoder/auto");
    const reader = wrapped.body.getReader();
    try {
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(`data: ${inner}\n\n`);
    } finally {
      await reader.cancel();
    }
  });

  it("does not treat assistant text that mentions code 110 as a billing block", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: '{"code":"110"} means billing daily count exceeded' } }] });
    const wrapped = await wrapQoderSSE(upstream([frame(200, inner)]).response, "qoder/auto");
    expect(wrapped.status).toBe(200);
    const out = await drain(wrapped);
    expect(out).toContain("billing daily count exceeded");
    expect(out).not.toContain("[qoder error");
  });
});

describe("Qoder mid-stream billing blocks", () => {
  it("emits a structured 403 error chunk instead of assistant text", async () => {
    const okEnv = frame(200, JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    const { response } = upstream([okEnv + frame(403, '{"code":"110","message":"Billing daily count exceeded"}')]);
    const wrapped = await wrapQoderSSE(response, "qoder/auto");
    expect(wrapped.status).toBe(200);

    const out = await drain(wrapped);
    expect(out).not.toContain("[qoder error");
    const errLine = out.split("\n").find((l) => l.includes('"error"'));
    expect(errLine).toBeDefined();
    const chunk = JSON.parse(errLine.slice("data: ".length));
    expect(chunk.error.status).toBe(403);
    expect(chunk.error.type).toBe("quota_error");
    expect(chunk.error.message).toContain("Billing daily count exceeded");
    expect(chunk.choices).toBeUndefined();
    expect(out).toContain("data: [DONE]\n\n");
  });

  it("emits a structured 403 error chunk for an object body billing envelope", async () => {
    const okEnv = frame(200, JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    const { response } = upstream([okEnv + frame(403, { code: "110", message: "Billing daily count exceeded" })]);
    const out = await drain(await wrapQoderSSE(response, "qoder/auto"));
    const errLine = out.split("\n").find((l) => l.includes('"error"'));
    expect(JSON.parse(errLine.slice("data: ".length)).error.status).toBe(403);
  });

  it("reaches a non-streaming caller as a 403, not as a finished completion", async () => {
    const okEnv = frame(200, JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    const { response } = upstream([okEnv + frame(403, '{"code":"110","message":"Billing daily count exceeded"}')]);
    const sse = await drain(await wrapQoderSSE(response, "qoder/auto"));

    const parsed = parseSSEToOpenAIResponse(sse, "qoder/auto");
    expect(parsed.error).toBeDefined();
    expect(parsed.choices).toBeUndefined();
    expect(streamErrorStatus(parsed.error)).toBe(403);
  });

  it("keeps the legacy text chunk for a mid-stream non-billing error", async () => {
    const okEnv = frame(200, JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    const { response } = upstream([okEnv + frame(500, "boom")]);
    const out = await drain(await wrapQoderSSE(response, "qoder/auto"));
    expect(out).toContain("[qoder error 500");
    expect(out).toContain("data: [DONE]\n\n");
  });
});
