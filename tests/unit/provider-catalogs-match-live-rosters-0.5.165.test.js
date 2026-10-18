// 0.5.166 — catalog refresh for the providers that shipped new models between
// 2026-08 and 2026-10 upstream, plus the provider-constant endpoints that moved.
//
// Each block below is a model (or endpoint) a kRouter user cannot reach today
// because the catalog does not list it, or one the catalog lists that the vendor
// no longer serves. Sources are the matching upstream commits:
//   29fc880e (Gemini 4 Argon), 70f15aa5 / 86694ed8 (Gemini 3.7/3.8 Flash),
//   9c650e1d (GLM 5.3 Flash, glm-cn backfill), 8e15f0bd / 5c399b64
//   (DeepSeek V4.1 Flash on deepseek + Ollama Cloud), xai grok-4.5/4.6,
//   e014cb53 + cec672d9 + 807553e2 + 63de82b8 (CodeBuddy-CN 2026-09-30 roster),
//   2ab6a4c9 (Qoder), 910db749 (Xiaomi MiMo v2.6), c8644368 (OpenCode Go haiku),
//   51a1827e (GitHub Copilot embeddings), cf663f53 (HuggingFace STT router).
import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { PROVIDERS as BACKEND_PROVIDERS } from "../../open-sse/config/providers.js";
import { AI_PROVIDERS, USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { QODER_MODEL_MAP } from "../../src/lib/qoder/constants.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../src/shared/constants/pricing.js";
import { readFileSync } from "node:fs";

const idsOf = (alias) => PROVIDER_MODELS[alias].map((m) => m.id);

describe("Gemini API and Vertex", () => {
  it("serve Gemini 4 Argon and the 3.7 / 3.8 Flash models", () => {
    const gemini = idsOf("gemini");
    for (const id of ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash"]) {
      expect(gemini, `${id} missing from the gemini catalog`).toContain(id);
    }
    expect(idsOf("vertex")).toContain("gemini-4-argon");
  });

  // Vertex serves Argon only from the global / us / eu multi-regions, never a
  // regional location; the executor reads this to override its us-central1 default.
  it("pin Argon to the global Vertex location", () => {
    expect(PROVIDER_MODELS.vertex.find((m) => m.id === "gemini-4-argon")?.defaultLocation).toBe("global");
  });

  it("give Argon a 1M window it cannot turn thinking off on", () => {
    const caps = getCapabilitiesForModel("gemini", "gemini-4-argon");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(caps.thinkingCanDisable).toBe(false);
  });
});

describe("GLM (z.ai and glm-cn)", () => {
  it("serve GLM 5.3 Flash on both hosts", () => {
    expect(idsOf("glm")).toContain("glm-5.3-flash");
    expect(idsOf("glm-cn")).toContain("glm-5.3-flash");
  });

  it("backfill glm-cn with GLM 5.2 and the 4.6V vision model", () => {
    expect(idsOf("glm-cn")).toContain("glm-5.2");
    expect(idsOf("glm-cn")).toContain("glm-4.6v");
  });

  it("route GLM 5.3 Flash as a vision model with the full window", () => {
    const caps = getCapabilitiesForModel("glm", "glm-5.3-flash");
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
  });
});

describe("DeepSeek direct and Ollama Cloud", () => {
  it("serve DeepSeek V4.1 Flash", () => {
    expect(idsOf("deepseek")).toContain("deepseek-v4.1-flash");
    expect(idsOf("ollama")).toContain("deepseek-v4.1-flash:cloud");
  });

  it("price V4.1 Flash at the Flash rate instead of falling through", () => {
    expect(getPricingForModel("deepseek", "deepseek-v4.1-flash")).toMatchObject({ input: 0.3, output: 1.2 });
  });

  it("mark the Ollama Cloud copy as a vision model with a 1M window", () => {
    const caps = getCapabilitiesForModel("ollama", "deepseek-v4.1-flash:cloud");
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
  });
});

describe("xAI", () => {
  it("serves Grok 4.5 and 4.6", () => {
    const xai = idsOf("xai");
    expect(xai).toContain("grok-4.6");
    expect(xai).toContain("grok-4.5");
  });

  it("gives them the 500K window they publish", () => {
    expect(getCapabilitiesForModel("xai", "grok-4.6").contextWindow).toBe(500000);
    expect(getCapabilitiesForModel("xai", "grok-4.5").contextWindow).toBe(500000);
  });
});

describe("CodeBuddy-CN (cbcn)", () => {
  const cbcn = idsOf("cbcn");

  it("serves the 2026-09-30 server roster", () => {
    for (const id of ["hy3", "hy4-preview", "glm-5.3", "glm-5.3-flash", "kimi-k3-1", "kimi-k2.8-preview", "deepseek-v4.1-flash"]) {
      expect(cbcn, `${id} missing from the cbcn catalog`).toContain(id);
    }
  });

  it("drops the ids the gateway stopped publishing", () => {
    for (const id of ["glm-5.0", "glm-5.0-turbo", "glm-4.7", "glm-5v-turbo", "minimax-m2.7",
      "kimi-k2.5", "kimi-k2.6", "kimi-k2.7", "hy3-preview", "deepseek-v4-flash", "deepseek-v3-2-volc"]) {
      expect(cbcn, `${id} is no longer on the server list`).not.toContain(id);
    }
  });

  // thinkingCanDisable maps to the gateway's reasoning.canDisableThinking, which is
  // NOT the inverse of onlyReasoning: glm-5.2/5.3 think by default but CAN be told
  // not to. Reporting false made kRouter clamp a client's "none" to minimal forever.
  it("lets thinking be turned off where the gateway allows it", () => {
    for (const id of ["glm-5.2", "glm-5.3", "glm-5.3-flash", "deepseek-v4-pro", "deepseek-v4.1-flash", "kimi-k2.8-preview"]) {
      expect(getCapabilitiesForModel("codebuddy-cn", id).thinkingCanDisable, `${id}`).toBe(true);
    }
  });

  it("keeps thinking forced on for the hy* models", () => {
    for (const id of ["hy3", "hy4-preview"]) {
      expect(getCapabilitiesForModel("codebuddy-cn", id).thinkingCanDisable, `${id}`).toBe(false);
    }
  });

  it("publishes the server's real output caps", () => {
    expect(getCapabilitiesForModel("codebuddy-cn", "glm-5.2").maxOutput).toBe(131072);
    expect(getCapabilitiesForModel("codebuddy-cn", "minimax-m3").maxOutput).toBe(524288);
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4.1-flash").maxOutput).toBe(393216);
  });

  // k2.8 publishes supportedLengths [300000, 1000000] but only gives 1M when the
  // request opts in, which this executor never does. Budgeting history for 1M would
  // overflow the real window.
  it("budgets Kimi K2.8 at the window the gateway actually gives", () => {
    expect(getCapabilitiesForModel("codebuddy-cn", "kimi-k2.8-preview").contextWindow).toBe(300000);
  });

  it("gives every cbcn model a capability row", () => {
    const missing = cbcn.filter((id) => !getCapabilitiesForModel("codebuddy-cn", id).reasoning);
    expect(missing).toEqual([]);
  });
});

describe("Qoder", () => {
  const qd = idsOf("qd");

  it("serves the frontier models the IDE publishes", () => {
    for (const id of ["lite", "qmodel_38max", "qfmodel", "gmodel", "gfmodel"]) {
      expect(qd, `${id} missing from the qd catalog`).toContain(id);
    }
  });

  it("drops gm51model, which the server stopped publishing", () => {
    expect(qd).not.toContain("gm51model");
    expect(Object.keys(QODER_MODEL_MAP)).not.toContain("gm51model");
  });

  // The signed request is validated against QODER_MODEL_MAP, so a catalog id the
  // map does not know is rejected before it reaches a model.
  it("keeps the catalog and the signing map in agreement", () => {
    expect([...qd].sort()).toEqual(Object.keys(QODER_MODEL_MAP).sort());
  });

  // Qoder's ids are opaque (dfmodel, gfmodel, ...) so no pattern can match them;
  // without a provider map every model claimed the 200K default window.
  it("resolves every opaque id to its real model's window", () => {
    for (const id of qd) {
      const caps = getCapabilitiesForModel("qoder", id);
      expect(caps.reasoning, `${id} reasoning`).toBe(true);
      expect(caps.contextWindow, `${id} window`).toBeGreaterThan(200000);
      expect(caps.thinkingCanDisable, `${id} thinking`).toBe(false);
    }
  });
});

describe("Xiaomi MiMo cloud and OpenCode Go", () => {
  it("serves the MiMo v2.6 models", () => {
    const mimo = idsOf("xiaomi-mimo");
    for (const id of ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]) {
      expect(mimo, `${id} missing`).toContain(id);
      expect(getModelUpstreamId("xiaomi-mimo", id)).toBe(`xiaomi/${id}`);
    }
  });

  it("serves OpenCode Go's claude-haiku-5-5 over /messages", () => {
    const ocg = PROVIDER_MODELS["opencode-go"];
    const haiku = ocg.find((m) => m.id === "claude-haiku-5-5");
    expect(haiku, "claude-haiku-5-5 missing from the opencode-go catalog").toBeTruthy();
    expect(haiku.targetFormat).toBe("claude");
  });

  // The global *claude*haiku* pattern emits thinking.type "enabled", which this
  // backend rejects with 400; claude-adaptive emits the adaptive switch it wants.
  it("gives OpenCode Go's haiku the adaptive thinking shape and a 1M window", () => {
    const caps = getCapabilitiesForModel("opencode-go", "claude-haiku-5-5");
    expect(caps.thinkingFormat).toBe("claude-adaptive");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(128000);
  });
});

describe("provider constants that moved", () => {
  it("routes GitHub Copilot embeddings to api.githubcopilot.com", () => {
    // models.github.ai was retired on 2026-07-30.
    expect(AI_PROVIDERS.github.embeddingConfig.baseUrl).toBe("https://api.githubcopilot.com/embeddings");
    const models = AI_PROVIDERS.github.embeddingConfig.models.map((m) => m.id);
    expect(models).toContain("text-embedding-ada-002");
  });

  it("routes HuggingFace STT to the Inference Providers router", () => {
    // api-inference.huggingface.co no longer resolves (ENOTFOUND).
    const stt = AI_PROVIDERS.huggingface.sttConfig;
    expect(stt.baseUrl).toBe("https://router.huggingface.co/hf-inference/models");
    expect(stt.models.map((m) => m.id)).toContain("openai/whisper-large-v3-turbo");
    expect(stt.models.map((m) => m.id)).not.toContain("openai/whisper-small");
  });

  it("drops the unusable language param from HuggingFace STT models", () => {
    const stt = PROVIDER_MODELS.huggingface.filter((m) => m.type === "stt");
    expect(stt.length).toBeGreaterThan(0);
    for (const m of stt) {
      expect(m.params || [], `${m.id} params`).not.toContain("language");
    }
  });

  // usage.js has had an opencode-go quota handler since 0.5.155, but
  // isUsageEligible() filters on these two lists, so the quota page never asked
  // for it: the provider is API-key only, so it needs to be in both.
  it("makes the opencode-go quota handler reachable", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("opencode-go");
    expect(USAGE_APIKEY_PROVIDERS).toContain("opencode-go");
  });

  it("declares ClinePass as both OAuth and API key", () => {
    expect(AI_PROVIDERS.clinepass.authModes).toEqual(expect.arrayContaining(["apikey", "oauth"]));
  });

  // A duplicate object key silently wins by position: the dead localhost:4096
  // entry was shadowed by the real one, so the file read like a working config
  // while half of it was unreachable.
  it("defines each backend provider exactly once", () => {
    const src = readFileSync("open-sse/config/providers.js", "utf8");
    for (const id of Object.keys(BACKEND_PROVIDERS)) {
      const key = id.includes("-") ? `"${id}":` : `${id}:`;
      const hits = src.split("\n").filter((line) => line.startsWith(`  ${key}`)).length;
      expect(hits, `${id} is declared ${hits} times in open-sse/config/providers.js`).toBe(1);
    }
  });
});

describe("catalog invariants", () => {
  // Two separate tables: PROVIDER_ID_TO_ALIAS (providerModels.js) decides which key
  // owns a model list, ALIAS_TO_PROVIDER_ID (services/model.js) routes
  // "<alias>/<model>" at request time. They must agree, or a provider lists its
  // models, passes every wiring check and then reaches the wrong upstream — exactly
  // how gcli/* once reached api.x.ai and 401'd with invalid_issuer.
  // Hidden providers are excluded: mimo-free (mmf) is dead upstream and hidden from
  // every list, and its alias was never added to the routing map — which is the
  // same gap, in the one provider where it no longer matters.
  it("round-trips every offered short alias: alias -> provider id -> same alias", () => {
    const broken = Object.entries(PROVIDER_ID_TO_ALIAS)
      .filter(([id, alias]) => alias !== id && !AI_PROVIDERS[id]?.hidden)
      .map(([id, alias]) => [alias, resolveProviderAlias(alias), id])
      .filter(([, routed, id]) => routed !== id);
    expect(broken).toEqual([]);
  });

  it("keys every chat model list the routing map can reach", () => {
    const unrouted = Object.keys(PROVIDER_MODELS)
      .filter((alias) => PROVIDER_MODELS[alias].some((m) => (m.type || "llm") === "llm"))
      .filter((alias) => !BACKEND_PROVIDERS[resolveProviderAlias(alias)]);
    expect(unrouted).toEqual([]);
  });

  it("has no duplicate model id in any provider list", () => {
    const dupes = Object.entries(PROVIDER_MODELS).flatMap(([alias, models]) => {
      const ids = models.map((m) => `${m.id}|${m.type || "llm"}`);
      return ids.filter((id, i) => ids.indexOf(id) !== i).map((id) => `${alias}/${id}`);
    });
    expect([...new Set(dupes)]).toEqual([]);
  });
});
