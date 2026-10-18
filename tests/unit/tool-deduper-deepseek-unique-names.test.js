// 0.5.165 — DeepSeek answers 400 "Tool names must be unique" on every endpoint
// that serves it (api.deepseek.com, OpenCode Go, LiteLLM gateways). dedupeTools
// now also drops later same-name tools for any deepseek-* model, first wins
// (upstream 7f5bd155, tests ported from its tool-deduper.test.js; the live
// *.real.test.js files are not ported). kRouter adaptation: catalog ids such as
// "deepseek/deepseek-v4-pro" and "cline-pass/deepseek-v4-pro" match on their last
// path segment.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dedupeTools } from "../../open-sse/utils/toolDeduper.js";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

const BASH = (name = "Bash", desc = "Run a shell command") => ({
  name,
  description: desc,
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
});

const FUNC_SHAPE = (name = "Bash", desc = "Run a shell command") => ({
  type: "function",
  function: { name, description: desc, parameters: { type: "object", properties: { command: { type: "string" } } } },
});

const MCP_EXA = { name: "mcp__exa__web_search_exa", description: "search" };

describe("toolDeduper - MCP-equivalent built-in rules (existing behaviour)", () => {
  it("claude client + Exa MCP drops built-in WebSearch/WebFetch", () => {
    const { tools, stripped } = dedupeTools(
      [MCP_EXA, { name: "WebSearch", description: "web" }, { name: "WebFetch", description: "web" }, BASH()],
      { clientTool: "claude" }
    );
    expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "Bash"]);
    expect(stripped.sort()).toEqual(["WebFetch", "WebSearch"]);
  });

  it("non-claude client: the MCP rules do not run", () => {
    const { tools, stripped } = dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }], { clientTool: "codex" });
    expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "WebSearch"]);
    expect(stripped).toEqual([]);
  });

  it("no opts: the MCP rules stay dormant", () => {
    const { tools, stripped } = dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }]);
    expect(tools).toHaveLength(2);
    expect(stripped).toEqual([]);
  });
});

describe("toolDeduper - DeepSeek same-name dedup", () => {
  it("deepseek model + duplicate names keeps the first definition", () => {
    const first = BASH();
    const { tools, stripped } = dedupeTools([first, BASH("Bash", "duplicate description")], { model: "deepseek-v4-flash" });
    expect(tools).toEqual([first]);
    expect(stripped).toEqual(["Bash"]);
  });

  it("a (level) thinking suffix is stripped before matching", () => {
    const { tools } = dedupeTools([BASH(), BASH("Bash", "dup")], { model: "deepseek-v4-flash(max)" });
    expect(tools).toHaveLength(1);
  });

  it("three same-name tools keep only the first", () => {
    const { tools, stripped } = dedupeTools([BASH(), BASH("Bash", "d1"), BASH("Bash", "d2")], { model: "deepseek-v4-pro" });
    expect(tools).toHaveLength(1);
    expect(stripped).toEqual(["Bash", "Bash"]);
  });

  it("OpenAI function-shape tools dedupe by function.name", () => {
    const { tools } = dedupeTools([FUNC_SHAPE("Bash"), FUNC_SHAPE("Bash", "dup")], { model: "deepseek-v4-flash" });
    expect(tools).toHaveLength(1);
    expect(tools[0].function.description).toBe("Run a shell command");
  });

  it.each(["deepseek/deepseek-v4-pro", "cline-pass/deepseek-v4-pro", "deepseek-ai/deepseek-v3.1", "deepseek-chat", "deepseek-reasoner"])(
    "path-qualified or official id %s still dedups", (model) => {
      expect(dedupeTools([BASH(), BASH("Bash", "dup")], { model }).tools).toHaveLength(1);
    });

  it("non-DeepSeek model: duplicates untouched (GLM/MiniMax/Kimi accept them)", () => {
    const tools = [BASH(), BASH("Bash", "dup")];
    const { tools: out, stripped } = dedupeTools(tools, { model: "glm-5.2" });
    expect(out).toBe(tools);
    expect(stripped).toEqual([]);
  });

  it("no model: same-name dedup does not run", () => {
    const tools = [BASH(), BASH("Bash", "dup")];
    expect(dedupeTools(tools, {}).tools).toBe(tools);
  });

  it("distinct names: nothing stripped", () => {
    const { tools, stripped } = dedupeTools([BASH("Bash"), BASH("ReadFile")], { model: "deepseek-v4-flash" });
    expect(tools).toHaveLength(2);
    expect(stripped).toEqual([]);
  });

  it("claude client + deepseek + MCP trigger: both rules apply", () => {
    const { tools, stripped } = dedupeTools(
      [MCP_EXA, { name: "WebSearch", description: "web" }, BASH(), BASH("Bash", "dup")],
      { clientTool: "claude", model: "deepseek-v4-flash" }
    );
    expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "Bash"]);
    expect(stripped.sort()).toEqual(["Bash", "WebSearch"]);
  });

  it("never mutates the caller's tools array", () => {
    const tools = [BASH(), BASH("Bash", "dup")];
    dedupeTools(tools, { model: "deepseek-v4-pro" });
    expect(tools).toHaveLength(2);
  });
});

describe("handleChatCore sends DeepSeek unique tool names", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "krouter-deepseek-dedupe-"));
  let handleChatCore;
  let proxyAwareFetch;
  const CHAT_JSON = JSON.stringify({ id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });

  beforeAll(async () => {
    process.env.DATA_DIR = dataDir;
    await import("../translator/registerAll.js");
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockImplementation(() => Promise.resolve(new Response(CHAT_JSON, { status: 200, headers: { "Content-Type": "application/json" } })));
  });

  const send = (provider, model) => handleChatCore({
    body: { model: `${provider}/${model}`, stream: false, tools: [FUNC_SHAPE("Bash"), FUNC_SHAPE("Bash", "dup")], messages: [{ role: "user", content: "run ls" }] },
    modelInfo: { provider, model },
    credentials: { apiKey: "k", connectionId: `conn-${provider}` },
    connectionId: `conn-${provider}`,
  });
  const sentToolNames = () => JSON.parse(proxyAwareFetch.mock.calls[0][1].body).tools.map((t) => t.function.name);

  it("an OpenAI client's duplicate tool reaches DeepSeek once", async () => {
    await send("deepseek", "deepseek-v4-pro");
    expect(sentToolNames()).toEqual(["Bash"]);
  });

  it("a non-DeepSeek model keeps what the client sent", async () => {
    await send("openrouter", "z-ai/glm-5.2");
    expect(sentToolNames()).toEqual(["Bash", "Bash"]);
  });
});
