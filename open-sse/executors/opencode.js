import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { applyFingerprintTools, recordRenamedToolNames, restoreToolNamesInResponse, takeRenamedToolNames } from "../utils/opencodeFingerprint.js";
import { resolveOpenCodeGoSeed, toOpenCodeGoResponsesBody } from "./opencode-go.js";
import { responsesToChatResponse } from "../utils/responsesToChatStream.js";

/**
 * OpenCode Free (oc).
 *
 * 0.5.166 (upstream 5bdcd5e7, e964e482) — the free tier moved off /zen/v1 and now
 * gates on the OpenCode v2 CLI's fingerprint. Live probes on 2026-10-18 (the tier is
 * `Bearer public`, so no account is involved) pin down what the gate actually reads:
 *
 *   /zen/v1/chat/completions + `x-opencode-client: desktop`   -> 403 FreeTierError
 *   /inference/v1 + User-Agent opencode/1.18.31               -> 403 FreeTierError
 *   /inference/v1 + v2 UA, no tools                           -> 403 FreeTierError
 *   /inference/v1 + v2 UA, tools renamed to read_file         -> 403 FreeTierError
 *   /inference/v1 + v2 UA, stream:false                       -> 403 FreeTierError
 *   /inference/v1 + v2 UA, x-opencode-session ses_<32 hex>    -> 403 FreeTierError
 *   /inference/v1 + v2 UA, read+shell tools, stream:true      -> 200
 *
 * So: the path, a v2 user-agent, a CLI-shaped `ses_` id whose encoded counter stays
 * small, tools named read and shell, and an upstream stream. Upstream changed this
 * gate three times in three days; the tool half lives in utils/opencodeFingerprint.js
 * so there is one place to move when it changes again.
 */

// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>.
const OPENCODE_UA = "opencode/latest/2.0.26/cli";
const OPENCODE_CLIENT = "cli";
const SESSION_HEADER = "x-opencode-session";
// Per-request, on the credentials copy: the executor is a singleton, so a field on
// `this` would leak one caller's session into a concurrent request.
const SESSION_FIELD = "_opencodeSession";
const MAX_SESSION_LENGTH = 256;
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Models the free tier serves on /inference/v1/responses. The live roster publishes
// muse-spark-1.2 / muse-spark-1.3 (upstream's "-contributor-free" ids are gone), so
// Muse Spark is matched by prefix instead of by id.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
// Claude-protocol models. union-alpha is upstream's only one and is no longer in the
// live roster; big-pickle, which kRouter's old catalog called claude-shaped, answers
// /inference/v1/messages with 400 ModelProtocolUnsupported and is served on chat.
const MESSAGES_MODELS = new Set(["union-alpha"]);
// Muse Spark 1.3 rejects any tool_choice other than auto. Keep this an allowlist:
// widen it only with a live 400 in hand.
const FORCE_AUTO_TOOL_CHOICE = new Set(["muse-spark-1.3", "muse-spark-1.3-contributor-free"]);

// The gate decodes the session prefix as ~(timeMs * 0x1000 + counter) over 48 bits and
// rejects a counter that is not small (probed: 1 passes, 500 is a 403), so the counter
// has to look like a real new-session counter rather than filler.
//
// Upstream also keeps a live counter that it bumps once per minted id, which climbs
// past the limit under any burst inside one millisecond. kRouter never needs that: the
// id is always derived from a seed below, so the counter is always 1.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_TIME_MASK = (1n << 36n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

/** The counter the gate reads back out of a session prefix. Exported for the tests. */
export function decodeSessionCounter(sessionId) {
  const hex = String(sessionId || "").slice(4, 16);
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return Number((~BigInt(`0x${hex}`) & SESSION_PREFIX_MASK) % 0x1000n);
}

/**
 * One stable session id per conversation.
 *
 * The free quota is accounted per session, so a fresh id on every request burns it
 * and comes back as 429 FreeUsageLimitError; the real CLI keeps one id per
 * conversation. Deriving it from a digest gives that for free, with no store to
 * evict: the same seed always yields the same id. The counter is pinned to 1, which
 * is what the CLI sends on a new session.
 */
export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & SESSION_TIME_MASK;
  const timeHex = descendingTimeHex(time, 1);
  let randomPart = "";
  for (let i = 6; i < 20; i++) randomPart += BASE62_CHARS[digest[i] % 62];
  return `ses_${timeHex}${randomPart}`;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function headerSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) return normalizeSession(value);
  }
  return null;
}

// oc needs no credentials, so most requests arrive with no connection id at all.
// resolveOpenCodeGoSeed() falls through to deriveSessionId(), which memoises per
// connection and mints a fresh id when there is none — one upstream session per
// request, which is exactly what exhausts the free quota. A fixed stand-in key makes
// that fallback memoise once per process instead, the same "stable for this launch"
// behaviour deriveSessionId() documents.
const NOAUTH_SEED_KEY = "opencode:noauth";

function resolveOpencodeSession(body, credentials, clientTool) {
  // A client already speaking OpenCode's protocol sends a real id; keep it, so one
  // conversation is not split across two upstream sessions.
  const fromClient = headerSession(credentials?.rawHeaders);
  if (fromClient && OPENCODE_SESSION_RE.test(fromClient)) return fromClient;

  const source = { ...(credentials || {}) };
  if (!source.connectionId && !source.id) source.connectionId = NOAUTH_SEED_KEY;
  return translateSessionId(fromClient || resolveOpenCodeGoSeed(source, body), clientTool);
}

// Strip a "model(level)" thinking suffix so endpoint lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isMuseSparkModel(model) {
  const base = baseModelId(model);
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base.includes("/") ? base.split("/").pop() : base);
}

export function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

export function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}

function lowercaseHeaders(raw) {
  const lower = {};
  for (const [k, v] of Object.entries(raw || {})) lower[k.toLowerCase()] = v;
  return lower;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  // Returns a copy; the caller's credentials object is shared across concurrent
  // requests and is never written.
  prepareRequestCredentials({ body, credentials, clientTool } = {}) {
    const source = credentials || {};
    return { ...source, [SESSION_FIELD]: resolveOpencodeSession(body, source, clientTool) };
  }

  // chatCore asks before translating, so the body shape matches the endpoint.
  resolveTargetFormat(model) {
    return isMessagesModel(model) ? "claude" : "openai";
  }

  transformRequest(model, body, stream, credentials) {
    if (!body || typeof body !== "object") return body;
    if (model && !body.model) body.model = model;

    if (isResponsesModel(model || body.model)) {
      // chatCore hands over an OpenAI chat body (the oc catalog is live-fetched, so
      // no model row can declare a targetFormat); convert it here, the way the
      // opencode-go Responses models already do.
      const responsesBody = toOpenCodeGoResponsesBody(model, body, stream, credentials);
      if (responsesBody.tool_choice !== undefined && responsesBody.tool_choice !== "auto"
        && FORCE_AUTO_TOOL_CHOICE.has(baseModelId(model))) {
        responsesBody.tool_choice = "auto";
      }
      responsesBody.stream = true;
      applyFingerprintTools(responsesBody, "responses");
      return responsesBody;
    }

    // The gate answers stream:false with 403 on every free model, so always stream
    // upstream and let chatCore re-aggregate for a non-streaming client (which is
    // why "opencode" is declared in its providerRequiresStreaming gate).
    body.stream = true;
    const map = applyFingerprintTools(body, isMessagesModel(model) ? "claude" : "chat");
    const out = injectReasoningContent({ provider: this.provider, model, body });
    // injectReasoningContent returns a copy, so re-key the rename map on the body that
    // is actually sent; execute() reads it back off result.transformedBody.
    if (out !== body) recordRenamedToolNames(out, map);
    return out;
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    const result = await super.execute({ ...args, credentials });
    if (!result?.response?.ok) return result;

    // Put the caller's own tool name back before anything downstream reads the
    // stream; kRouter's same-format path never reaches a translator.
    let response = restoreToolNamesInResponse(result.response, takeRenamedToolNames(result.transformedBody));
    // A Responses upstream answered in Responses SSE; hand chatCore chat-completion SSE.
    if (isResponsesModel(args.model)) {
      response = responsesToChatResponse(response, { model: args.model, stream: args.stream });
    }
    return response === result.response ? result : { ...result, response };
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/inference/v1/responses`;
    if (isMessagesModel(model)) return `${base}/inference/v1/messages`;
    return `${base}/inference/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const lower = lowercaseHeaders(credentials?.rawHeaders);
    const downstreamUa = lower["user-agent"] || "";
    const session = credentials?.[SESSION_FIELD]
      || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    // Mirrors the v2 CLI. The gate wants x-opencode-session-id next to
    // x-opencode-session, and x-opencode-request was a v1-only header.
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": hasValidOpencodeVersion(downstreamUa) ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (String(url).endsWith("/messages")) headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
}
