// 0.5.166 — the Antigravity quota parser filters Google's listQuotas response
// through a hand-written `importantModels` allow-list whose own comment says it
// "must match PROVIDER_MODELS ag ids". It drifted:
//
//   - gemini-3.1-flash-image has been in the ag catalog since 0.5.107
//     (upstream 5306bd90) but was never added to the allow-list, so its quota
//     bar never rendered;
//   - the Gemini 3.6/3.7/3.8 Flash tiers, gemini-3.1-pro-high and the Claude
//     Sonnet/Opus 5.5 tiers (upstream 42c691b3, 86694ed8, 70f15aa5, 24034f69,
//     a07ed95b) are served by Google today and silently dropped here;
//   - gemini-4-argon-high (upstream 29fc880e) is routed by the ag catalog but
//     missing from upstream's own quota list — the same drift again.
//
// Invariant: a catalog model Google reports quota for always gets a row. The
// allow-list only exists to hide Google's internal and experimental ids.
import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

const { getUsageForProvider } = await import("../../open-sse/services/usage.js");
const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.js");

function listQuotas(modelIds) {
  const models = {};
  for (const id of modelIds) {
    models[id] = {
      displayName: id,
      quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-20T12:00:00Z" },
    };
  }
  // Google also ships internal buckets nobody asked for.
  models["internal-experiment"] = {
    displayName: "Internal",
    isInternal: true,
    quotaInfo: { remainingFraction: 0.5 },
  };
  models["gemini-unlisted-canary"] = {
    displayName: "Canary",
    quotaInfo: { remainingFraction: 0.5 },
  };
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function quotasFor(modelIds) {
  proxyFetchMock.mockReset();
  proxyFetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: "proj-1" }), { status: 200 }))
    .mockResolvedValueOnce(listQuotas(modelIds));
  const usage = await getUsageForProvider({
    provider: "antigravity",
    accessToken: "fake-token",
    providerSpecificData: {},
    projectId: "proj-1",
  });
  return usage.quotas;
}

describe("Antigravity quota allow-list vs the ag catalog", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it("gives every ag catalog model a quota row when Google reports one", async () => {
    const catalogIds = PROVIDER_MODELS.ag.map((m) => m.id);
    const quotas = await quotasFor(catalogIds);
    const missing = catalogIds.filter((id) => !(id in quotas));
    // If this fails after an ag catalog addition, the fix is to add the id to
    // `importantModels` in open-sse/services/usage.js — not to relax this
    // assertion. An allow-list entry Google never reports is inert.
    expect(
      missing,
      `ag catalog ids missing from importantModels in open-sse/services/usage.js: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("covers gemini-4-argon-high, which upstream's own quota list omits", async () => {
    const quotas = await quotasFor(["gemini-4-argon-high"]);
    expect(quotas["gemini-4-argon-high"]).toBeDefined();
  });

  it("covers the Gemini 3.6 / 3.7 / 3.8 Flash tiers", async () => {
    const tiers = [
      "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
      "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
      "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
    ];
    const quotas = await quotasFor(tiers);
    expect(tiers.filter((id) => !(id in quotas))).toEqual([]);
  });

  it("covers gemini-3.1-pro-high and the Claude Sonnet / Opus 5.5 tiers", async () => {
    const ids = [
      "gemini-3.1-pro-high",
      "claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-low",
      "claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low",
    ];
    const quotas = await quotasFor(ids);
    expect(ids.filter((id) => !(id in quotas))).toEqual([]);
  });

  it("still drops internal and unlisted Google buckets", async () => {
    const quotas = await quotasFor(["gemini-3.1-pro-low"]);
    expect(quotas["internal-experiment"]).toBeUndefined();
    expect(quotas["gemini-unlisted-canary"]).toBeUndefined();
    expect(quotas["gemini-3.1-pro-low"]).toBeDefined();
  });
});
