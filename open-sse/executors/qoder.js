/**
 * QoderExecutor — sends OpenAI-format chat requests to Qoder's COSY-signed
 * inference endpoint at api3.qoder.sh, then unwraps Qoder's `{statusCodeValue,
 * body}` SSE envelope back into plain OpenAI SSE for the rest of the pipeline.
 *
 * Differences vs the previous placeholder:
 *   - URL is api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *     with `&Encode=1` so we can ship the body through the WAF-bypass
 *     encoder.
 *   - Authentication is COSY (RSA + AES + MD5 + ~17 Cosy-* headers), not
 *     a static HMAC.
 *   - The request shape Qoder expects is non-trivial (chat_context with
 *     mirrored modelConfig, business block with stable IDs, system text
 *     hoisted out of the messages array). All ported from the reference.
 *   - Model identifier is one of the canonical Qoder keys (auto / ultimate /
 *     performance / efficient / lite + frontier "*model" ids); the
 *     translator layer feeds us "qoder/<key>" so we strip the prefix.
 *   - Per-model `model_config` is fetched live from /algo/api/v2/model/list
 *     and cached. Sending the wrong block silently downgrades to a
 *     different model upstream, so a missing entry is a hard error.
 */

import { qoderEncodeBody } from "@/lib/qoder/encoding.js";
import { buildCosyHeaders } from "@/lib/qoder/cosy.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_MAP,
} from "@/lib/qoder/constants.js";
import { CLAUDE_BLOCK, DEFAULT_IMAGE_MIME } from "../translator/schema/index.js";
import { getQoderModelConfig, resolveQoderModels } from "../services/qoderModels.js";

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten multipart content arrays — except image
 * blocks, which are preserved (see normalizeContent).
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    // 0.5.165 — flattening to text dropped every image, so a vision request
    // silently became a text request about an unseen image (upstream 2ab6a4c9).
    cloned.content = normalizeContent(msg.content);
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

/**
 * 0.5.165 — normalize one message's content for Qoder (upstream 2ab6a4c9).
 *
 * Text-only content is still flattened to a plain string (Qoder's historical
 * shape). When images are present the content stays an array and image blocks
 * are kept as OpenAI-style `image_url` parts: the upstream accepts both
 * http(s) URLs and inline base64 data: URIs directly, with no pre-upload to
 * the OSS flow (that is a qodercli client choice, not a protocol rule). The
 * legacy `image_urls` / `chat_context.imageUrls` slots stay null, as qodercli
 * leaves them. Claude-shaped `{type:"image", source:{...}}` blocks are
 * converted so claude-format clients round-trip too.
 */
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);

  const blocks = [];
  const textParts = [];
  let hasImage = false;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "image_url" && typeof item.image_url?.url === "string" && item.image_url.url) {
      blocks.push({ type: "image_url", image_url: { url: item.image_url.url } });
      hasImage = true;
    } else if (item.type === CLAUDE_BLOCK.IMAGE && item.source) {
      const src = item.source;
      const url = src.type === "base64" && src.data
        ? `data:${src.media_type || DEFAULT_IMAGE_MIME};base64,${src.data}`
        : typeof src.url === "string" && src.url ? src.url : null;
      if (url) {
        blocks.push({ type: "image_url", image_url: { url } });
        hasImage = true;
      }
    } else if (typeof item.text === "string" && item.text) {
      // Keep ordering faithful once images are in play.
      if (blocks.length) blocks.push({ type: "text", text: item.text });
      else textParts.push(item.text);
    }
  }

  if (!hasImage) return textParts.join("\n");
  // Prepend any text collected before the first image block.
  if (textParts.length) blocks.unshift({ type: "text", text: textParts.join("\n") });
  return blocks;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    // 0.5.165 — multipart content is an array once images survive
    // normalizeContent, so read its text too (upstream 2ab6a4c9).
    if (Array.isArray(m.content)) return extractText(m.content);
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    } else if (Array.isArray(m.content)) {
      // 0.5.165 — include image refs so the same prompt with a different
      // image gets its own chat_record_id (upstream 2ab6a4c9).
      h.update("\0");
      try { h.update(JSON.stringify(m.content)); } catch { /* unserialisable content contributes nothing */ }
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");
  
  // Fetch model config from dynamic API instead of relying on static QODER_MODEL_MAP.
  // This allows support for new Qoder models (e.g., qmodel_latest) without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { log, proxyOptions, signal });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, log, proxyOptions, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body.messages || []);
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * 0.5.165 — does a Qoder error body carry a billing/quota signature?
 * Codes 110 (daily count exceeded), 112 (quota exhausted), 10605 (queue
 * throttle), or a pricingUrl field (upstream 80afb599 + 2daf25ff).
 */
function isBillingBlock(inner) {
  if (!inner || typeof inner !== "string") return false;
  if (inner.toLowerCase().includes("pricingurl")) return true;
  // Parsed code first: matches numeric or string "110"/"112"/"10605".
  try {
    const code = String(JSON.parse(inner)?.code ?? "");
    if (code === "110" || code === "112" || code === "10605") return true;
  } catch { /* not JSON — fall through to the legacy shape match */ }
  return /"code"\s*:\s*"(112|10605)"/.test(inner);
}

/**
 * 0.5.165 — read the first SSE data line before committing to HTTP 200
 * (upstream 80afb599 + 2daf25ff + 782c137b).
 *
 * Returns `{ isError, isBilling, statusVal, message }` for an error envelope,
 * otherwise `{ isError: false, chunks, upstreamDone }` where `chunks` holds
 * every raw byte read so far so the caller can replay it verbatim. The scan
 * decodes into a scratch decoder that is then discarded: replaying bytes, not
 * text, keeps a multi-byte character split across the boundary intact.
 *
 * Heartbeat comments, `event:` lines and frames fragmented across chunks are
 * skipped or joined rather than mistaken for the first envelope.
 */
async function peekFirstQoderFrame(reader) {
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let offset = 0;
  let upstreamDone = false;

  while (true) {
    let nl = text.indexOf("\n", offset);
    if (nl === -1 && !upstreamDone) {
      const { done, value } = await reader.read();
      upstreamDone = done;
      if (done) {
        text += decoder.decode();
      } else {
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
      }
      continue;
    }
    if (offset >= text.length) return { isError: false, chunks, upstreamDone };
    if (nl === -1) nl = text.length; // last line arrived without a newline

    const line = text.slice(offset, nl).replace(/\r$/, "").trim();
    offset = nl + 1;
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return { isError: false, chunks, upstreamDone };

    let envelope;
    try { envelope = JSON.parse(data); } catch { return { isError: false, chunks, upstreamDone }; }

    const statusVal = envelopeStatus(envelope);
    const inner = envelopeBody(envelope);
    if (statusVal !== 200) {
      return {
        isError: true,
        isBilling: isBillingBlock(inner),
        statusVal,
        message: inner || `upstream status ${statusVal}`,
      };
    }
    return { isError: false, chunks, upstreamDone };
  }
}

// 0.5.165 — statusCodeValue is documented numeric and body a JSON string, but
// Qoder has sent "403" and object bodies; accept both (upstream 2daf25ff).
function envelopeStatus(envelope) {
  const raw = Number(envelope?.statusCodeValue);
  return Number.isNaN(raw) ? 200 : raw;
}

function envelopeBody(envelope) {
  if (typeof envelope?.body === "string") return envelope.body;
  return envelope?.body != null ? JSON.stringify(envelope.body) : "";
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks the rest of the chatCore pipeline understands.
 *
 * Each upstream line looks like:
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`.
 *
 * 0.5.165 — a Qoder error arrives inside an HTTP 200 stream, and turning it
 * into assistant text with finish_reason "stop" made a billing block, a
 * duplicate-request 403 and a 503 all look like a finished completion, so
 * chatCore never locked the connection and failover never fired. The first
 * data line is peeked and errors become real HTTP failures: 403 for a billing
 * block so the account loop treats it as a quota stop, otherwise the upstream
 * status (anything outside 400-599 maps to 502). An error that only appears
 * after streaming started becomes a structured error chunk for billing, and
 * keeps the legacy text chunk otherwise (upstream 80afb599 + 2daf25ff + 782c137b).
 */
async function wrapQoderSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const reader = response.body.getReader();
  const peek = await peekFirstQoderFrame(reader);
  if (peek.isError) {
    // Drop the socket: Qoder keeps it open for keepalives after an error.
    await reader.cancel().catch(() => {});
    const status = peek.isBilling
      ? HTTP_STATUS.FORBIDDEN
      : Number.isInteger(peek.statusVal) && peek.statusVal >= HTTP_STATUS.BAD_REQUEST && peek.statusVal <= 599
        ? peek.statusVal
        : HTTP_STATUS.BAD_GATEWAY;
    return new Response(
      JSON.stringify({ error: { message: peek.message, code: peek.statusVal } }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;

  // Process one already-extracted SSE line (no trailing newline). Returns
  // false when the line indicated end-of-stream so the caller can stop
  // forwarding any remaining chunks after [DONE].
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return; // never forward chunks past stream end

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = envelopeStatus(envelope);
    const inner = envelopeBody(envelope);
    if (statusVal !== 200) {
      if (isBillingBlock(inner)) {
        // 0.5.165 — the peek covers the first frame only. A billing envelope
        // that lands mid-stream becomes a structured error chunk, not fake
        // assistant text: parseSSEToOpenAIResponse turns chunk.error into a
        // non-200 result (status preserved by streamErrorStatus) so the model
        // is locked and the request falls back (upstream 2daf25ff).
        const errObj = JSON.stringify({
          error: {
            message: inner || `qoder billing block (${statusVal})`,
            code: "qoder_billing_block",
            status: HTTP_STATUS.FORBIDDEN,
            type: "quota_error",
          },
        });
        controller.enqueue(encoder.encode(`data: ${errObj}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneEmitted = true;
        return;
      }
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    // Inner is an OpenAI-shaped chunk. Strip any embedded newlines so the
    // SSE frame stays a single event (a literal "\n" inside `inner` would
    // otherwise split the frame across multiple data: lines and downstream
    // parsers would reassemble them as separate events).
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line, controller);
      }
    },
    flush(controller) {
      // Finalize the decoder so any pending multi-byte sequence is
      // released into `buffer` instead of being silently dropped.
      buffer += decoder.decode();
      // Drain any trailing line that arrived without a terminating newline
      // (e.g. upstream closed the socket immediately after the last write,
      // or a CDN stripped the final CRLF). Without this, the chunk that
      // carries finish_reason is silently lost.
      if (buffer.length > 0) {
        processLine(buffer, controller);
        buffer = "";
      }
      if (!doneEmitted) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneEmitted = true;
      }
    },
  });

  // 0.5.165 — `response.body` is locked to the peek's reader now, so feed the
  // transform from a source that replays the peeked bytes first and then pulls
  // the rest of the socket (upstream 80afb599 re-seeds its own read loop; here
  // the TransformStream and its backpressure stay as they were).
  const seeded = new ReadableStream({
    start(controller) {
      for (const chunk of peek.chunks) controller.enqueue(chunk);
      if (peek.upstreamDone) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const transformed = seeded.pipeThrough(transform);
  // Build a Response with passable headers; the streaming handler reads
  // `.body` as a ReadableStream regardless of Content-Type.
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  buildUrl() {
    return QODER_CHAT_URL_ENCODED;
  }

  // Override execute entirely — Qoder needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl();

    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    let qoderKey;
    let payload;
    try {
      ({ qoderKey, payload } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
    const encodedBodyStr = qoderEncodeBody(plainBody);
    const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

    let cosyHeaders;
    try {
      cosyHeaders = buildCosyHeaders(
        encodedBodyBuf,
        url,
        {
          userId: psd.userId,
          authToken: credentials.accessToken,
          name: credentials.displayName || "",
          email: credentials.email || "",
          machineId: psd.machineId || "",
        },
      );
    } catch (err) {
      // cosy.js throws synchronously on missing userId/authToken — surface
      // as 401 so chatCore prompts re-auth instead of returning a 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: `qoder cosy signing failed: ${err.message}` } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const modelSource = (payload.model_config && payload.model_config.source) || "system";
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Model-Key": qoderKey,
      "X-Model-Source": modelSource,
      // gzip triggers signature validation on Qoder's CDN; force identity.
      "Accept-Encoding": "identity",
      ...cosyHeaders,
    };

    // Abort if upstream doesn't return response headers within connect timeout.
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const connectCtrl = new AbortController();
    const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    let response;
    try {
      response = await proxyAwareFetch(
        url,
        { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal },
        // 0.5.165 — a failed proxy attempt may already have reached Qoder.
        // Replaying this body directly reuses its COSY requestId and comes
        // back 403 code 103 "Duplicate request", so mark the call strict: the
        // transport error reaches the account loop, which retries through
        // execute() with a fresh signature. Copy-on-write — the caller's
        // proxyOptions is shared with the rest of the request. strictProxy
        // with nothing configured still goes direct (upstream 782c137b).
        { ...proxyOptions, strictProxy: true },
      );
    } catch (err) {
      // The strict guard wraps transport errors in its own Error; a caller
      // cancellation must still surface as that cancellation.
      if (mergedSignal.aborted) throw mergedSignal.reason;
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      // Pass error response through unchanged so chatCore can capture it.
      return { response, url, headers, transformedBody: payload };
    }

    const wrapped = await wrapQoderSSE(response, `qoder/${qoderKey}`);
    return { response: wrapped, url, headers, transformedBody: payload };
  }

  // Qoder device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderExecutor and use its public methods.
export const __test__ = {
  normalizeMessages,
  wrapQoderSSE,
  buildQoderRequestBody,
  isBillingBlock,
};
