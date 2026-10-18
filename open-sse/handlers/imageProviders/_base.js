// Shared helpers for image provider adapters

import { fetchPublic } from "@/shared/utils/ssrfGuard.js";

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

// Bounds for reading an image from a URL. Both callers of urlToBase64 hand it a
// URL they did not choose -- cloudflare-ai takes body.image straight off the
// client request, imageGenerationCore takes data[0].url out of a provider
// response -- so the read needs a wall clock and a ceiling, not just a guard.
export const IMAGE_FETCH_TIMEOUT_MS = 15000;
export const IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;

// A status poll is a small JSON document, so it gets a much tighter ceiling than
// an image read.
export const POLL_REQUEST_TIMEOUT_MS = 15000;
export const POLL_MAX_BYTES = 1024 * 1024;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Read a response body, counting the bytes that actually arrive. content-length
// is not a limit -- it is a claim by whoever is on the other end, and it is
// absent entirely on a chunked response -- so the cap is enforced on the stream
// and the stream is cancelled the moment it is exceeded.
async function readCapped(res, maxBytes) {
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`Image too large: exceeds ${maxBytes} bytes`);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Image too large: exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

// Fetch URL → base64 (for providers returning image URLs, and for a
// client-supplied source image).
//
// fetchPublic, not fetch: the URL is externally controlled, so without the guard
// this reads whatever the caller names -- `"image": "http://169.254.169.254/..."`
// had the server pull cloud-metadata credentials and base64 them into the
// outbound provider request. fetchPublic re-validates every redirect hop too,
// which a one-shot check before a redirect:"follow" fetch would not.
export async function urlToBase64(url, { maxBytes = IMAGE_FETCH_MAX_BYTES } = {}) {
  const res = await fetchPublic(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  return (await readCapped(res, maxBytes)).toString("base64");
}

// Poll a provider's job-status URL.
//
// On the async adapters this URL comes out of the provider's own submit response
// (fal's status_url/response_url, BFL's polling_url) and the request carries that
// provider's credential -- so an unvalidated URL, or an unvalidated redirect off a
// legitimate one, hands the key to whatever host the response named. That is a
// credential leak, not just a blind internal read, which is why even the adapters
// whose host is fixed (runwayml, nanobanana) poll through here: fetchPublic
// re-validates every hop instead of following it.
//
// `label` keeps each adapter's own error wording ("Fal status 500").
export async function pollJson(url, { headers, label, maxBytes = POLL_MAX_BYTES }) {
  const res = await fetchPublic(url, {
    headers,
    signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${label} status ${res.status}`);
  return JSON.parse((await readCapped(res, maxBytes)).toString("utf8"));
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
