/**
 * Two dashboard-side fixes in the Usage page component:
 *
 * 1. The provider filter listed providers flagged `hidden` (upstream dcc6a205).
 *    noAuth free providers are added regardless of connections, so a retired
 *    noAuth provider such as MiMo Code Free kept a filter chip after it was
 *    hidden everywhere else.
 * 2. The API-key tab grouped rows by keyName alone (upstream 813a0121). Two keys
 *    with the same name, or two keys missing from the key store, merged into one
 *    group even though the stats now keep them in separate buckets.
 *
 * UsageStats.js is a JSX client component that vitest's node environment cannot
 * import, so these checks read its source, as the other component tests do.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/shared/components/UsageStats.js", "utf8");

function block(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf(endMarker, start));
}

describe("usage provider filter skips hidden providers", () => {
  it("drops hidden providers from the connected-provider list", () => {
    const filter = block("const unique = (d?.connections || []).filter", "}).map(");
    expect(filter).toMatch(/AI_PROVIDERS\[c\.provider\]\?\.hidden/);
  });

  it("drops hidden providers from the always-listed noAuth providers", () => {
    const filter = block("const noAuthProviders = Object.values(FREE_PROVIDERS)", ".map(");
    expect(filter).toMatch(/!p\.hidden/);
  });
});

describe("API-key tab keeps distinct keys apart", () => {
  // getGroupKey is plain JS (no JSX), so it can be lifted out and run as-is.
  const getGroupKey = new Function(`${block("function getGroupKey", "\n}\n")}\n}\nreturn getGroupKey;`)();

  it("keeps two keys with the same name in separate groups", () => {
    const a = getGroupKey({ keyName: "default", apiKeyMasked: "sk-machi***1111" }, "keyName");
    const b = getGroupKey({ keyName: "default", apiKeyMasked: "sk-machi***2222" }, "keyName");
    expect(a).toBe("default (sk-machi***1111)");
    expect(a).not.toBe(b);
  });

  it("does not repeat the mask for a key named by its mask", () => {
    expect(getGroupKey({ keyName: "sk-machi***7777", apiKeyMasked: "sk-machi***7777" }, "keyName")).toBe("sk-machi***7777");
  });

  it("keeps the no-key bucket's label", () => {
    expect(getGroupKey({ keyName: "Local (No API Key)", apiKeyMasked: null }, "keyName")).toBe("Local (No API Key)");
    expect(getGroupKey({}, "keyName")).toBe("Unknown Key");
  });

  it("shows the masked key in each detail row", () => {
    const apiKeyCase = block('case "apiKey": {', 'case "endpoint":');
    expect(apiKeyCase).toContain("{item.apiKeyMasked || item.keyName}");
  });
});
