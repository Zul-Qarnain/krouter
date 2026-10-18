// 0.5.166 (upstream 781c18d8) — Codex's /responses schema validator has no
// Unicode property escapes. A tool `pattern` carrying `\p{...}` (valid ECMAScript
// u-mode) gets 400 "Invalid schema for function ... is not a 'regex'" on every
// account, which costs a full combo failover each turn. Only those `pattern` keys
// are dropped, copy-on-write, on the Codex path alone.
import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { hasUnicodePropertyEscape, stripCodexUnsupportedPatterns } from "../../open-sse/utils/codexToolSchema.js";

function normalizeTools(tools) {
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    stream: true,
  };
  new CodexExecutor().transformRequest("gpt-5.5", body, true, { connectionId: "test-codex-patterns", providerSpecificData: {} });
  return body.tools;
}

const unicodePattern = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]{1,200}$";
const validPattern = "^[a-z][a-z0-9_-]{0,31}$";

describe("Codex tool schema Unicode-property patterns", () => {
  it("strips only Unicode-property patterns, treating properties keys as names", () => {
    const sourceParameters = {
      type: "object",
      properties: {
        artifact: {
          type: "object",
          properties: {
            name: { type: "string", pattern: unicodePattern },
            slug: { type: "string", pattern: validPattern },
          },
        },
        // A property named "pattern" is data, not the schema keyword.
        pattern: { type: "string", pattern: validPattern },
      },
      allOf: [{ properties: { title: { type: "string", pattern: unicodePattern } } }],
    };
    const tools = normalizeTools([{ type: "function", name: "Artifact", parameters: sourceParameters }]);

    expect(tools[0].parameters.properties.artifact.properties.name.pattern).toBeUndefined();
    expect(tools[0].parameters.properties.artifact.properties.slug.pattern).toBe(validPattern);
    expect(tools[0].parameters.properties.pattern.pattern).toBe(validPattern);
    expect(tools[0].parameters.allOf[0].properties.title.pattern).toBeUndefined();
    // Copy-on-write: the caller's schema stays intact for a retry on another provider.
    expect(sourceParameters.properties.artifact.properties.name.pattern).toBe(unicodePattern);
    expect(sourceParameters.allOf[0].properties.title.pattern).toBe(unicodePattern);
  });

  it("keeps escaped literal text and schema identity when nothing needs stripping", () => {
    const parameters = {
      type: "object",
      properties: {
        literal: { type: "string", pattern: "^\\\\p{Cc}$" },
        simple: { type: "string", pattern: "^[A-Z]+$" },
      },
    };
    const tools = normalizeTools([{ type: "function", name: "probe", parameters }]);
    expect(tools[0].parameters).toBe(parameters);
    expect(tools[0].parameters.properties.literal.pattern).toBe("^\\\\p{Cc}$");
  });

  it("sanitizes Chat-shape nested function parameters too", () => {
    const tools = normalizeTools([{
      type: "function",
      function: { name: "Artifact", parameters: { type: "object", properties: { name: { type: "string", pattern: "^\\P{L}+$" } } } },
    }]);
    expect(tools[0].parameters.properties.name.pattern).toBeUndefined();
  });

  it("sanitizes namespace sub-tool schemas without mutating the client's sub-tool", () => {
    const subTool = {
      type: "function",
      name: "Artifact",
      parameters: { type: "object", properties: { name: { type: "string", pattern: "^\\p{Cc}+$" } } },
    };
    const tools = normalizeTools([{ type: "namespace", name: "agent", tools: [subTool] }]);
    expect(tools[0].tools[0].parameters.properties.name.pattern).toBeUndefined();
    expect(subTool.parameters.properties.name.pattern).toBe("^\\p{Cc}+$");
  });

  it("detects property escapes by backslash parity", () => {
    expect(hasUnicodePropertyEscape("\\p{L}")).toBe(true);
    expect(hasUnicodePropertyEscape("a\\P{Cc}")).toBe(true);
    expect(hasUnicodePropertyEscape("\\\\\\p{L}")).toBe(true);
    expect(hasUnicodePropertyEscape("\\\\p{L}")).toBe(false);
    expect(hasUnicodePropertyEscape("p{L}")).toBe(false);
    expect(hasUnicodePropertyEscape(42)).toBe(false);
  });

  it("counts what it removed", () => {
    const stats = { removed: 0 };
    stripCodexUnsupportedPatterns({ anyOf: [{ pattern: "\\p{L}" }, { pattern: "\\p{N}" }, { pattern: "x" }] }, stats);
    expect(stats.removed).toBe(2);
  });
});
