// 0.5.166 — the gpt-image-* family are image models in their own right, not
// chat models with an "-image" suffix (upstream 832a3465, eb712ca8, 7878f53b).
//
// buildBody only knew the suffixed shape: it sent stripImageSuffix(model) as the
// Responses `model`, so a request for gpt-image-2.5 asked ChatGPT to run the
// conversation on "gpt-image-2.5" — not a chat model — and the image model never
// reached the image_generation tool at all. The Responses call has to run on a
// chat model (gpt-5.6-sol since gpt-5.5 was retired) with the image model passed
// as image_generation.model, tool_choice pinned to the tool, and generate vs edit
// chosen by whether the request carried reference images.
//
// The suffixed ids (gpt-5.6-sol-image, gpt-5.3-image) keep their old behaviour.
import { describe, expect, it } from "vitest";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

const build = (model, body = {}) => codexImageAdapter.buildBody(model, { prompt: "a cat", ...body });

describe("Codex gpt-image-* models run the Responses call on a chat model", () => {
  it("sends a chat model and passes the image model to the tool", () => {
    const body = build("gpt-image-2.5");
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.tools).toEqual([
      { type: "image_generation", output_format: "png", action: "generate", model: "gpt-image-2.5" },
    ]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it("switches the tool to edit when the request carries a reference image", () => {
    const body = build("gpt-image-2.5-flare", { image: "aGVsbG8=" });
    expect(body.tools[0].action).toBe("edit");
    expect(body.tools[0].model).toBe("gpt-image-2.5-flare");
  });

  it("covers every gpt-image-* id the catalog lists", () => {
    const ids = PROVIDER_MODELS.cx.filter((m) => m.id.startsWith("gpt-image-")).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const body = build(id);
      expect(body.model, `${id} should run on a chat model`).toBe("gpt-5.6-sol");
      expect(body.tools[0].model, `${id} should ride in image_generation.model`).toBe(id);
    }
  });

  it("leaves the -image suffixed ids on their own chat model", () => {
    const body = build("gpt-5.6-terra-image", { size: "1024x1024" });
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.tools).toEqual([
      { type: "image_generation", output_format: "png", size: "1024x1024" },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(body.reasoning).toBeNull();
  });

  it("keeps the chat model it falls back to in the cx catalog", () => {
    const main = PROVIDER_MODELS.cx.find((m) => m.id === "gpt-5.6-sol");
    expect(main, "gpt-5.6-sol backs every gpt-image-* request").toBeTruthy();
    expect(main.type || "llm").toBe("llm");
  });
});
