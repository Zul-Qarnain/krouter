import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Replacing ssrfGuard.js with the hardened version is only half the port. It gains two
 * new functions, and the literal-only assertPublicUrl remains exported and unchanged —
 * so a call site that keeps using it stays vulnerable to the two classes the literal
 * checks cannot see:
 *
 *   - DNS: 127.0.0.1.nip.io passes every literal check and resolves to loopback.
 *     Confirmed against the ported guard: assertPublicUrl ALLOWED it,
 *     assertPublicUrlResolved blocked it.
 *   - Redirects: fetch() defaults to redirect:"follow", so a URL that passed the guard
 *     can 30x into loopback or the metadata range with only the first hop checked.
 *
 * The first port of this landed with the guard swapped and neither call site updated,
 * which read as "SSRF fixed" while both holes were open. These assert the wiring.
 *
 * The image paths were the same story a release later: _base.js's urlToBase64 was a
 * bare fetch(url) reached from a client-supplied cloudflare-ai body.image and from a
 * provider-supplied data[0].url, so it is asserted here for the same reason -- the
 * next port of an image adapter should fail this test, not ship the hole again.
 *
 * The async adapters' status polls were the worst of the three, because the poll
 * request carries the provider's own credential: a response-supplied status_url or
 * polling_url, or a redirect off a legitimate one, sent the key to whatever host
 * the response named. Those are asserted per adapter below.
 */

describe("SSRF guards are wired into the call sites", () => {
  it("the client-supplied fetch handler resolves DNS before allowing a URL", () => {
    const src = readFileSync("src/sse/handlers/fetch.js", "utf8");
    expect(src).toContain("assertPublicUrlResolved");
    expect(src).toMatch(/await assertPublicUrlResolved\(targetUrl\)/);
    // The literal-only check must not be what guards this path.
    expect(src).not.toMatch(/^\s*assertPublicUrl\(targetUrl\);/m);
  });

  it("the search fetch validates redirects instead of following them blindly", () => {
    const src = readFileSync("open-sse/handlers/search/index.js", "utf8");
    expect(src).toContain("fetchPublic");
    expect(src).toMatch(/const resp = await fetchPublic\(url,/);
    expect(src).not.toMatch(/const resp = await fetch\(url,/);
  });

  it("the shared image reader guards the URL, bounds the request and caps the body", () => {
    const src = readFileSync("open-sse/handlers/imageProviders/_base.js", "utf8");
    // Both image callers hand this reader a URL they did not choose, so the guard,
    // the timeout and the byte cap all have to live here -- a bare fetch(url) with
    // the default redirect:"follow" was all three holes at once.
    expect(src).toContain("fetchPublic");
    expect(src).toMatch(/await fetchPublic\(url,/);
    expect(src).not.toMatch(/await fetch\(url\)/);
    expect(src).toMatch(/AbortSignal\.timeout\(/);
    // The cap is counted off the stream, not read off a header -- that the sender
    // cannot lie its way past it is asserted for real in image-source-url-ssrf.test.js.
    expect(src).toMatch(/readCapped\(res, maxBytes\)/);
    // One reader, not one per adapter.
    expect(src.match(/export async function urlToBase64/g)).toHaveLength(1);
  });

  it("cloudflare-ai reads a client-supplied body.image through that reader, not its own fetch", () => {
    const src = readFileSync("open-sse/handlers/imageProviders/cloudflareAi.js", "utf8");
    // body.image is whatever the client posted, and /v1/images/generations is
    // unauthenticated by default (requireApiKey is not in DEFAULT_SETTINGS) with no
    // catalog check on the model string -- so this is the most exposed of the two.
    expect(src).toMatch(/import \{[^}]*\burlToBase64\b[^}]*\} from "\.\/_base\.js"/);
    expect(src).toMatch(/await urlToBase64\(trimmed\)/);
    expect(src).not.toMatch(/\bfetch\(/);
  });

  it("the image core reads a provider-supplied data[0].url through that reader", () => {
    const src = readFileSync("open-sse/handlers/imageGenerationCore.js", "utf8");
    expect(src).toMatch(/import \{[^}]*\burlToBase64\b[^}]*\} from "\.\/imageProviders\/_base\.js"/);
    // Both binaryOutput branches -- the executor-delegating one and the main one.
    expect(src.match(/urlToBase64\(first\.url\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/fetch\(first\.url/);
  });

  it("the async adapters poll through the one guarded poller, credential and all", () => {
    const base = readFileSync("open-sse/handlers/imageProviders/_base.js", "utf8");
    // The poll request carries the provider credential, so the hop matters as much
    // as the URL -- fetchPublic re-validates each one instead of following it.
    expect(base).toMatch(/export async function pollJson\(/);
    expect(base).toMatch(/await fetchPublic\(url, \{\s*headers,/);
    expect(base).toMatch(/AbortSignal\.timeout\(POLL_REQUEST_TIMEOUT_MS\)/);
    expect(base).toMatch(/readCapped\(res, maxBytes\)/);

    for (const [file, label] of [
      ["falAi.js", "Fal"],
      ["blackForestLabs.js", "BFL"],
      ["runwayml.js", "Runway"],
      ["nanobanana.js", "NanoBanana"],
    ]) {
      const src = readFileSync(`open-sse/handlers/imageProviders/${file}`, "utf8");
      expect(src, file).toMatch(/import \{[^}]*\bpollJson\b[^}]*\} from "\.\/_base\.js"/);
      expect(src, file).toMatch(new RegExp(`label: "${label}"`));
      // No adapter keeps a bare poll of its own.
      expect(src, file).not.toMatch(/await fetch\(/);
    }
  });

  it("fal-ai and black-forest-labs never poll a response-supplied URL unguarded", () => {
    // These two take the whole absolute URL out of the submit response, so they are
    // the pair where the host itself is attacker-reachable.
    const fal = readFileSync("open-sse/handlers/imageProviders/falAi.js", "utf8");
    expect(fal).toMatch(/pollJson\(status_url, \{/);
    expect(fal).toMatch(/pollJson\(response_url, \{/);

    const bfl = readFileSync("open-sse/handlers/imageProviders/blackForestLabs.js", "utf8");
    expect(bfl).toMatch(/pollJson\(pollingUrl, \{/);
  });

  it("runwayml escapes the task id it interpolates into the poll path", () => {
    const src = readFileSync("open-sse/handlers/imageProviders/runwayml.js", "utf8");
    expect(src).toMatch(/\/tasks\/\$\{encodeURIComponent\(id\)\}/);
  });

  it("the hardened guard still exports all three entry points", () => {
    const src = readFileSync("src/shared/utils/ssrfGuard.js", "utf8");
    for (const fn of ["assertPublicUrl", "assertPublicUrlResolved", "fetchPublic"]) {
      expect(src).toMatch(new RegExp(`export (async )?function ${fn}\\b`));
    }
  });
});

describe("the guard itself", () => {
  it("blocks a hostname that only resolves to loopback", async () => {
    const { assertPublicUrl, assertPublicUrlResolved } = await import(
      "../../src/shared/utils/ssrfGuard.js"
    );
    // Pins the exact gap: the literal check cannot see this, the resolving one can.
    expect(() => assertPublicUrl("http://127.0.0.1.nip.io/")).not.toThrow();
    await expect(assertPublicUrlResolved("http://127.0.0.1.nip.io/")).rejects.toThrow();
  });
});
