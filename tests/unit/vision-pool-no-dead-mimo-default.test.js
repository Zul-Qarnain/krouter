import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 0.5.166 — Xiaomi ended the free MiMo channel (upstream 6d96e24b hid mimo-free;
 * live on 2026-10-18 the bootstrap still hands out a JWT but chat answers
 * 401 "Invalid Token"). kRouter's vision pool was on by default with
 * mmf/mimo-auto as its implicit model, so every image request to a model or
 * combo without vision spent a failed call on that dead channel first.
 *
 * Now: an enabled pool with no models is a no-op, stored mmf/* entries are
 * dropped on read (copy-on-write), the dashboard stops auto-refilling the dead
 * model, and mimo-free is hidden from the provider lists and the model picker.
 */

const db = vi.hoisted(() => ({ row: null }));
vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    get: () => db.row,
    run: () => {},
    transaction: (fn) => fn(),
  }),
}));

const {
  getCapacityAdapterConfig,
  getCapacityAdapterModels,
  getActiveAdapterStrategy,
  augmentModelsWithCapacityAdapter,
} = await import("../../open-sse/services/capacityAdapter.js");
const { getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
const { FREE_PROVIDERS, getProvidersByKind, ALIAS_TO_ID } = await import("../../src/shared/constants/providers.js");

const VISION = new Set(["vision"]);
const TEXT_ONLY = "some-text-provider/text-only";
const visionOnEmpty = { capacityAdapter: { vision: { enabled: true, roundRobin: false, models: [] } } };

describe("capacity adapter has no implicit dead default", () => {
  it("an enabled vision pool with no models resolves to no models", () => {
    expect(getCapacityAdapterConfig("vision", visionOnEmpty).models).toEqual([]);
    expect(getCapacityAdapterModels(visionOnEmpty)).toEqual([]);
  });

  it("an image request to a text-only model is left untouched when the pool is empty", () => {
    const models = [TEXT_ONLY];
    expect(augmentModelsWithCapacityAdapter(models, VISION, visionOnEmpty)).toBe(models);
  });

  it("an empty enabled pool keeps the plain fallback strategy", () => {
    const s = { capacityAdapter: { vision: { enabled: true, roundRobin: true, models: [] } } };
    expect(getActiveAdapterStrategy(VISION, s)).toBe("fallback");
  });

  it("a model the user picked still fronts an image request", () => {
    const s = { capacityAdapter: { vision: { enabled: true, models: ["xiaomi-mimo/mimo-v2.5"] } } };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], VISION, s)).toEqual(["xiaomi-mimo/mimo-v2.5", TEXT_ONLY]);
  });
});

describe("stored mmf pool entries are dropped", () => {
  it("drops mmf/mimo-auto from an object-form pool and keeps the rest in order", () => {
    const s = { capacityAdapter: { vision: { enabled: true, models: ["mmf/mimo-auto", "xiaomi-mimo/mimo-v2.5"] } } };
    expect(getCapacityAdapterConfig("vision", s).models).toEqual(["xiaomi-mimo/mimo-v2.5"]);
  });

  it("drops it from the legacy array form too", () => {
    const s = { capacityAdapter: { vision: [{ model: "mmf/mimo-auto", enabled: true }] } };
    expect(getCapacityAdapterConfig("vision", s).models).toEqual([]);
  });

  it("never puts the dead channel in front of an image request", () => {
    const s = { capacityAdapter: { vision: { enabled: true, models: ["mmf/mimo-auto"] } } };
    const models = [TEXT_ONLY];
    expect(augmentModelsWithCapacityAdapter(models, VISION, s)).toBe(models);
  });
});

describe("settingsRepo migrates stored pools on read", () => {
  beforeEach(() => {
    db.row = null;
  });

  it("the default vision pool is enabled but empty", async () => {
    const s = await getSettings();
    expect(s.capacityAdapter.vision).toEqual({ enabled: true, roundRobin: false, models: [] });
  });

  it("removes mmf/mimo-auto from a stored pool, keeps the other fields", async () => {
    db.row = {
      data: JSON.stringify({
        capacityAdapter: {
          vision: { enabled: true, roundRobin: true, models: ["mmf/mimo-auto", "gemini/gemini-2.5-flash"] },
          audioInput: { enabled: false, roundRobin: false, models: [] },
        },
      }),
    };
    const s = await getSettings();
    expect(s.capacityAdapter.vision).toEqual({ enabled: true, roundRobin: true, models: ["gemini/gemini-2.5-flash"] });
    expect(s.capacityAdapter.audioInput).toEqual({ enabled: false, roundRobin: false, models: [] });
  });

  it("does not mutate the stored object (copy-on-write)", async () => {
    // parseJson returns a non-string value as-is, so an in-place edit would show here.
    const stored = { capacityAdapter: { vision: { enabled: true, models: ["mmf/mimo-auto"] } } };
    db.row = { data: stored };
    const s = await getSettings();
    expect(s.capacityAdapter.vision.models).toEqual([]);
    expect(stored.capacityAdapter.vision.models).toEqual(["mmf/mimo-auto"]);
  });
});

describe("mimo-free is hidden but still routable", () => {
  it("is flagged hidden", () => {
    expect(FREE_PROVIDERS["mimo-free"].hidden).toBe(true);
  });

  it("drops out of the provider-by-kind lists", () => {
    expect(getProvidersByKind("llm").some((p) => p.id === "mimo-free")).toBe(false);
  });

  it("keeps its alias so existing mmf/ routes still resolve", () => {
    expect(FREE_PROVIDERS["mimo-free"].alias).toBe("mmf");
    expect(ALIAS_TO_ID.mmf).toBe("mimo-free");
  });
});

describe("combos page no longer auto-refills the dead model", () => {
  it("has no mmf/mimo-auto default and shows a pick-a-model note", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/(dashboard)/dashboard/combos/page.js", "utf8");
    expect(src).not.toMatch(/["']mmf\/mimo-auto["']/);
    expect(src).not.toMatch(/DEFAULT_FALLBACK_MODEL/);
    expect(src).toMatch(/Pick a vision model/);
  });

  it("the model picker skips hidden no-auth providers, so mmf is not offered", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/shared/components/ModelSelectModal.js", "utf8");
    expect(src).toMatch(/NO_AUTH_PROVIDER_IDS = [^\n]*noAuth && !FREE_PROVIDERS\[id\]\.hidden/);
  });
});
