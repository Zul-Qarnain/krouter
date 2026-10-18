// 0.5.165 — the v0.5.153 port of upstream e08ac6da stamped tools[].type = "custom"
// on every Claude-format request. MiniMax needs it (error 2013), but strict
// gateways behind anthropic-compatible-* (DeepSeek /anthropic first among them)
// only accept the typeless shape and answer 400 "unknown variant `custom`".
// Upstream 998bb3d9 scoped the default to the providers that require it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { CLAUDE_TOOL_TYPE_REQUIRED, shouldDefaultClaudeToolType } from "../../open-sse/translator/helpers/toolCallHelper.js";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

const tools = [{ name: "get_weather", description: "weather", input_schema: { type: "object" } }];

describe("shouldDefaultClaudeToolType", () => {
  it("runs only for MiniMax and MiniMax CN", () => {
    expect([...CLAUDE_TOOL_TYPE_REQUIRED].sort()).toEqual(["minimax", "minimax-cn"]);
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, tools)).toBe(true);
    expect(shouldDefaultClaudeToolType("minimax-cn", FORMATS.CLAUDE, tools)).toBe(true);
  });

  it("leaves Anthropic, anthropic-compatible gateways and DeepSeek typeless", () => {
    expect(shouldDefaultClaudeToolType("claude", FORMATS.CLAUDE, tools)).toBe(false);
    expect(shouldDefaultClaudeToolType("anthropic-compatible-deepseek", FORMATS.CLAUDE, tools)).toBe(false);
    expect(shouldDefaultClaudeToolType("deepseek", FORMATS.CLAUDE, tools)).toBe(false);
  });

  it("never applies outside Claude-format requests or without a tools array", () => {
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.OPENAI, tools)).toBe(false);
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, undefined)).toBe(false);
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, null)).toBe(false);
  });
});

describe("tool type on the wire (handleChatCore)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "krouter-tool-type-"));
  let handleChatCore;
  let proxyAwareFetch;
  const CLAUDE_JSON = JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m",
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

  beforeAll(async () => {
    process.env.DATA_DIR = dataDir;
    await import("../translator/registerAll.js");
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockImplementation(() => Promise.resolve(new Response(CLAUDE_JSON, { status: 200, headers: { "Content-Type": "application/json" } })));
  });

  const openaiTools = [{ type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } } }];
  const send = (provider, model, providerSpecificData = {}) => handleChatCore({
    body: { model: `${provider}/${model}`, stream: false, max_tokens: 32, tools: openaiTools, messages: [{ role: "user", content: "weather?" }] },
    modelInfo: { provider, model },
    credentials: { apiKey: "k", connectionId: `conn-${provider}`, providerSpecificData },
    connectionId: `conn-${provider}`,
  });
  const sentTools = () => JSON.parse(proxyAwareFetch.mock.calls[0][1].body).tools;

  it("an anthropic-compatible gateway (DeepSeek /anthropic) gets typeless tools", async () => {
    await send("anthropic-compatible-ds", "deepseek-v4-pro", { baseUrl: "https://api.deepseek.com/anthropic/v1" });
    const out = sentTools();
    expect(out[0].name).toBe("get_weather");
    expect(out[0].type).toBeUndefined();
  });

  it("MiniMax still gets type custom", async () => {
    await send("minimax", "MiniMax-M2.5");
    expect(sentTools()[0].type).toBe("custom");
  });
});
