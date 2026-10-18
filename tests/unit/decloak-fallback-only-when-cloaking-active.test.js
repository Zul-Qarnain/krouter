/**
 * 0.5.165 — the last-resort decloak (strip a trailing CLAUDE_TOOL_SUFFIX when the
 * tool name is not in the map, upstream b65d2d0a) must only fire when kRouter
 * actually cloaked this request.
 *
 * kRouter cloaks only for provider "claude" with an OAuth token (sk-ant-oat):
 * translator/index.js. Without that gate, a client whose own tool genuinely ends
 * in "_ide" (the suffix) has it renamed on every Claude request that was never
 * cloaked - an API-key Claude connection, or anthropic-compatible-*. The map hit
 * is unaffected either way; only the fallback is gated.
 */
import { describe, it, expect } from "vitest";
import {
  decloakToolNames,
  decloakStreamChunk,
  isClaudeCloakingActive,
} from "../../open-sse/utils/claudeCloaking.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";

const OAUTH = "sk-ant-oat01-abc";
const API_KEY = "sk-ant-api03-abc";
const CLOAKED = `run_code${CLAUDE_TOOL_SUFFIX}`;
// A client tool whose real name happens to end in the suffix.
const CLIENT_OWN = `open_in_ide`;

const toolUseStart = (name) => ({
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "toolu_01XYZ", name, input: {} },
});
const bodyWith = (name) => ({
  type: "message",
  content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "toolu_01XYZ", name, input: {} }],
});
const toolName = (body) => body.content[1].name;

describe("isClaudeCloakingActive mirrors the request-side gate", () => {
  it("is true only for the claude provider with an OAuth token", () => {
    expect(isClaudeCloakingActive("claude", OAUTH)).toBe(true);
    expect(isClaudeCloakingActive("claude", API_KEY)).toBe(false);
    expect(isClaudeCloakingActive("anthropic-compatible-1", OAUTH)).toBe(false);
    expect(isClaudeCloakingActive("openai", OAUTH)).toBe(false);
    expect(isClaudeCloakingActive("claude", null)).toBe(false);
    expect(isClaudeCloakingActive(null, null)).toBe(false);
  });
});

describe("the map always wins, cloaked or not", () => {
  const map = new Map([[CLOAKED, "run_code"]]);

  it("restores a mapped name in a streamed chunk", () => {
    expect(decloakStreamChunk(toolUseStart(CLOAKED), map, false).content_block.name).toBe("run_code");
    expect(decloakStreamChunk(toolUseStart(CLOAKED), map, true).content_block.name).toBe("run_code");
  });

  it("restores a mapped name in a non-streaming body", () => {
    expect(toolName(decloakToolNames(bodyWith(CLOAKED), map, false))).toBe("run_code");
    expect(toolName(decloakToolNames(bodyWith(CLOAKED), map, true))).toBe("run_code");
  });
});

describe("the fallback fires when the map was lost on a cloaked request", () => {
  it("strips the suffix in a streamed chunk", () => {
    expect(decloakStreamChunk(toolUseStart(CLOAKED), null, true).content_block.name).toBe("run_code");
  });

  it("strips the suffix in a non-streaming body", () => {
    expect(toolName(decloakToolNames(bodyWith(CLOAKED), null, true))).toBe("run_code");
  });
});

describe("the fallback never fires when kRouter did not cloak", () => {
  it("leaves a client tool that genuinely ends in the suffix alone (stream)", () => {
    const chunk = toolUseStart(CLIENT_OWN);
    expect(decloakStreamChunk(chunk, null, false)).toBe(chunk);
    expect(decloakStreamChunk(chunk, new Map(), false)).toBe(chunk);
  });

  it("leaves a client tool that genuinely ends in the suffix alone (non-streaming)", () => {
    expect(toolName(decloakToolNames(bodyWith(CLIENT_OWN), null, false))).toBe(CLIENT_OWN);
  });

  it("is a no-op for any suffixed name with no map and no cloaking", () => {
    const chunk = toolUseStart(CLOAKED);
    expect(decloakStreamChunk(chunk, null, false)).toBe(chunk);
    expect(toolName(decloakToolNames(bodyWith(CLOAKED), null, false))).toBe(CLOAKED);
  });
});
