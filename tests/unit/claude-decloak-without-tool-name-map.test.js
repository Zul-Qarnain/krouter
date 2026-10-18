// 0.5.165 (upstream b65d2d0a + b54a3f9b) — the OAuth cloak renames client tools to
// "<tool>_ide". When the suffixed -> original map is missing for a response (a
// retried or reconnected stream), decloak returned early and the client received
// "<tool>_ide", a name it cannot resolve. Fall back to stripping the suffix. The
// CC decoy names are sent unsuffixed, so they are never touched.
import { describe, it, expect } from "vitest";
import { decloakToolNames, decloakStreamChunk } from "../../open-sse/utils/claudeCloaking.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";

const CLOAKED = `run_code${CLAUDE_TOOL_SUFFIX}`;
const toolUseStart = (name) => ({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } });
const message = (...names) => ({ type: "message", content: names.map((name, i) => ({ type: "tool_use", id: `toolu_${i}`, name, input: {} })) });

describe("decloakStreamChunk without a usable map", () => {
  it.each([null, undefined, new Map()])("strips the suffix when the map is %s", (map) => {
    expect(decloakStreamChunk(toolUseStart(CLOAKED), map, true).content_block.name).toBe("run_code");
  });

  it("strips the suffix when the map exists but misses the name", () => {
    const map = new Map([[`other${CLAUDE_TOOL_SUFFIX}`, "other"]]);
    expect(decloakStreamChunk(toolUseStart(CLOAKED), map, true).content_block.name).toBe("run_code");
  });

  it("prefers the map over suffix stripping", () => {
    const map = new Map([[CLOAKED, "RunCode"]]);
    expect(decloakStreamChunk(toolUseStart(CLOAKED), map, true).content_block.name).toBe("RunCode");
  });

  it("leaves decoy and uncloaked names alone, returning the same chunk", () => {
    for (const name of ["Bash", "uncloaked_tool"]) {
      const chunk = toolUseStart(name);
      expect(decloakStreamChunk(chunk, null, true)).toBe(chunk);
    }
  });

  it("never reduces a bare suffix to an empty name", () => {
    expect(decloakStreamChunk(toolUseStart(CLAUDE_TOOL_SUFFIX), null, true).content_block.name).toBe(CLAUDE_TOOL_SUFFIX);
  });

  it("tolerates the null flush chunk", () => {
    expect(decloakStreamChunk(null, null, true)).toBeNull();
  });
});

describe("decloakToolNames (non-streaming) without a usable map", () => {
  it("strips the suffix with no map", () => {
    const out = decloakToolNames(message(CLOAKED, "Bash"), null, true);
    expect(out.content.map(b => b.name)).toEqual(["run_code", "Bash"]);
  });

  it("does not mutate the provider body", () => {
    const body = message(CLOAKED);
    decloakToolNames(body, null, true);
    expect(body.content[0].name).toBe(CLOAKED);
  });

  it("returns bodies without a content array untouched", () => {
    const body = { choices: [] };
    expect(decloakToolNames(body, null, true)).toBe(body);
  });
});
