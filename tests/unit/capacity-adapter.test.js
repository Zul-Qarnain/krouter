import { describe, it, expect } from "vitest";
import {
  getCapacityAdapterConfig,
  getCapacityAdapterModels,
  augmentModelsWithCapacityAdapter,
  stripHistoryForContext,
  withCapacityAdapterStripping,
} from "../../open-sse/services/capacityAdapter.js";
import { detectRequiredCapabilities } from "../../open-sse/services/combo.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// 0.5.166 — no implicit default any more (mmf/mimo-auto is a dead channel, see
// vision-pool-no-dead-mimo-default.test.js), so these tests pick a pool model.
const FALLBACK = "openai/gpt-4o"; // a vision-only pool model the user picked (no audio)
const visionOn = { capacityAdapter: { vision: { enabled: true, roundRobin: false, models: [FALLBACK] } } };

describe("0.5.125 capacity adapter — config resolution", () => {
  it("the pool model used here is vision-capable", () => {
    expect(getCapabilitiesForModel("openai", "gpt-4o").vision).toBe(true);
    expect(getCapabilitiesForModel("openai", "gpt-4o").audioInput).not.toBe(true);
  });

  it("an enabled pool returns the models the user picked", () => {
    expect(getCapacityAdapterConfig("vision", visionOn).models).toEqual([FALLBACK]);
  });

  it("a disabled pool contributes nothing", () => {
    const cfg = getCapacityAdapterConfig("audioInput", visionOn); // audioInput absent → disabled
    expect(cfg.enabled).toBe(false);
    expect(getCapacityAdapterModels(visionOn)).toEqual([FALLBACK]); // only vision pool
  });

  it("honours an explicitly configured pool", () => {
    const s = { capacityAdapter: { vision: { enabled: true, models: ["gemini/gemini-2.5-flash"] } } };
    expect(getCapacityAdapterConfig("vision", s).models).toEqual(["gemini/gemini-2.5-flash"]);
  });
});

describe("0.5.125 capacity adapter — augmentation", () => {
  it("prepends the fallback when the target model can't satisfy a vision request", () => {
    const out = augmentModelsWithCapacityAdapter(["some-text-provider/text-only"], new Set(["vision"]), visionOn);
    expect(out[0]).toBe(FALLBACK);
    expect(out).toContain("some-text-provider/text-only");
  });

  it("leaves models UNTOUCHED when a member already covers the capability", () => {
    const models = ["xiaomi-mimo/mimo-v2.5"]; // already vision-capable
    expect(augmentModelsWithCapacityAdapter(models, new Set(["vision"]), visionOn)).toBe(models);
  });

  it("no-op when the request carries no modality", () => {
    const models = ["some-text-provider/text-only"];
    expect(augmentModelsWithCapacityAdapter(models, new Set(), visionOn)).toBe(models);
  });

  it("no-op for a modality whose pool is disabled (audio off by default)", () => {
    const models = ["some-text-provider/text-only"];
    expect(augmentModelsWithCapacityAdapter(models, new Set(["audioInput"]), visionOn)).toBe(models);
  });
});

describe("0.5.125 detectRequiredCapabilities — audio/video/mime (6498b312)", () => {
  const wrap = (block) => ({ messages: [{ role: "user", content: [block] }] });
  it("input_audio block → audioInput", () => {
    expect([...detectRequiredCapabilities(wrap({ type: "input_audio" }))]).toContain("audioInput");
  });
  it("video_url block → videoInput", () => {
    expect([...detectRequiredCapabilities(wrap({ type: "video_url" }))]).toContain("videoInput");
  });
  it("image block → vision", () => {
    expect([...detectRequiredCapabilities(wrap({ type: "image_url" }))]).toContain("vision");
  });
  it("file block with audio mime → audioInput (not pdf)", () => {
    const caps = [...detectRequiredCapabilities(wrap({ type: "file", file: { file_data: "data:audio/mp3;base64,AAA" } }))];
    expect(caps).toContain("audioInput");
    expect(caps).not.toContain("pdf");
  });
  it("generic file block → pdf", () => {
    expect([...detectRequiredCapabilities(wrap({ type: "file" }))]).toContain("pdf");
  });
});

describe("0.5.125 stripHistoryForContext + wrapper", () => {
  it("keeps system + current turn, drops the middle when over budget", () => {
    const big = "x".repeat(5000);
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: "final image turn" },
      ],
    };
    const out = stripHistoryForContext(body, 1000); // tiny window forces trimming
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(out.messages[out.messages.length - 1].content).toBe("final image turn");
    expect(out.messages.length).toBeLessThan(body.messages.length);
  });

  it("wrapper only strips for adapter models, passthrough otherwise", () => {
    let seenModel = null;
    const inner = (b, m) => { seenModel = m; return b.messages.length; };
    const wrapped = withCapacityAdapterStripping(inner, [FALLBACK]);
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(wrapped(body, "other/model")).toBe(1); // passthrough
    expect(seenModel).toBe("other/model");
  });
});
