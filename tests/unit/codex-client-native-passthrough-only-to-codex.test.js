// 0.5.165 (kRouter-own, found by the 2026-10-16 blog fact-check) — NATIVE_PAIRS
// listed "openai" and "commandcode" as native to the Codex CLI (v0.5.16, #1907).
// Native passthrough skips translation, so a Codex request (a Responses API body:
// input[], instructions) routed to the openai provider was posted as-is to
// https://api.openai.com/v1/chat/completions, which needs messages[]; routed to
// CommandCode it reached /alpha/generate, which needs params.messages. Only the
// codex provider speaks the Codex wire format. Upstream's pairs never had either.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isNativePassthrough } from "../../open-sse/utils/clientDetector.js";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

const CODEX_HEADERS = { "user-agent": "codex_cli_rs/0.136.0 (Mac OS 15.0; arm64)", originator: "codex_cli_rs" };
const responsesBody = (model) => ({
  model,
  stream: true,
  instructions: "You are Codex.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "say ok" }] }],
});

describe("Codex native passthrough pairs", () => {
  it("is native only to the codex provider", () => {
    expect(isNativePassthrough("codex", "codex")).toBe(true);
    expect(isNativePassthrough("codex", "openai")).toBe(false);
    expect(isNativePassthrough("codex", "commandcode")).toBe(false);
  });
});

describe("a Codex request reaches non-Codex providers translated", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "krouter-codex-pairs-"));
  let handleChatCore;
  let proxyAwareFetch;

  beforeAll(async () => {
    process.env.DATA_DIR = dataDir;
    await import("../translator/registerAll.js");
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockImplementation(() => Promise.resolve(new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })));
  });

  const send = (provider, model) => handleChatCore({
    body: responsesBody(model),
    modelInfo: { provider, model },
    credentials: { apiKey: "k", connectionId: `conn-${provider}` },
    connectionId: `conn-${provider}`,
    sourceFormatOverride: "openai-responses",
    clientRawRequest: { endpoint: "/v1/responses", body: {}, headers: CODEX_HEADERS },
  });
  const upstream = () => ({ url: proxyAwareFetch.mock.calls[0][0], body: JSON.parse(proxyAwareFetch.mock.calls[0][1].body) });

  it("openai: a Chat Completions body to /v1/chat/completions", async () => {
    await send("openai", "gpt-4o");
    const { url, body } = upstream();
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.input).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain("say ok");
  });

  it("openai: the Codex client gets Responses events back", async () => {
    const chunk = { id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
    proxyAwareFetch.mockImplementation(() => Promise.resolve(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } })));
    const result = await send("openai", "gpt-4o");
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
  });

  it("commandcode: a CommandCode body with params.messages", async () => {
    await send("commandcode", "claude-sonnet-4-6");
    const { url, body } = upstream();
    expect(url).toContain("/alpha/generate");
    expect(Array.isArray(body.params?.messages)).toBe(true);
    expect(body.input).toBeUndefined();
  });
});
