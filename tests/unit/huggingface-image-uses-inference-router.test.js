/**
 * HuggingFace image generation goes through the Inference Providers router.
 *
 * The legacy host `api-inference.huggingface.co` no longer resolves (DNS
 * ENOTFOUND, verified 2026-10-18), so every HuggingFace image request died at
 * the fetch layer with a bare network error. The replacement is
 * `router.huggingface.co`, addressed as `<base>/<provider>/<providerModelId>`
 * — and the provider-resolved id is NOT the Hub model id, so the adapter has to
 * map it.
 *
 * Driven through `handleImageGenerationCore` (the same function the
 * `/v1/images/generations` route calls) so the whole seam is exercised:
 * buildUrl / buildBody / buildHeaders, the fetch, and the binary parse.
 *
 * Ports upstream cf663f53 (tests/unit/huggingface-router-migration.test.js and
 * huggingface-image-end-to-end.test.js), adapted: kRouter has no
 * `open-sse/providers/registry/` and no `PROVIDER_MEDIA`, so the Hub-id map
 * lives in the adapter and is asserted there.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "node:dns";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import imageAdapter, {
  HF_ROUTER_BASE_URL,
  HF_ROUTER_MODEL_MAP,
} from "../../open-sse/handlers/imageProviders/huggingface.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";

const DEAD_HOST = "api-inference.huggingface.co";
const LIVE_ROUTER = "router.huggingface.co";

// Providers the router actually forwards to. replicate / wavespeed / deepinfra
// appear in the Hub's inferenceProviderMapping but reject router traffic with
// "Model not supported by provider <name>", so they must not be used here.
const ROUTABLE_PROVIDERS = new Set(["fal-ai", "hf-inference", "nscale", "together", "novita", "hyperbolic"]);

const mappingPath = (value) => (typeof value === "string" ? value : value.path);

// A 1x1 transparent PNG — enough to prove the bytes survive the round trip.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const originalFetch = global.fetch;

function binaryResponse() {
  return new Response(PNG_1X1, { status: 200, headers: { "Content-Type": "image/png" } });
}

async function generate(body, model, credentials = { apiKey: "hf_test_token" }) {
  return handleImageGenerationCore({ body, modelInfo: { provider: "huggingface", model }, credentials, log: null });
}

describe("HuggingFace image adapter — legacy host removal", () => {
  it("does not reference the dead api-inference host", () => {
    expect(HF_ROUTER_BASE_URL).not.toContain(DEAD_HOST);
  });

  it("points the base URL at the live router host", () => {
    expect(HF_ROUTER_BASE_URL).toContain(LIVE_ROUTER);
  });
});

describe("HuggingFace image URL builder", () => {
  it("routes FLUX.1-schnell through its fal-ai provider id", () => {
    expect(imageAdapter.buildUrl("black-forest-labs/FLUX.1-schnell")).toBe(
      "https://router.huggingface.co/fal-ai/fal-ai/flux/schnell"
    );
  });

  it("routes SDXL through its fal-ai provider id", () => {
    expect(imageAdapter.buildUrl("stabilityai/stable-diffusion-xl-base-1.0")).toBe(
      "https://router.huggingface.co/fal-ai/fal-ai/fast-sdxl"
    );
  });

  it("throws a descriptive error for a model with no router mapping", () => {
    expect(() => imageAdapter.buildUrl("some-org/not-mapped-model")).toThrow(/no HuggingFace router mapping/i);
  });

  it("does not resolve inherited Object.prototype keys as mappings", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      expect(() => imageAdapter.buildUrl(key), key).toThrow(/no HuggingFace router mapping/i);
    }
  });

  it("lets a connection override the endpoint for a self-hosted model", () => {
    const creds = { providerSpecificData: { baseUrl: "https://tgi.internal/" } };

    expect(imageAdapter.buildUrl("my-org/my-tgi-model", creds)).toBe("https://tgi.internal/my-org/my-tgi-model");
  });

  it("does not apply the router mapping when a custom endpoint is set", () => {
    const creds = { providerSpecificData: { baseUrl: "https://tgi.internal" } };

    // The custom endpoint knows its own model ids — the Hub id passes through verbatim.
    expect(imageAdapter.buildUrl("black-forest-labs/FLUX.1-schnell", creds)).toBe(
      "https://tgi.internal/black-forest-labs/FLUX.1-schnell"
    );
  });

  it("ignores a blank custom endpoint", () => {
    const creds = { providerSpecificData: { baseUrl: "   " } };

    expect(imageAdapter.buildUrl("black-forest-labs/FLUX.1-schnell", creds)).toBe(
      "https://router.huggingface.co/fal-ai/fal-ai/flux/schnell"
    );
  });

  it("rejects traversal or query injection in the model id on a custom endpoint", () => {
    const creds = { providerSpecificData: { baseUrl: "https://tgi.internal" } };

    for (const model of ["x/../../admin", "org//model", "model?x=1", "model#f"]) {
      expect(() => imageAdapter.buildUrl(model, creds), model).toThrow(/invalid model ID/i);
    }
  });
});

describe("HuggingFace router model map", () => {
  it("maps every huggingface image model in the catalog", () => {
    const imageModels = getModelsByProviderId("huggingface").filter((m) => m.type === "image");

    expect(imageModels.length).toBeGreaterThan(0);
    for (const model of imageModels) {
      expect(
        Object.hasOwn(HF_ROUTER_MODEL_MAP, model.id),
        `catalog model ${model.id} has no HF_ROUTER_MODEL_MAP entry`
      ).toBe(true);
    }
  });

  it("points every entry at a provider the router forwards to", () => {
    for (const [hubId, value] of Object.entries(HF_ROUTER_MODEL_MAP)) {
      const provider = String(mappingPath(value)).split("/")[0];
      expect(ROUTABLE_PROVIDERS.has(provider), `${hubId} -> unsupported provider ${provider}`).toBe(true);
    }
  });

  it("gives every entry a provider/model path shape", () => {
    for (const [hubId, value] of Object.entries(HF_ROUTER_MODEL_MAP)) {
      expect(String(mappingPath(value)), `${hubId} has a malformed target`).toMatch(
        /^[a-z0-9-]+\/[A-Za-z0-9._/-]+$/
      );
    }
  });
});

describe("HuggingFace image generation — end to end", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(binaryResponse());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts a text-to-image request to the fal-ai router path", async () => {
    const result = await generate({ prompt: "a lighthouse at dusk" }, "black-forest-labs/FLUX.1-schnell");

    expect(result.success).toBe(true);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://router.huggingface.co/fal-ai/fal-ai/flux/schnell");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ inputs: "a lighthouse at dusk" });
  });

  it("never touches the dead api-inference host", async () => {
    await generate({ prompt: "x" }, "black-forest-labs/FLUX.1-schnell");

    expect(global.fetch.mock.calls[0][0]).not.toContain(DEAD_HOST);
  });

  it("authenticates with the connection's API key", async () => {
    await generate({ prompt: "x" }, "black-forest-labs/FLUX.1-schnell");

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer hf_test_token");
  });

  it("posts an image-to-image request with the source image in inputs", async () => {
    const result = await generate(
      { prompt: "make it snow", image: "data:image/png;base64,AAAB" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(true);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit");
    // The router takes raw base64 in inputs and the prompt under parameters —
    // the data-URL prefix must be stripped, not forwarded.
    expect(JSON.parse(init.body)).toEqual({ inputs: "AAAB", parameters: { prompt: "make it snow" } });
  });

  it("accepts the source image from the images array", async () => {
    await generate({ prompt: "p", images: ["data:image/png;base64,ZZZZ"] }, "Qwen/Qwen-Image-Edit");

    expect(JSON.parse(global.fetch.mock.calls[0][1].body).inputs).toBe("ZZZZ");
  });

  it("rejects an image-to-image model that was given no source image", async () => {
    const result = await generate({ prompt: "make it snow" }, "Qwen/Qwen-Image-Edit");

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/requires a source image/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a model with no router mapping before calling upstream", async () => {
    const result = await generate({ prompt: "x" }, "some-org/unmapped-model");

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/no HuggingFace router mapping/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the generated image as base64 to the client", async () => {
    const result = await generate({ prompt: "x" }, "black-forest-labs/FLUX.1-schnell");

    const payload = await result.response.json();
    expect(payload.data[0].b64_json).toBe(PNG_1X1.toString("base64"));
  });

  it("routes a self-hosted connection to its own endpoint", async () => {
    await generate({ prompt: "x" }, "my-org/my-tgi-model", {
      apiKey: "k",
      providerSpecificData: { baseUrl: "https://tgi.internal" },
    });

    expect(global.fetch.mock.calls[0][0]).toBe("https://tgi.internal/my-org/my-tgi-model");
  });
});

/**
 * The image-to-image branch fetches a client-supplied URL server-side, which is
 * an SSRF vector: `"image": "http://169.254.169.254/latest/meta-data/..."` makes
 * kRouter read a link-local metadata endpoint and base64 the reply into the
 * payload it POSTs to HuggingFace — read access to anything the host can reach,
 * with exfiltration. Reproduced against a local stand-in service before the fix:
 * `buildBody` hit `127.0.0.1:<port>` and emitted the body in `inputs`.
 *
 * kRouter already treats unguarded client-URL fetches as a shipped vulnerability
 * class (`src/shared/utils/ssrfGuard.js`, `tests/unit/ssrf-callsites-wired.test.js`),
 * so this call site has to go through the same guard. `assertPublicUrl` is not
 * enough — it cannot see a hostname that merely *resolves* into private space,
 * and plain `fetch` follows redirects with only the first hop checked.
 *
 * DNS is stubbed rather than resolved so these cases are deterministic offline.
 */
describe("HuggingFace image-to-image source URL — SSRF guard", () => {
  const PUBLIC_IMAGE = Buffer.from("public-image-bytes");

  beforeEach(() => {
    // A factory, not a single Response: a body can only be read once, and these
    // cases can issue two fetches (source image, then the router).
    global.fetch = vi.fn().mockImplementation(async () => binaryResponse());
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects a source image URL on the loopback interface", async () => {
    const result = await generate(
      { prompt: "p", image: "http://127.0.0.1:8080/admin/keys" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a source image URL on the cloud metadata address", async () => {
    const result = await generate(
      { prompt: "p", image: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects source image URLs across the private ranges and localhost", async () => {
    for (const image of [
      "http://localhost/x.png",
      "http://10.0.0.5/x.png",
      "http://192.168.1.1/x.png",
      "http://172.16.0.1/x.png",
      "http://[::1]/x.png",
      "http://0.0.0.0/x.png",
    ]) {
      const result = await generate({ prompt: "p", image }, "Qwen/Qwen-Image-Edit");

      expect(result.success, image).toBe(false);
      expect(result.status, image).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a public hostname that resolves into private space", async () => {
    // The DNS-rebinding class the literal-only check cannot see: the hostname is
    // public, its A record is not.
    dns.promises.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const result = await generate(
      { prompt: "p", image: "https://images.example.com/cat.png" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not follow a redirect from a public URL into private space", async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("images.example.com")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      return new Response(PUBLIC_IMAGE, { status: 200, headers: { "Content-Type": "image/png" } });
    });

    const result = await generate(
      { prompt: "p", image: "https://images.example.com/cat.png" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    // The first hop is allowed; the metadata hop must never be requested.
    const requested = global.fetch.mock.calls.map(([u]) => String(u));
    expect(requested.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  it("rejects a source image larger than the cap instead of buffering it", async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("images.example.com")) {
        return new Response(Buffer.alloc(20 * 1024 * 1024, 1), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return binaryResponse();
    });

    const result = await generate(
      { prompt: "p", image: "https://images.example.com/huge.png" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/too large/i);
  });

  it("still fetches a public source image URL and forwards its bytes", async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("images.example.com")) {
        return new Response(PUBLIC_IMAGE, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      return binaryResponse();
    });

    const result = await generate(
      { prompt: "make it snow", image: "https://images.example.com/cat.png" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(true);

    const routerCall = global.fetch.mock.calls.find(([u]) => String(u).includes("router.huggingface.co"));
    expect(JSON.parse(routerCall[1].body)).toEqual({
      inputs: PUBLIC_IMAGE.toString("base64"),
      parameters: { prompt: "make it snow" },
    });
  });

  it("bounds how long a source image fetch may hang", async () => {
    let seenSignal;
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("images.example.com")) {
        seenSignal = init?.signal;
        return new Response(PUBLIC_IMAGE, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      return binaryResponse();
    });

    await generate({ prompt: "p", image: "https://images.example.com/cat.png" }, "Qwen/Qwen-Image-Edit");

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("reports an unreachable source image URL as a bad request, not a 500", async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("images.example.com")) throw new Error("ECONNREFUSED");
      return binaryResponse();
    });

    const result = await generate(
      { prompt: "p", image: "https://images.example.com/cat.png" },
      "Qwen/Qwen-Image-Edit"
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/source image/i);
  });

  it("does not fetch anything for a data-URL or bare base64 source image", async () => {
    await generate({ prompt: "p", image: "data:image/png;base64,AAAB" }, "Qwen/Qwen-Image-Edit");

    const requested = global.fetch.mock.calls.map(([u]) => String(u));
    expect(requested).toEqual(["https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit"]);
  });
});
