// 0.5.165 — the cx catalog had drifted off ChatGPT's live roster completely.
//
// backend-api/codex/models no longer lists gpt-5.5 (which was kRouter's cx
// default), gpt-5.4, gpt-5.4-mini or gpt-5.3-codex-spark for ChatGPT sign-in;
// requests for them answer HTTP 400 (upstream 7878f53b, ca6e8407, dec820b9).
// Meanwhile the whole GPT-6 family, the GPT 5.6 Sol/Terra/Luna trio,
// gpt-daybreak-blue-latest, gpt-reserve and the codex-auto-review virtual model
// were missing. The spoofed Codex CLI version was also two minors stale, and a
// stale client_version filters new models out of the roster response.
//
// Invariants here: the catalog matches upstream's live list, the review-suffix
// helper still derives the right upstream id (codex-auto-review is NOT derived
// from a base model), and every default that points at a Codex model points at
// one the catalog still has.
import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { PROVIDERS, CODEX_CLI_VERSION } from "../../open-sse/config/providers.js";
import { CODEX_AUTOPING_CONFIG } from "../../src/shared/constants/config.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";
import { getPricingForModel } from "../../src/shared/constants/pricing.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const cx = PROVIDER_MODELS.cx;
const ids = cx.map((m) => m.id);
const llmIds = cx.filter((m) => (m.type || "llm") === "llm").map((m) => m.id);

describe("Codex (cx) catalog vs ChatGPT's live roster", () => {
  it("lists the GPT-6 family", () => {
    for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
      expect(ids, `${id} missing from the cx catalog`).toContain(id);
    }
  });

  it("lists GPT 5.6 Sol / Terra / Luna", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(ids, `${id} missing from the cx catalog`).toContain(id);
    }
  });

  it("lists gpt-daybreak-blue-latest and gpt-reserve", () => {
    expect(ids).toContain("gpt-daybreak-blue-latest");
    expect(ids).toContain("gpt-reserve");
  });

  it("drops the ids ChatGPT answers with 400", () => {
    for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
      expect(ids, `${id} was retired upstream and still answers 400`).not.toContain(id);
    }
  });

  it("drops the retired models' image variants", () => {
    for (const id of ["gpt-5.5-image", "gpt-5.4-image"]) {
      expect(ids, `${id} runs on a retired chat model`).not.toContain(id);
    }
  });

  it("keeps a -review twin for each base chat model", () => {
    for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(ids).toContain(`${id}-review`);
      expect(getModelUpstreamId("cx", `${id}-review`)).toBe(id);
    }
  });

  // getModelUpstreamId strips a trailing "-review" for cx. codex-auto-review is
  // the Codex CLI's own virtual model, not a review variant of "codex-auto", so
  // stripping would send a model that does not exist.
  it("forwards codex-auto-review verbatim", () => {
    expect(ids).toContain("codex-auto-review");
    expect(getModelUpstreamId("cx", "codex-auto-review")).toBe("codex-auto-review");
    expect(ids.filter((id) => id === "codex-auto-review-review")).toEqual([]);
  });

  it("flags the Responses-Lite models and only those", () => {
    const lite = cx.filter((m) => m.responsesLite).map((m) => m.id);
    for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
      expect(lite, `${id} must be marked responsesLite`).toContain(id);
    }
    expect(lite).not.toContain("gpt-6-astra");
    expect(lite).not.toContain("gpt-5.6-sol");
  });

  it("lists the GPT Image models the Responses image path needs", () => {
    for (const id of ["gpt-image-1.5", "gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
      expect(ids, `${id} missing from the cx catalog`).toContain(id);
    }
    for (const id of ["gpt-5.6-sol-image", "gpt-5.6-terra-image", "gpt-5.6-luna-image"]) {
      expect(ids, `${id} missing from the cx catalog`).toContain(id);
      expect(cx.find((m) => m.id === id)?.type).toBe("image");
    }
  });

  it("has no duplicate ids", () => {
    const seen = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(seen).toEqual([]);
  });
});

describe("one spoofed Codex CLI version", () => {
  it("is the version OpenAI's backend serves the new roster to", () => {
    expect(CODEX_CLI_VERSION).toBe("0.159.0");
  });

  it("is the version in the codex User-Agent", () => {
    expect(PROVIDERS.codex.headers["User-Agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
  });
});

describe("defaults that name a Codex model", () => {
  it("auto-pings with a model the catalog still serves", () => {
    expect(llmIds, `auto-ping model ${CODEX_AUTOPING_CONFIG.pingModel} is not a cx model`)
      .toContain(CODEX_AUTOPING_CONFIG.pingModel);
  });

  it("offers a live cx model in the jcode preset", () => {
    const preset = CLI_TOOLS.jcode.defaultModels.find((m) => m.defaultValue?.startsWith("cx/"));
    expect(preset).toBeTruthy();
    expect(preset.defaultValue).toBe("cx/gpt-6.1-sol");
    expect(llmIds).toContain(preset.defaultValue.slice("cx/".length));
  });
});

describe("pricing and capabilities follow the new ids", () => {
  it("prices GPT-6 Astra at OpenAI's published rate", () => {
    expect(getPricingForModel("cx", "gpt-6-astra")).toMatchObject({ input: 10.0, output: 50.0 });
  });

  it("prices every GPT-6 and GPT-5.6 id, review twins included", () => {
    for (const id of [
      "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
      "gpt-6-sol-review", "gpt-5.6-terra-review",
    ]) {
      const price = getPricingForModel("cx", id);
      expect(price, `${id} has no pricing row or pattern`).toBeTruthy();
      expect(price.input).toBeGreaterThan(0);
    }
  });

  it("gives the GPT-6 ids a real window instead of the 200K text floor", () => {
    for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
      const caps = getCapabilitiesForModel("cx", id);
      expect(caps.vision, `${id} should accept images`).toBe(true);
      expect(caps.contextWindow, `${id} window`).toBeGreaterThan(200000);
    }
  });
});
