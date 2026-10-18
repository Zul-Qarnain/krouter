/**
 * 0.5.166 — strict proxy on a CHAT request (upstream cfd8c618, review follow-up).
 *
 * chatCore reads credentials.providerSpecificData.strictProxy and proxyPoolId to build
 * proxyOptions, but getProviderCredentials never wrote strictProxy, so the guard in
 * proxyAwareFetch and the Cursor executor never saw it: a strict pool that was inactive,
 * had no URL, or failed to load went out over the real IP on every /v1/chat request.
 * Both credential shapes are covered: the no-auth virtual connection and a real one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p) => readFileSync(join(process.cwd(), p), "utf8");

describe("getProviderCredentials carries strictProxy into providerSpecificData", () => {
  const src = read("src/sse/services/auth.js");

  it("writes it everywhere it writes the other resolved proxy fields", () => {
    const relay = (src.match(/vercelRelayUrl: resolvedProxy\.vercelRelayUrl/g) || []).length;
    const strict = (src.match(/strictProxy: resolvedProxy\.strictProxy === true/g) || []).length;
    expect(relay).toBeGreaterThan(0);
    expect(strict).toBe(relay);
  });

  it("reads it from the pool result, not from a connection field", () => {
    expect(src).not.toMatch(/strictProxy: connection\./);
  });
});

describe("the reader and the writer agree on the field name", () => {
  it("chatCore builds proxyOptions.strictProxy from providerSpecificData.strictProxy", () => {
    expect(read("open-sse/handlers/chatCore.js")).toContain(
      "strictProxy: credentials?.providerSpecificData?.strictProxy === true"
    );
  });

  it("resolveConnectionProxyConfig returns strictProxy for a pool that cannot be used", () => {
    const proxy = read("src/lib/network/connectionProxy.js");
    expect(proxy).toMatch(/strictProxy/);
  });
});

describe("the guard that consumes it is still wired", () => {
  it("proxyAwareFetch refuses when a strict proxy was intended but none resolved", () => {
    const fetchSrc = read("open-sse/utils/proxyFetch.js");
    expect(fetchSrc).toMatch(/isStrictProxyIntended/);
    expect(fetchSrc).toMatch(/strictProxy=true/);
  });

  it("the Cursor executor takes the guarded path under a strict pool", () => {
    expect(read("open-sse/executors/cursor.js")).toMatch(/isStrictProxyIntended/);
  });
});
