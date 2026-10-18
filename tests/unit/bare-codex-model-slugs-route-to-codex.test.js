// 0.5.166 — the Codex CLI's /model picker sends a bare model id with no provider
// prefix. Every `gpt-*` slug fell through to provider "openai" (model.js:284), so
// a user with a ChatGPT OAuth connection and no OpenAI API key got "no credentials
// for provider: openai" for gpt-6.1-sol, gpt-5.6-terra, gpt-daybreak-blue-latest,
// gpt-reserve and codex-auto-review — ids that only exist behind
// backend-api/codex (upstream 8f9ff44f, efc80ba2).
//
// Divergence from upstream, which routes the whole gpt-5.x / gpt-6.x range to
// codex unconditionally: kRouter's own openai catalog still sells gpt-5.1,
// gpt-5.2 and the gpt-5.4 family, and those have to keep reaching the OpenAI API.
// A Codex prefix therefore only wins for a slug the openai catalog does NOT own.
import { describe, expect, it } from "vitest";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

const infer = (modelStr) => getModelInfoCore(modelStr, {});

describe("bare Codex-only model slugs route to codex", () => {
  it("routes the Codex-only GPT slugs to codex", async () => {
    for (const id of [
      "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
      "gpt-daybreak-blue-latest", "gpt-reserve",
      "codex-auto-review",
    ]) {
      await expect(infer(id), `${id} is Codex-only`).resolves.toEqual({ provider: "codex", model: id });
    }
  });

  it("routes the -review twins to codex too", async () => {
    await expect(infer("gpt-5.6-terra-review")).resolves.toEqual({
      provider: "codex", model: "gpt-5.6-terra-review",
    });
  });

  it("leaves every gpt slug the openai catalog sells on openai", async () => {
    const openaiIds = PROVIDER_MODELS.openai.filter((m) => m.id.startsWith("gpt-")).map((m) => m.id);
    expect(openaiIds).toContain("gpt-5.1");
    expect(openaiIds).toContain("gpt-5.4-mini");
    for (const id of openaiIds) {
      const info = await infer(id);
      expect(info.provider, `${id} is on the openai catalog and must stay there`).toBe("openai");
    }
  });

  it("leaves unrelated gpt slugs on openai", async () => {
    for (const id of ["gpt-4o", "gpt-4.1-nano", "gpt-3.5-turbo", "gpt-image-1", "gpt-image-2.5"]) {
      const info = await infer(id);
      expect(info.provider, `${id} is not a Codex-only slug`).toBe("openai");
    }
  });

  it("keeps the other prefix rules intact", async () => {
    await expect(infer("claude-opus-5-5")).resolves.toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    await expect(infer("gemini-3.8-flash")).resolves.toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
    await expect(infer("o3-mini")).resolves.toEqual({ provider: "openai", model: "o3-mini" });
    await expect(infer("deepseek-v4")).resolves.toEqual({ provider: "openrouter", model: "deepseek-v4" });
  });

  it("still lets an explicit prefix and a user alias win", async () => {
    await expect(infer("openai/gpt-6.1-sol")).resolves.toEqual({ provider: "openai", model: "gpt-6.1-sol" });
    await expect(getModelInfoCore("gpt-6-sol", { "gpt-6-sol": "openai/gpt-6-sol" })).resolves.toEqual({
      provider: "openai", model: "gpt-6-sol",
    });
  });
});
