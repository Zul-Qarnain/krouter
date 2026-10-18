import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Every image path that takes a URL and fetches it server-side went through one
 * bare `fetch(url)` in _base.js -- no SSRF guard, no timeout, no size cap, and
 * the default redirect:"follow" so even a caller that checked the first hop
 * would have been walked past its own check.
 *
 * Two callers, two exposure levels:
 *
 *   - cloudflare-ai's `body.image` is CLIENT-supplied. /v1/images/generations
 *     does no catalog check on the model string (getModelInfoCore returns
 *     provider/model straight out of "cloudflare-ai/<model>") and requireApiKey
 *     is not in DEFAULT_SETTINGS, so an unauthenticated POST carrying
 *     "image": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
 *     made the server read link-local metadata and base64 it into the outbound
 *     Cloudflare request body.
 *   - imageGenerationCore's binaryOutput branch fetches `data[0].url` out of the
 *     PROVIDER response -- externally controlled, one step further out.
 *
 * Both funnel through urlToBase64, so the guard belongs there: one reader,
 * SSRF-checked, time-bounded, byte-capped.
 *
 * DNS is mocked so the loopback / metadata / private-range / rebinding cases are
 * deterministic offline.
 */

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

const { urlToBase64, IMAGE_FETCH_MAX_BYTES, IMAGE_FETCH_TIMEOUT_MS } = await import(
  "../../open-sse/handlers/imageProviders/_base.js"
);
const cloudflareAi = (await import("../../open-sse/handlers/imageProviders/cloudflareAi.js")).default;
const { handleImageGenerationCore } = await import("../../open-sse/handlers/imageGenerationCore.js");

const PUBLIC_DNS = [{ address: "203.0.113.10", family: 4 }];

/** A WHATWG stream over the given chunks, so a body can be big without a big Buffer. */
function streamOf(...chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC_DNS);
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("urlToBase64 -- SSRF guard on the shared image reader", () => {
  it("blocks a loopback URL without ever issuing the request", async () => {
    global.fetch = vi.fn();
    await expect(urlToBase64("http://127.0.0.1:9999/secret.png")).rejects.toThrow(/blocked/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks the cloud metadata address", async () => {
    global.fetch = vi.fn();
    await expect(
      urlToBase64("http://169.254.169.254/latest/meta-data/iam/security-credentials/")
    ).rejects.toThrow(/blocked/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks private-range and link-local targets in every notation", async () => {
    global.fetch = vi.fn();
    for (const url of [
      "http://10.0.0.5/x.png",
      "http://172.16.0.1/x.png",
      "http://192.168.1.1/x.png",
      "http://[::1]/x.png",
      "http://[::ffff:169.254.169.254]/x.png",
      "http://localhost./x.png",
    ]) {
      await expect(urlToBase64(url)).rejects.toThrow(/blocked/i);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks a public hostname that only resolves to loopback (DNS rebinding)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    global.fetch = vi.fn();
    await expect(urlToBase64("http://images.attacker.test/x.png")).rejects.toThrow(/blocked/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks a redirect from a public URL into an internal target", async () => {
    global.fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data/" },
    }));

    await expect(urlToBase64("https://cdn.example.test/x.png")).rejects.toThrow(/blocked/i);
    // The redirect was inspected, not followed.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe("https://cdn.example.test/x.png");
  });

  it("caps the body on bytes actually received, not on a self-reported content-length", async () => {
    // A lying content-length is the whole point: it is attacker-controlled and
    // absent entirely on a chunked response.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "1" }),
      body: streamOf("A".repeat(16), "B".repeat(16)),
    }));

    await expect(urlToBase64("https://cdn.example.test/huge.png", { maxBytes: 8 })).rejects.toThrow(
      /too large/i
    );
  });

  it("defaults to a sane byte cap and a request timeout", async () => {
    expect(IMAGE_FETCH_MAX_BYTES).toBeGreaterThan(0);
    expect(IMAGE_FETCH_MAX_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(IMAGE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);

    global.fetch = vi.fn(async () => new Response(Buffer.from("png-bytes")));
    await urlToBase64("https://cdn.example.test/x.png");

    const init = global.fetch.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still reads a public image and returns its base64", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    global.fetch = vi.fn(async () => new Response(bytes));

    await expect(urlToBase64("https://cdn.example.test/x.png")).resolves.toBe(
      bytes.toString("base64")
    );
  });

  it("still surfaces a non-OK upstream status", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(urlToBase64("https://cdn.example.test/missing.png")).rejects.toThrow(/404/);
  });
});

describe("cloudflare-ai -- client-supplied body.image is guarded", () => {
  const MODEL = "@cf/black-forest-labs/flux-1-schnell";

  it("refuses to read the metadata endpoint named in body.image", async () => {
    global.fetch = vi.fn();
    await expect(
      cloudflareAi.buildBody(MODEL, {
        prompt: "a cat",
        image: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      })
    ).rejects.toThrow(/blocked/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a loopback URL in body.image", async () => {
    global.fetch = vi.fn();
    await expect(
      cloudflareAi.buildBody(MODEL, { prompt: "a cat", image: "http://127.0.0.1:8080/admin" })
    ).rejects.toThrow(/blocked/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses an internal URL in the mask field too", async () => {
    global.fetch = vi.fn();
    await expect(
      cloudflareAi.buildBody(MODEL, { prompt: "a cat", mask: "http://10.1.2.3/mask.png" })
    ).rejects.toThrow(/blocked/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still inlines a public image URL", async () => {
    const bytes = Buffer.from("source-image");
    global.fetch = vi.fn(async () => new Response(bytes));

    const req = await cloudflareAi.buildBody(MODEL, {
      prompt: "a cat",
      image: "https://cdn.example.test/src.png",
    });
    expect(req.image_b64).toBe(bytes.toString("base64"));
  });

  it("still accepts inline data URIs and raw base64 without any fetch", async () => {
    global.fetch = vi.fn();
    const b64 = Buffer.from("inline").toString("base64");

    const fromDataUri = await cloudflareAi.buildBody(MODEL, {
      prompt: "a cat",
      image: `data:image/png;base64,${b64}`,
    });
    const fromRaw = await cloudflareAi.buildBody(MODEL, { prompt: "a cat", image: b64 });

    expect(fromDataUri.image_b64).toBe(b64);
    expect(fromRaw.image_b64).toBe(b64);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("imageGenerationCore -- provider-supplied data[0].url is guarded", () => {
  it("does not fetch an internal URL handed back by the provider", async () => {
    // The POST to Cloudflare succeeds and answers with an internal URL where the
    // image supposedly is. binaryOutput would then read it server-side.
    global.fetch = vi.fn(async (url) => {
      if (String(url).startsWith("https://api.cloudflare.com/")) {
        return new Response(
          JSON.stringify({ result: { image: "http://169.254.169.254/latest/meta-data/" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await handleImageGenerationCore({
      body: { prompt: "a cat", model: "cloudflare-ai/@cf/x" },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/x" },
      credentials: { apiKey: "k", providerSpecificData: { accountId: "acct" } },
      binaryOutput: true,
    });

    expect(result.success).toBe(true);
    // Falls back to the JSON envelope rather than inlining internal bytes.
    expect(result.response.headers.get("Content-Type")).toBe("application/json");
    const fetched = global.fetch.mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  it("still inlines bytes from a public provider URL", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    global.fetch = vi.fn(async (url) => {
      if (String(url).startsWith("https://api.cloudflare.com/")) {
        return new Response(
          JSON.stringify({ result: { image: "https://cdn.example.test/out.png" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(bytes);
    });

    const result = await handleImageGenerationCore({
      body: { prompt: "a cat", model: "cloudflare-ai/@cf/x" },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/x" },
      credentials: { apiKey: "k", providerSpecificData: { accountId: "acct" } },
      binaryOutput: true,
    });

    expect(result.response.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(bytes);
  });
});
