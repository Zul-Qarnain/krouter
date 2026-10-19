/**
 * 0.5.166 — a deprecation alias must land on a model that is still served.
 *
 * BUILT_IN_ALIASES exists so a model id hardcoded in someone's combo or IDE keeps
 * working after the vendor retires it. That only helps if the REPLACEMENT is alive.
 * Several chains had rotted into a second 404:
 *   claude-3-opus-20240229   -> claude-opus-4-20250514     (retired 2026-06-15)
 *   claude-3-haiku-20240307  -> claude-3-5-sonnet-20241022 (retired 2025-10-28)
 *   claude-3-5-sonnet-latest -> claude-sonnet-4-20250514   (retired 2026-06-15)
 *   gpt-4-turbo-preview      -> gpt-4-turbo                (shuts down 2026-10-23)
 *   gpt-3.5-turbo-0125       -> gpt-3.5-turbo              (shuts down 2026-10-23)
 *   gemini-*                 -> gemini-2.5-pro / -flash    (retiring on Vertex 2026-10-20)
 *
 * The durable guard is not a one-off string update: it is that every target must be an
 * id the catalog actually serves. When the next retirement drops a model from the
 * catalog, this test fails instead of users getting a 404 from a "fix".
 */
import { describe, it, expect } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { resolveDeprecatedModel, __test__ } from "../../open-sse/services/modelDeprecation.js";

const aliases = __test__.BUILT_IN_ALIASES;

// Every bare id the catalog serves, across every provider.
const served = new Set();
for (const list of Object.values(PROVIDER_MODELS)) {
  for (const m of list || []) {
    if (!m?.id) continue;
    served.add(m.id);
    if (m.id.includes("/")) served.add(m.id.slice(m.id.indexOf("/") + 1));
  }
}

// Vendor-retired ids that may still sit in a catalog somewhere; a target must never be one.
const RETIRED = new Set([
  "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307",
  "gpt-3.5-turbo", "gpt-4", "gpt-4-turbo", "gpt-4o-2024-05-13", "gpt-4.1-nano",
  "o1", "o1-pro", "o3-mini", "o4-mini",
]);

describe("every deprecation alias target is still served", () => {
  const entries = Object.entries(aliases);

  it("the map is not empty", () => {
    expect(entries.length).toBeGreaterThan(10);
  });

  it.each(entries)("%s -> %s is a model the catalog serves", (_from, to) => {
    const bare = to.includes("/") ? to.slice(to.indexOf("/") + 1) : to;
    expect(served.has(to) || served.has(bare)).toBe(true);
  });

  it.each(entries)("%s -> %s is not itself retired", (_from, to) => {
    expect(RETIRED.has(to)).toBe(false);
  });

  it("no alias points at another alias (one hop only)", () => {
    for (const [, to] of entries) expect(aliases[to]).toBeUndefined();
  });

  it("no alias maps an id to itself", () => {
    for (const [from, to] of entries) expect(to).not.toBe(from);
  });
});

describe("resolution still behaves", () => {
  it("keeps the provider prefix when the target has none", () => {
    const from = Object.keys(aliases).find((k) => !aliases[k].includes("/"));
    expect(resolveDeprecatedModel(`cc/${from}`)).toBe(`cc/${aliases[from]}`);
  });

  it("leaves an unknown model alone", () => {
    expect(resolveDeprecatedModel("some/unknown-model")).toBe("some/unknown-model");
    expect(resolveDeprecatedModel("")).toBe("");
  });
});
