// Self-healing image-capability detector (added 0.5.22).
//
// Why this exists:
//   Some upstream models (Kiro's amazon.nova-micro, NVIDIA's deepseek-v4-flash,
//   qwen3-next-80b text-only variants, etc.) reject any request that contains
//   an image with a 400 error. We used to forward the request, eat the 400,
//   exhaust all accounts, and fail the user.
//
// How this works (one-shot detection + cached strip):
//   1. First request to model X with images → forwarded as-is.
//   2. If upstream replies with a known "no image support" 400 pattern,
//      we record (provider, model) → noImageSupport in a TTL'd in-memory cache.
//   3. The executor retries the SAME account with images stripped → 200 OK.
//   4. Next request to model X within TTL → strip images BEFORE sending,
//      zero extra round-trips.
//   5. After TTL expires (1h), the cache forgets and we re-detect — useful
//      because vendors quietly ship vision support to existing models.
//
// What we recognize as "no image support":
//   - Kiro: "IMAGE_FORMAT_UNSUPPORTED" or "image content block" in body
//   - NVIDIA / OpenAI-style: "multimodal processing is not enabled"
//   - OpenAI: "messages.*.content must be a string" (some text-only models)
//   - Generic substring: "does not support image"
//
// What gets stripped (format-aware):
//   - Claude messages format: content[].type === "image" → removed
//   - OpenAI chat format: content[].type === "image_url" → removed
//   - Gemini contents format: parts[].inlineData / parts[].fileData → removed
//   - Message-level msg.images[] and image attachments (Ollama/Hermes,
//     Vercel AI SDK) → removed (0.5.166)
//   - If a message becomes empty after stripping, it's replaced with a tiny
//     marker so the upstream doesn't 400 on empty content.

const TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map(); // key: "provider/model" → expiresAtMs

function key(provider, model) {
  return `${provider}/${model}`;
}

export function hasNoImageSupport(provider, model) {
  const k = key(provider, model);
  const expiry = cache.get(k);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    cache.delete(k);
    return false;
  }
  return true;
}

export function markNoImageSupport(provider, model) {
  if (!provider || !model) return;
  cache.set(key(provider, model), Date.now() + TTL_MS);
}

export function clearImageCapabilityCache() {
  cache.clear();
}

// Inspect an upstream error body and decide if it's the "no image support"
// kind. Returns true ONLY for high-confidence signals — generic 400s should
// not poison the cache.
export function isImageRejectionError(status, bodyText) {
  if (status !== 400) return false;
  if (!bodyText || typeof bodyText !== "string") return false;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("image_format_unsupported") ||
    lower.includes("multimodal processing is not enabled") ||
    lower.includes("does not support the image content") ||
    lower.includes("does not support image") ||
    // OpenAI-style: 'messages.0.content' must be a string when the model is text-only
    /messages\.\d+\.content.*must be a string/.test(lower) ||
    // OpenCode-via-DeepSeek (added 0.5.24): Rust serde deserializer rejects
    // the image_url variant on text-only DeepSeek models with:
    //   "Failed to deserialize the JSON body into the target type:
    //    messages[11]: unknown variant `image_url`, expected `text`"
    /unknown variant.*image_url.*expected.*text/.test(lower)
  );
}

// Strip images from a request body, preserving text. Detects body shape
// (Claude / OpenAI / Gemini) automatically.
export function stripImagesFromBody(body) {
  if (!body || typeof body !== "object") return body;

  // Gemini / Antigravity shape: { contents: [{ role, parts: [...] }] }
  // OR Antigravity envelope: { request: { contents: [...] } }
  if (Array.isArray(body.contents)) {
    return { ...body, contents: stripGeminiContents(body.contents) };
  }
  if (body.request && Array.isArray(body.request.contents)) {
    return {
      ...body,
      request: { ...body.request, contents: stripGeminiContents(body.request.contents) },
    };
  }

  // Claude / OpenAI shape: { messages: [...] }
  if (Array.isArray(body.messages)) {
    return { ...body, messages: stripMessages(body.messages) };
  }

  return body;
}

function stripGeminiContents(contents) {
  return contents.map(turn => {
    if (!turn || !Array.isArray(turn.parts)) return turn;
    const filtered = turn.parts.filter(p => !p?.inlineData && !p?.fileData);
    // Don't leave a turn with zero parts — Gemini 400s on that.
    if (filtered.length === 0) {
      return { ...turn, parts: [{ text: "[image omitted: model does not support vision]" }] };
    }
    return { ...turn, parts: filtered };
  });
}

const OMITTED_MARKER = "[image omitted: model does not support vision]";

function isImageAttachment(att) {
  if (!att || typeof att !== "object") return false;
  const mime = att.contentType || att.mediaType;
  if (typeof mime === "string" && mime.startsWith("image/")) return true;
  return typeof att.url === "string" && att.url.startsWith("data:image/");
}

// 0.5.166 — Ollama/Hermes `images[]` and Vercel-AI-SDK image attachments ride
// beside content, so filtering content blocks alone still sent the image to a
// text-only model (upstream 345cdcf6, strip half). Returns a new message, or the
// same one when there is nothing to drop.
function stripSideImages(msg) {
  let out = msg;
  if (Array.isArray(msg.images)) {
    const { images: _dropped, ...rest } = msg;
    out = rest;
  }
  for (const field of ["experimental_attachments", "attachments"]) {
    if (!Array.isArray(out[field])) continue;
    const kept = out[field].filter(a => !isImageAttachment(a));
    if (kept.length !== out[field].length) out = { ...out, [field]: kept };
  }
  if (out === msg) return msg;
  // Don't leave an image-only turn with empty content — upstreams 400 on that.
  if (out.content === undefined || out.content === null || out.content === "") {
    return { ...out, content: OMITTED_MARKER };
  }
  return out;
}

function stripMessages(messages) {
  return messages.map(original => {
    const msg = original && typeof original === "object" ? stripSideImages(original) : original;
    if (!msg || msg.content === undefined || msg.content === null) return msg;
    // String content is already text-only — keep as-is.
    if (typeof msg.content === "string") return msg;
    // Array content (Claude/OpenAI mixed multimodal): drop image blocks.
    if (Array.isArray(msg.content)) {
      const filtered = msg.content.filter(part => {
        if (!part || typeof part !== "object") return true;
        // Claude: { type: "image", source: {...} }
        if (part.type === "image") return false;
        // OpenAI: { type: "image_url", image_url: {...} }
        if (part.type === "image_url") return false;
        // Anthropic input_image / OpenAI multimodal variants
        if (part.type === "input_image") return false;
        return true;
      });
      if (filtered.length === 0) {
        return { ...msg, content: OMITTED_MARKER };
      }
      // If only one text block remains, simplify to string for older parsers.
      if (filtered.length === 1 && filtered[0].type === "text") {
        return { ...msg, content: filtered[0].text };
      }
      return { ...msg, content: filtered };
    }
    return msg;
  });
}
