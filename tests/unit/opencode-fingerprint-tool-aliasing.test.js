// 0.5.166 (upstream 5bdcd5e7, e964e482) — OpenCode Free only answers a request that
// declares tools literally named `read` and `shell` (live probe 2026-10-18: renaming
// them to read_file is a 403). A caller that already has its own `read` with a
// different schema would collide, so that one travels under an alias and the response
// side puts the caller's own name back. Without the restore the client gets a tool
// call for a tool it never declared and rejects the turn.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  restoreToolNames,
  takeRenamedToolNames,
} from "../../open-sse/utils/opencodeFingerprint.js";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

const dataDir = mkdtempSync(join(tmpdir(), "krouter-oc-fingerprint-"));
let handleChatCore;
let proxyAwareFetch;

const callerRead = (name = "read") => ({
  type: "function",
  function: { name, description: "Read a file the caller owns", parameters: { type: "object", properties: { file: { type: "string" } } } },
});

describe("conflicting caller tools travel under an alias", () => {
  it("renames a caller `read` whose definition differs from OpenCode's", () => {
    const { tools, map } = concealFingerprintToolNames([callerRead()], "chat");
    expect(tools[0].function.name).toBe("read_client");
    expect(map.get("read_client")).toBe("read");
  });

  it("leaves a caller tool that already carries OpenCode's exact definition alone", () => {
    const body = {};
    applyFingerprintTools(body, "chat");
    const exact = body.tools.find((t) => t.function.name === "read");
    const { tools, map } = concealFingerprintToolNames([exact], "chat");
    expect(tools[0]).toBe(exact);
    expect(map.size).toBe(0);
  });

  it("leaves case variants such as Read verbatim", () => {
    const { tools, map } = concealFingerprintToolNames([callerRead("Read")], "chat");
    expect(tools[0].function.name).toBe("Read");
    expect(map.size).toBe(0);
  });

  it("picks a free alias when read_client is taken", () => {
    const { map } = concealFingerprintToolNames([callerRead(), callerRead("read_client")], "chat");
    expect([...map.keys()]).toEqual(["read_client2"]);
  });

  it("drops a duplicate declaration of one fingerprint name", () => {
    const { tools } = concealFingerprintToolNames([callerRead(), callerRead()], "chat");
    expect(tools).toHaveLength(1);
  });

  it("retargets an explicit tool_choice and prior-turn calls at the alias", () => {
    const body = {
      tools: [callerRead()],
      tool_choice: { type: "function", function: { name: "read" } },
      messages: [{ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }],
    };
    const map = applyFingerprintTools(body, "chat");
    expect(body.tool_choice.function.name).toBe("read_client");
    expect(body.messages.at(-1).tool_calls[0].function.name).toBe("read_client");
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("renames a Claude tool_use block in history too", () => {
    const body = {
      tools: [{ name: "read", description: "caller read", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] }],
    };
    applyFingerprintTools(body, "claude");
    expect(body.messages.at(-1).content[0].name).toBe("read_client");
  });
});

describe("the fingerprint shape follows the endpoint", () => {
  it("uses chat function wrappers for /chat/completions", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(body, "chat");
    expect(body.tools.map((t) => t.function.name)).toEqual(["read", "shell"]);
    expect(body.tool_choice).toBeUndefined();
  });

  it("uses flat names plus tool_choice auto for /responses", () => {
    const body = { input: [] };
    applyFingerprintTools(body, "responses");
    expect(body.tools.map((t) => t.name)).toEqual(["read", "shell"]);
    expect(body.tools[0].parameters.type).toBe("object");
    expect(body.tool_choice).toBe("auto");
  });

  it("uses input_schema and the system field for /messages", () => {
    const body = { messages: [{ role: "user", content: "hi" }], system: "be brief" };
    applyFingerprintTools(body, "claude");
    expect(body.tools.map((t) => t.name)).toEqual(["read", "shell"]);
    expect(body.tools[0].input_schema.required).toEqual(["path"]);
    expect(body.tools[0].parameters).toBeUndefined();
    expect(body.system).toContain("placeholders that do nothing");
    expect(body.messages[0].role).toBe("user");
  });
});

describe("restoreToolNames puts the caller's own name back", () => {
  const map = new Map([["read_client", "read"], ["shell_client", "shell"]]);

  it("restores an OpenAI streaming delta", () => {
    const chunk = { choices: [{ delta: { tool_calls: [{ function: { name: "read_client" } }] } }] };
    expect(restoreToolNames(chunk, map).choices[0].delta.tool_calls[0].function.name).toBe("read");
  });

  it("restores an OpenAI non-streaming message", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "shell_client" } }] } }] };
    expect(restoreToolNames(body, map).choices[0].message.tool_calls[0].function.name).toBe("shell");
  });

  it("restores a Responses output item and a Responses SSE event", () => {
    expect(restoreToolNames({ output: [{ type: "function_call", name: "read_client" }] }, map).output[0].name).toBe("read");
    expect(restoreToolNames({ type: "response.output_item.done", item: { type: "function_call", name: "read_client" } }, map).item.name).toBe("read");
  });

  it("restores a Claude content_block_start and a Claude message body", () => {
    expect(restoreToolNames({ type: "content_block_start", content_block: { type: "tool_use", name: "read_client" } }, map).content_block.name).toBe("read");
    expect(restoreToolNames({ content: [{ type: "tool_use", name: "shell_client" }] }, map).content[0].name).toBe("shell");
  });

  it("walks an array of chunks", () => {
    const out = restoreToolNames([{ output: [{ type: "function_call", name: "read_client" }] }], map);
    expect(out[0].output[0].name).toBe("read");
  });

  it("returns the payload untouched with no map and leaves unmapped names alone", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("a client that declares its own `read` gets its own name back end to end", () => {
  beforeAll(async () => {
    process.env.DATA_DIR = dataDir;
    await import("../translator/registerAll.js");
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  beforeEach(() => proxyAwareFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  // What the upstream answers once the caller's `read` has been aliased away.
  const aliasedCall = (payload) => `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
  const sse = aliasedCall({
    id: "gen-1", object: "chat.completion.chunk", model: "mimo-v2.6-flash-free",
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_client", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
  });

  const send = (stream, accept) => handleChatCore({
    body: { model: "oc/mimo-v2.6-flash-free", stream, tools: [callerRead()], messages: [{ role: "user", content: "read a file" }] },
    modelInfo: { provider: "opencode", model: "mimo-v2.6-flash-free" },
    credentials: {},
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: accept ? { accept } : {} },
  });

  it("sends `read` upstream under an alias and streams `read` back to the client", async () => {
    proxyAwareFetch.mockResolvedValue(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const result = await send(true);
    const sent = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(sent.tools.map((t) => t.function.name)).toEqual(["read_client", "read", "shell"]);
    expect(sent.stream).toBe(true);
    const text = await result.response.text();
    expect(text).toContain('"name":"read"');
    expect(text).not.toContain("read_client");
  });

  it("restores the name on the JSON path a non-streaming client gets", async () => {
    proxyAwareFetch.mockResolvedValue(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const result = await send(false, "application/json");
    const json = await result.response.json();
    const names = (json.choices || []).flatMap((c) => (c.message?.tool_calls || []).map((t) => t.function.name));
    expect(names).toEqual(["read"]);
  });
});
