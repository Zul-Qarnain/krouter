// HuggingFace Inference Providers router — returns binary image
//
// 0.5.166 — the legacy `api-inference.huggingface.co` host no longer resolves
// (DNS ENOTFOUND), so every HuggingFace image request died at the fetch layer.
// The replacement is the Inference Providers router, a switchboard in front of
// many inference providers addressed as `<base>/<provider>/<providerModelId>`.
// `providerModelId` is the id the *provider* uses, which is NOT the Hub model
// id, so it has to be resolved. Upstream keeps that table in a provider
// registry (`imageConfig.modelMap`); kRouter has no `providers/registry/` and
// no `PROVIDER_MEDIA`, so it lives here next to the only code that reads it.
// (upstream cf663f53)
import { nowSec } from "./_base.js";
import { fetchPublic } from "@/shared/utils/ssrfGuard.js";

export const HF_ROUTER_BASE_URL = "https://router.huggingface.co";

// Hub model id -> router path. A plain string is the provider path
// (text-to-image). `{ path, task: "image-to-image" }` marks a model whose
// payload differs: the source image goes in `inputs` and the prompt moves under
// `parameters.prompt` — see https://huggingface.co/docs/inference-providers/tasks/image-to-image
//
// Only providers the router actually forwards to are listed: replicate,
// wavespeed and deepinfra appear in the Hub's inferenceProviderMapping but
// reject router traffic with "Model not supported by provider <name>".
//
// Entries are kept for every id upstream serves, not only the ids in kRouter's
// current catalog, so adding a model to `providerModels.js` needs no change here.
// `getModelInfoCore` does no catalog check, so an id that is mapped but not
// catalogued is reachable — which is what upstream intends, and the only extra
// branch it unlocks (image-to-image) fetches its source image through
// `fetchPublic` below, so reach does not mean an unguarded server-side fetch.
export const HF_ROUTER_MODEL_MAP = Object.freeze({
  "black-forest-labs/FLUX.1-schnell": "fal-ai/fal-ai/flux/schnell",
  "black-forest-labs/FLUX.1-dev": "fal-ai/fal-ai/flux/dev",
  "black-forest-labs/FLUX.1-Krea-dev": "fal-ai/fal-ai/flux/krea",
  "black-forest-labs/FLUX.1-Kontext-dev": { path: "fal-ai/fal-ai/flux-kontext/dev", task: "image-to-image" },
  "black-forest-labs/FLUX.2-dev": { path: "fal-ai/fal-ai/flux-2/edit", task: "image-to-image" },
  "black-forest-labs/FLUX.2-klein-9B": { path: "fal-ai/fal-ai/flux-2/klein/9b/edit", task: "image-to-image" },
  "black-forest-labs/FLUX.2-klein-4B": { path: "fal-ai/fal-ai/flux-2/klein/4b/distilled/edit", task: "image-to-image" },
  "black-forest-labs/FLUX.2-klein-base-9B": { path: "fal-ai/fal-ai/flux-2/klein/9b/base/edit", task: "image-to-image" },
  "black-forest-labs/FLUX.2-klein-base-4B": { path: "fal-ai/fal-ai/flux-2/klein/4b/base/edit", task: "image-to-image" },
  "stabilityai/stable-diffusion-xl-base-1.0": "fal-ai/fal-ai/fast-sdxl",
  "stabilityai/stable-diffusion-3.5-large": "fal-ai/fal-ai/stable-diffusion-v35-large",
  "stabilityai/stable-diffusion-3.5-large-turbo": "fal-ai/fal-ai/stable-diffusion-v35-large/turbo",
  "Qwen/Qwen-Image": "fal-ai/fal-ai/qwen-image",
  "Qwen/Qwen-Image-2512": "fal-ai/fal-ai/qwen-image-2512",
  "Qwen/Qwen-Image-Edit": { path: "fal-ai/fal-ai/qwen-image-edit", task: "image-to-image" },
  "Qwen/Qwen-Image-Edit-2509": { path: "fal-ai/fal-ai/qwen-image-edit-2509", task: "image-to-image" },
  "Qwen/Qwen-Image-Edit-2511": { path: "fal-ai/fal-ai/qwen-image-edit-plus", task: "image-to-image" },
  "ideogram-ai/ideogram-4-fp8": "fal-ai/ideogram/v4",
  "tencent/HunyuanImage-3.0": "fal-ai/fal-ai/hunyuan-image/v3/text-to-image",
  "Tongyi-MAI/Z-Image-Turbo": "fal-ai/fal-ai/z-image/turbo",
  "krea/Krea-2-Turbo": "fal-ai/fal-ai/krea-2/turbo",
  "HiDream-ai/HiDream-I1-Fast": "fal-ai/fal-ai/hidream-i1-fast",
  "playgroundai/playground-v2.5-1024px-aesthetic": "fal-ai/fal-ai/playground-v25",
});

// A plain-object lookup returns inherited truthy values for keys like
// "toString" or "constructor", which would build nonsense URLs. Own keys only.
const lookup = (model) => (Object.hasOwn(HF_ROUTER_MODEL_MAP, model) ? HF_ROUTER_MODEL_MAP[model] : undefined);

const mappingPath = (entry) => (typeof entry === "string" ? entry : entry.path);
const mappingTask = (entry) => (typeof entry === "string" ? "text-to-image" : entry?.task || "text-to-image");

// A connection may point at its own endpoint (self-hosted Text Generation
// Inference container). That endpoint already knows its own model ids, so the
// router mapping does not apply and the Hub id is passed through verbatim.
function customBaseUrl(creds) {
  const url = creds?.providerSpecificData?.baseUrl;
  return typeof url === "string" && url.trim() ? url.trim().replace(/\/+$/, "") : null;
}

// 0.5.166 — a source-image URL is client-supplied and fetched by the server, so
// it is an SSRF vector: `"image": "http://169.254.169.254/latest/meta-data/..."`
// would make kRouter read a link-local metadata endpoint and base64 the reply
// into the payload it POSTs to HuggingFace — read access to anything the host
// can reach, plus exfiltration. `_base.js`'s `urlToBase64` is a bare `fetch`
// with no guard, no bound and `redirect: "follow"`, so this path uses
// `fetchPublic` instead: it blocks private/loopback/link-local targets, rejects
// a public hostname that only *resolves* into private space, and re-validates
// every redirect hop. Size and time are bounded here because a source image is
// buffered whole into the outbound request.
const SOURCE_IMAGE_TIMEOUT_MS = 15_000;
const SOURCE_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

// Read the body with a hard byte cap. Content-length is only a hint — it can be
// absent on a chunked response or simply lie — so the cap is enforced on the
// bytes actually received and the stream is cancelled the moment it is crossed.
async function readCapped(response, url) {
  const tooLarge = () =>
    new Error(`HuggingFace: source image at "${url}" is too large (limit ${SOURCE_IMAGE_MAX_BYTES} bytes)`);

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SOURCE_IMAGE_MAX_BYTES) throw tooLarge();

  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > SOURCE_IMAGE_MAX_BYTES) throw tooLarge();
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SOURCE_IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchSourceImage(url) {
  let response;
  try {
    response = await fetchPublic(url, { signal: AbortSignal.timeout(SOURCE_IMAGE_TIMEOUT_MS) });
  } catch (error) {
    // Blocked target, DNS failure, timeout and connection refused all mean the
    // client gave an image we will not or cannot read: a 400, never a 500.
    throw new Error(`HuggingFace: cannot read source image at "${url}": ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`HuggingFace: source image at "${url}" returned HTTP ${response.status}`);
  }
  return (await readCapped(response, url)).toString("base64");
}

// The router's image-to-image payload wants raw base64 — not a data URL, not a
// URL. Accept every shape kRouter's own callers use (data URL, bare base64,
// remote URL, array).
async function sourceImage(body) {
  const raw = body?.image || (Array.isArray(body?.images) ? body.images[0] : null);
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return await fetchSourceImage(value);
  const match = /^data:image\/[^;]+;base64,(.+)$/i.exec(value);
  return match ? match[1] : value;
}

export default {
  buildUrl: (model, creds) => {
    const override = customBaseUrl(creds);
    if (override) {
      // The model id is client-controlled; on a custom endpoint it lands in a
      // URL path verbatim, so reject traversal and query injection (the same
      // guard sttCore applies to the HuggingFace ASR route).
      if (model.includes("..") || model.includes("//") || /[?#]/.test(model)) {
        throw new Error(`HuggingFace: invalid model ID "${model}"`);
      }
      return `${override}/${model}`;
    }

    const entry = lookup(model);
    if (!entry) {
      throw new Error(
        `HuggingFace: no HuggingFace router mapping for model "${model}". ` +
          `Add it to HF_ROUTER_MODEL_MAP in open-sse/handlers/imageProviders/huggingface.js, ` +
          `or set a custom base URL on the connection.`
      );
    }
    return `${HF_ROUTER_BASE_URL}/${mappingPath(entry)}`;
  },
  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    return headers;
  },
  buildBody: async (model, body) => {
    if (mappingTask(lookup(model)) === "image-to-image") {
      const image = await sourceImage(body);
      if (!image) {
        throw new Error(
          `HuggingFace: model "${model}" requires a source image. ` +
            `Send it as "image" (or "images") in the request body.`
        );
      }
      // inputs carries the source image; the prompt moves under parameters.
      return { inputs: image, parameters: { prompt: body.prompt } };
    }

    return { inputs: body.prompt };
  },
  // HF returns raw image bytes — convert to b64_json
  async parseResponse(response) {
    const buf = await response.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    return { created: nowSec(), data: [{ b64_json: base64 }] };
  },
  normalize: (responseBody) => responseBody,
};
