import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { reorderByCapabilities } from "../../open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter } from "../../open-sse/services/capacityAdapter.js";

// 0.5.165 (upstream batch p2-caps) — capability rows that misrouted requests.
// Image requests to vision models were judged unsatisfiable (so the vision pool
// went in front of them), Claude was treated as unable to read PDFs, and
// /v1/models published windows far below (or, after a pattern fix, above) what
// each host serves. Vendor numbers: models.dev/api.json and api-docs.deepseek.com
// (read 2026-10-18).

const caps = (provider, model) => getCapabilitiesForModel(provider, model);

describe("vision rows (upstream 9c650e1d, 912ed295, 367fc546, 8a4f4d9d)", () => {
  it.each([
    ["opencode-go", "glm-5.3-flash"],
    ["ocg", "glm-5.3-flash"],
    ["glm", "glm-5.3-flash"],
  ])("%s/%s reads images, video and PDFs with a 1M window", (provider, model) => {
    expect(caps(provider, model)).toMatchObject({
      vision: true, videoInput: true, pdf: true, reasoning: true,
      contextWindow: 1000000, maxOutput: 131072,
    });
  });

  it.each([
    ["ocg", "deepseek-v4-flash-vision-exp"],
    ["ocg", "deepseek-v4.1-flash"],
    ["openrouter", "deepseek/deepseek-v4.1-flash"],
    ["kenari", "deepseek-v4-1-flash"],
    // DeepSeek's GA id for V4.1-Flash: "Vision ✓", 1M context, 384K output.
    ["ocg", "deepseek-flash"],
    ["deepseek", "deepseek-flash"],
  ])("%s/%s reads images and keeps the V4.1 1M/384K limits", (provider, model) => {
    expect(caps(provider, model)).toMatchObject({
      vision: true, reasoning: true, thinkingFormat: "deepseek",
      contextWindow: 1000000, maxOutput: 384000,
    });
  });

  it("dotted V4.x releases get vision from the pattern", () => {
    expect(caps("openrouter", "deepseek-v4.2-flash")).toMatchObject({ vision: true, contextWindow: 1000000 });
  });

  it.each([
    ["ocg", "deepseek-v4-pro"],
    ["codebuddy-cn", "deepseek-v4-pro"],
    ["ocg", "deepseek-v4-flash"],
  ])("%s/%s stays text-only (v0.5.164: DeepSeek lists V4 Pro vision as not supported)", (provider, model) => {
    expect(caps(provider, model).vision).toBe(false);
  });

  it("glm-4.6v and glm-4.5v read video and publish their real output caps", () => {
    expect(caps("glm-cn", "glm-4.6v")).toMatchObject({ vision: true, videoInput: true, contextWindow: 128000, maxOutput: 32768 });
    expect(caps("glm", "glm-4.5v")).toMatchObject({ vision: true, videoInput: true, contextWindow: 64000, maxOutput: 16384 });
  });
});

describe("GLM-5.2/5.3 windows are 1M (upstream 0f7f6e72)", () => {
  it.each([["glm", "glm-5.3"], ["glm-cn", "glm-5.3"], ["ocg", "glm-5.2"], ["glm", "glm-5.3-highspeed"]])(
    "%s/%s publishes 1M",
    (provider, model) => {
      expect(caps(provider, model).contextWindow).toBe(1000000);
    },
  );

  it.each(["glm-5.1", "glm-5", "glm-5.0", "glm-5-turbo", "glm-5v-turbo"])("%s keeps its ~200K window", (model) => {
    expect(caps("glm", model).contextWindow).toBe(200000);
  });
});

describe("Grok 4.5+ windows are 500K (upstream 9c650e1d)", () => {
  it.each([["xai", "grok-4.6"], ["ocg", "grok-4.6"], ["ocg", "grok-4.7"], ["xai", "grok-4.5"], ["gcli", "grok-4.5-high"]])(
    "%s/%s publishes 500K",
    (provider, model) => {
      expect(caps(provider, model)).toMatchObject({ vision: true, contextWindow: 500000 });
    },
  );

  it("grok-4 keeps 256K", () => {
    expect(caps("xai", "grok-4").contextWindow).toBe(256000);
  });
});

describe("Claude reads PDFs (upstream f5f88039, ccd0677d, e78b766a)", () => {
  it.each([
    ["cc", "claude-opus-5-5"],
    ["cc", "claude-sonnet-5-5"],
    ["cc", "claude-fable-5-1"],
    ["cc", "claude-fable-5"],
    ["cc", "claude-opus-5"],
    ["cc", "claude-sonnet-5"],
    ["anthropic", "claude-opus-4-8"],
    ["cc", "claude-sonnet-4-6"],
    ["cc", "claude-haiku-4-5-20251001"],
    ["cc", "claude-opus-4-5-20251101"],
    ["cc", "claude-sonnet-4-5-20250929"],
    ["gh", "claude-sonnet-4.6"],
    ["kr", "claude-haiku-4.5"],
    ["anthropic", "claude-mythos-5"],
  ])("%s/%s accepts PDF input", (provider, model) => {
    expect(caps(provider, model)).toMatchObject({ vision: true, pdf: true });
  });

  it("Claude 3 stays without PDF (conservative legacy fallback)", () => {
    expect(caps("anthropic", "claude-3-haiku-20240307").pdf).toBe(false);
  });

  it.each([
    ["anthropic", "claude-sonnet-5.5"],
    ["anthropic", "anthropic/claude-sonnet-5-5"],
    ["kiro", "claude-opus-5.5"],
    ["kr", "claude-opus-5.5-thinking"],
    ["kr", "claude-opus-5.5-thinking-agentic"],
  ])("%s/%s resolves to adaptive thinking, 1M context, 128K output", (provider, model) => {
    expect(caps(provider, model)).toMatchObject({
      thinkingFormat: "claude-adaptive", reasoning: true, pdf: true,
      contextWindow: 1000000, maxOutput: 128000,
    });
  });

  it("keeps the 0.5.164 rows: Opus/Sonnet 5.5 cannot disable thinking, Fable is adaptive", () => {
    expect(caps("cc", "claude-opus-5-5").thinkingCanDisable).toBe(false);
    expect(caps("cc", "claude-sonnet-5-5").thinkingCanDisable).toBe(false);
    expect(caps("cc", "claude-fable-5").thinkingFormat).toBe("claude-adaptive");
  });
});

describe("GPT-6 / GPT-5.4+ windows (upstream 89ffac5a caps half)", () => {
  it.each([
    ["openai", "gpt-6-luna"], ["openai", "gpt-6-sol"], ["openai", "gpt-6-astra"],
    ["openai", "gpt-5.4"], ["openai", "gpt-5.4-pro"], ["openai", "gpt-5.5"], ["openai", "gpt-5.6-terra"],
    ["gh", "gpt-5.4"], ["ocg", "gpt-6-luna"], ["ocg", "gpt-5.6-luna"],
  ])("%s/%s publishes the 1.05M API window", (provider, model) => {
    expect(caps(provider, model)).toMatchObject({ vision: true, reasoning: true, contextWindow: 1050000, maxOutput: 128000 });
  });

  it.each(["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5", "gpt-5.2", "gpt-5.3-codex"])("openai/%s stays at 400K", (model) => {
    expect(caps("openai", model).contextWindow).toBe(400000);
  });

  // Kiro truncates GPT-5.6 at 272K (v0.5.104, CONTENT_LENGTH_EXCEEDS_THRESHOLD above it).
  it.each([
    ["kiro", "gpt-5.6-sol"], ["kiro", "gpt-5.6-luna-thinking-agentic"], ["kr", "gpt-5.6-terra"], ["kr", "gpt-5.6-sol-agentic"],
  ])("%s/%s keeps Kiro's 272K truncation", (provider, model) => {
    expect(caps(provider, model)).toMatchObject({ vision: true, contextWindow: 272000, maxOutput: 128000 });
  });

  // Codex OAuth reports windows below the API's (upstream 79918c78, 92c7bdd5).
  it.each([
    ["codex", "gpt-6-sol", 272000], ["cx", "gpt-6-luna", 272000], ["cx", "gpt-6-astra", 272000],
    ["cx", "gpt-5.6-sol", 372000], ["cx", "gpt-5.6-sol-review", 372000],
    ["cx", "gpt-5.6-terra", 272000], ["codex", "gpt-5.6-luna-review", 272000],
    // Not probed yet: these keep the window kRouter published before this change.
    ["cx", "gpt-5.5", 400000], ["cx", "gpt-5.5-review", 400000], ["codex", "gpt-5.4", 400000],
  ])("%s/%s publishes Codex's %i window", (provider, model, window) => {
    expect(caps(provider, model)).toMatchObject({ vision: true, reasoning: true, contextWindow: window });
  });
});

describe("routing follows the corrected rows", () => {
  const imageTurn = new Set(["vision"]);

  it("reorderByCapabilities floats ocg/glm-5.3-flash ahead of a text-only member", () => {
    expect(reorderByCapabilities(["ocg/glm-5.2", "ocg/glm-5.3-flash"], imageTurn)).toEqual(["ocg/glm-5.3-flash", "ocg/glm-5.2"]);
  });

  it("the vision pool no longer goes in front of the (Vision) OpenCode Go models", () => {
    const settings = { capacityAdapter: { vision: { enabled: true, models: ["openai/gpt-4o"] } } };
    for (const target of ["ocg/glm-5.3-flash", "ocg/deepseek-v4-flash-vision-exp"]) {
      expect(augmentModelsWithCapacityAdapter([target], imageTurn, settings)).toEqual([target]);
    }
  });

  it("a PDF turn floats Claude ahead of a member that cannot read PDFs", () => {
    expect(reorderByCapabilities(["gemini/gemini-2.5-flash", "cc/claude-opus-5-5"], new Set(["pdf"])))
      .toEqual(["cc/claude-opus-5-5", "gemini/gemini-2.5-flash"]);
  });
});
