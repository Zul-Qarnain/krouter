import { createHash } from "crypto";
import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS, CODEX_CLI_VERSION } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/helpers/responsesApiHelper.js";
import { fetchImageAsBase64 } from "../translator/helpers/imageHelper.js";
import { getModelUpstreamId, getProviderModels } from "../config/providerModels.js";
import { getConsistentMachineId } from "../../src/shared/utils/machineId.js";
import { DEFAULT_RETRY_CONFIG, resolveRetryEntry } from "../config/runtimeConfig.js";
import { dbg } from "../utils/debugLog.js";
import { stripCodexUnsupportedPatterns } from "../utils/codexToolSchema.js";

// SSE error patterns inside 200-OK body that should trigger retry as if 503
const CODEX_SSE_OVERLOADED_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const CODEX_SSE_PEEK_BYTES = 4096;

// In-memory map: hash(machineId + first assistant content) → { sessionId, lastUsed }
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const assistantSessionMap = new Map();

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// 0.5.165 — "Responses Lite": the request shape Codex 0.155 introduced for the
// GPT-6 Sol/Luna family (upstream 95600db1). Those models are served behind an
// internal header and want tools plus instructions as input prefix items instead
// of top-level fields. Which ids need it is catalog data, so a new release only
// has to set responsesLite there.
const CODEX_LITE_EFFORT_FLOOR = "low";
const CODEX_LITE_UNSUPPORTED_EFFORTS = new Set(["none", "minimal", "off"]);

function isCodexResponsesLiteModel(model) {
  if (typeof model !== "string" || !model) return false;
  return getProviderModels("cx").some((entry) => entry.id === model && entry.responsesLite === true);
}

function hasHostedWebSearch(tools) {
  return Array.isArray(tools) && tools.some((tool) => tool?.type === "web_search");
}

function toolIdentity(tool) {
  return `${tool?.type}:${tool?.name || tool?.function?.name || ""}`;
}

// Lite only accepts low..max, so the levels the legacy transport allows for
// reasoning-off have to be lifted instead of rejected upstream.
function clampLiteEffort(effort) {
  return CODEX_LITE_UNSUPPORTED_EFFORTS.has(effort) ? CODEX_LITE_EFFORT_FLOOR : effort;
}

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search"
]);

// Responses-native freeform tools — carry a name plus a format payload (e.g. grammar)
// and must pass through normalization intact. Port of upstream PR #1945.
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  // 0.5.165 — parallel_tool_calls is part of the Responses Lite shape (upstream
  // 95600db1). The legacy transport still deletes it below.
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
  "parallel_tool_calls"
]);

// Convert role=system → role=developer in body.input (keeps content in cacheable prefix)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

// Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false
// 0.5.165 — except the developer msg_ ids of a request that already arrived in the
// Responses Lite shape: there they are part of the prefix the real Codex CLI
// built, not a stored-item reference (upstream 95600db1).
function stripStoredItemReferences(body, preserveLitePrefix = false) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      const isLiteDeveloperId = preserveLitePrefix && item.role === "developer"
        && typeof item.id === "string" && item.id.startsWith("msg_");
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id) && !isLiteDeveloperId) delete item.id;
    }
    return true;
  });
}

// Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools
function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  // 0.5.165 — Codex's schema validator has no Unicode property escapes; a `pattern`
  // carrying `\p{...}` 400s the whole request on every account (upstream 781c18d8).
  const patternStats = { removed: 0 };
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
        }
        // New sub-tool objects only where a pattern was stripped (copy-on-write).
        const subTools = tool.tools.map((st) => {
          if (!st?.parameters || typeof st.parameters !== "object") return st;
          const parameters = stripCodexUnsupportedPatterns(st.parameters, patternStats);
          return parameters === st.parameters ? st : { ...st, parameters };
        });
        if (subTools.some((st, i) => st !== tool.tools[i])) tool.tools = subTools;
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    // Mirror the request translator: {type:"object"} with no properties is rejected
    // by strict Responses backends, and a client already speaking Responses format
    // bypasses the translator that would otherwise fill it in.
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    // 0.5.165 — keep an explicit boolean strict flag; the rebuild below dropped it
    // (upstream 0dd4d6be).
    const strict = typeof tool.strict === "boolean" ? tool.strict : fn?.strict;
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = stripCodexUnsupportedPatterns(parameters, patternStats);
    if (typeof strict === "boolean") tool.strict = strict;
    validNames.add(name);
    return true;
  });
  if (patternStats.removed > 0) {
    dbg("CODEX", `stripped ${patternStats.removed} unsupported tool schema pattern(s)`);
  }
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Cache machine ID at module level (resolved once)
let cachedMachineId = null;
getConsistentMachineId().then(id => { cachedMachineId = id; });

function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function generateSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// Extract text content from an input item
function extractItemText(item) {
  if (!item) return "";
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map(c => c.text || c.output || "").filter(Boolean).join("");
  }
  return "";
}

// Normalize a session id candidate (trim, length cap)
function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > 256) return null;
  return v;
}

// Resolve prompt-cache session id with priority: body → assistant-text-hash → workspaceId → machineId
function resolveCacheSessionId(body, credentials, machineId) {
  // 1. Client-provided session/conversation id (highest priority — stable per conversation)
  const fromBody =
    normalizeSessionId(body?.prompt_cache_key) ||
    normalizeSessionId(body?.session_id) ||
    normalizeSessionId(body?.conversation_id);
  if (fromBody) return fromBody;

  // 2. Hash accumulated assistant text (≥50 chars) — sticky session across turns
  if (Array.isArray(body?.input) && body.input.length > 0) {
    let text = "";
    const MIN_LEN = 50;
    const CAP_LEN = 200;
    for (const item of body.input) {
      if (item?.role !== "assistant") continue;
      const t = extractItemText(item);
      if (!t) continue;
      text += t;
      if (text.length >= CAP_LEN) break;
    }
    if (text.length >= MIN_LEN) {
      const hash = hashContent((machineId || "") + text.slice(0, CAP_LEN));
      const entry = assistantSessionMap.get(hash);
      if (entry) {
        entry.lastUsed = Date.now();
        return entry.sessionId;
      }
      const sessionId = generateSessionId();
      assistantSessionMap.set(hash, { sessionId, lastUsed: Date.now() });
      return sessionId;
    }
  }

  // 3. Account-wide fallback (workspaceId from connection)
  const workspaceId = normalizeSessionId(credentials?.providerSpecificData?.workspaceId);
  if (workspaceId) return workspaceId;

  // 4. Last resort — stable per-machine id
  return machineId ? `sess_${hashContent(machineId)}` : generateSessionId();
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of assistantSessionMap) {
    if (now - entry.lastUsed > SESSION_TTL_MS) assistantSessionMap.delete(key);
  }
}, 10 * 60 * 1000);

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
    this._currentSessionId = null;
  }

  /**
   * Override headers to add codex-specific identity headers.
   * transformRequest runs BEFORE buildHeaders, sets this._currentSessionId.
   */
  buildHeaders(credentials, stream = true, _url = null, model = null, body = null) {
    const headers = super.buildHeaders(credentials, stream);
    // 0.5.165 — the GPT-6 Sol/Luna family is only served behind this header, and
    // only for a request actually in the Lite shape: hosted web_search cannot run
    // from a Lite input prefix, so transformRequest falls back to regular
    // Responses and leaves the tool at the top level (upstream 95600db1, 7bf93178).
    if (isCodexResponsesLiteModel(model && getModelUpstreamId("cx", model)) && !hasHostedWebSearch(body?.tools)) {
      headers["x-openai-internal-codex-responses-lite"] = "true";
    }
    // 0.5.165 — the real codex CLI sends its version on every call, not just the
    // image one; a missing or stale identity is how gpt-6.1-sol got rejected
    // (upstream a7047a07, ca6e8407).
    if (!headers["version"]) headers["version"] = CODEX_CLI_VERSION;
    headers["session_id"] = this._currentSessionId || credentials?.connectionId || "default";
    // Identify client type to Codex backend (matches official codex CLI)
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";
    // Workspace binding header — improves account scope + cache affinity
    const workspaceId = credentials?.providerSpecificData?.workspaceId;
    if (typeof workspaceId === "string" && workspaceId && !headers["chatgpt-account-id"]) {
      headers["chatgpt-account-id"] = workspaceId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return this._isCompact ? `${base}/compact` : base;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  async execute(args) {
    const imgCount = Array.isArray(args.body?.input) ? args.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0) : 0;
    const inputLen = Array.isArray(args.body?.input) ? args.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${this._currentSessionId || "pending"}`);
    if (imgCount > 0) {
      const t0 = Date.now();
      await this.prefetchImages(args.body);
      dbg("CODEX", `prefetchImages done | ${Date.now() - t0}ms`);
    } else {
      await this.prefetchImages(args.body);
    }

    // Retry loop for SSE-level overloaded errors (200 OK body contains event: error)
    // Reuses 503 retry config — same semantic: upstream temporarily unavailable
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const { attempts, delayMs } = resolveRetryEntry(retryConfig[503]);
    let attempt = 0;
    while (true) {
      const result = await super.execute(args);
      const peek = await this._peekSseOverloaded(result.response);
      if (!peek.matched) {
        // Replace body with re-assembled stream (prefix bytes already read + rest)
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      if (attempt >= attempts) {
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${attempt}/${attempts})`);
        // Out of retries → return with replacement body so client gets the error
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      attempt++;
      args.log?.debug?.("RETRY", `CODEX | SSE "${peek.matched}" retry ${attempt}/${attempts} after ${delayMs / 1000}s`);
      dbg("CODEX", `SSE overloaded "${peek.matched}" → retry ${attempt}/${attempts} in ${delayMs}ms`);
      try { await result.response.body?.cancel?.(); } catch { /* noop */ }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Peek first N bytes of SSE body to detect upstream "overloaded" errors.
  // Returns { matched: string|null, replacementBody: ReadableStream|null }.
  // Caller MUST use replacementBody (original body has been read).
  async _peekSseOverloaded(response) {
    if (!response || !response.ok || !response.body) return { matched: null, replacementBody: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let matched = null;
    try {
      while (text.length < CODEX_SSE_PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        const hit = CODEX_SSE_OVERLOADED_PATTERNS.find(p => text.includes(p));
        if (hit) { matched = hit; break; }
      }
    } catch (e) {
      dbg("CODEX", `peek read error: ${e.message}`);
    }
    reader.releaseLock();

    // Re-assemble stream: prefix chunks + remaining upstream body
    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) {
        try { upstreamReader?.cancel(reason); } catch { /* noop */ }
      },
    });
    return { matched, replacementBody };
  }

  // Parse Codex usage_limit_reached to extract precise resetsAtMs; fallback to default otherwise
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return { status: 429, message: err.message || bodyText, resetsAtMs };
          }
        }
      } catch { /* fall through to default */ }
    }
    return super.parseError(response, bodyText);
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    this._isCompact = !!body._compact;
    delete body._compact;
    // Resolve conversation-stable session_id (priority: body → assistant-text → workspace → machine)
    this._currentSessionId = resolveCacheSessionId(body, credentials, cachedMachineId);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // 0.5.165 — decide the transport before anything reshapes the body. Hosted
    // web_search cannot be executed from a Responses Lite input prefix, so a
    // request that asks for it switches back to regular Responses and the tools a
    // previous Lite turn left in an additional_tools item are hoisted back to the
    // top level, deduped by type+name (upstream 95600db1, 7bf93178).
    const upstreamModel = getModelUpstreamId("cx", body.model || model);
    const isLiteModel = isCodexResponsesLiteModel(upstreamModel);
    let convertedLitePrefix = false;
    if (isLiteModel && Array.isArray(body.input)) {
      const prefixes = body.input.filter((item) => item?.type === "additional_tools");
      const prefixedTools = prefixes.flatMap((item) => (Array.isArray(item.tools) ? item.tools : []));
      if (hasHostedWebSearch(body.tools) || hasHostedWebSearch(prefixedTools)) {
        const tools = Array.isArray(body.tools) ? [...body.tools] : [];
        const seen = new Set(tools.map(toolIdentity));
        for (const tool of prefixedTools) {
          const id = toolIdentity(tool);
          if (seen.has(id)) continue;
          seen.add(id);
          tools.push(tool);
        }
        body.tools = tools;
        convertedLitePrefix = prefixes.length > 0;
        body.input = body.input.filter((item) => item?.type !== "additional_tools");
      }
    }
    const responsesLite = isLiteModel && !hasHostedWebSearch(body.tools);

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }

    // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
    convertSystemToDeveloperRole(body);
    // Strip server-generated item IDs (rs_/fc_/resp_/msg_) — Codex /responses can't resolve when store=false
    stripStoredItemReferences(body, responsesLite);
    // Flatten function tools + drop unsupported types
    normalizeCodexTools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions.
    // 0.5.165 — not for Lite (the prefix below carries them), and not when a Lite
    // prefix was just hoisted out for hosted search: that request already has its
    // own developer instructions in body.input (upstream 95600db1, 7bf93178).
    if (!responsesLite && !convertedLitePrefix && (!body.instructions || body.instructions.trim() === "")) {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Inject prompt_cache_key for stable Codex prompt caching
    if (!body.prompt_cache_key && this._currentSessionId) {
      body.prompt_cache_key = this._currentSessionId;
    }

    // Map virtual Codex review models to the upstream Codex model before suffix parsing.
    body.model = upstreamModel;

    // 0.5.165 — build the Lite prefix: tools and instructions move into input
    // items, the top-level fields go empty (upstream 95600db1).
    if (responsesLite) {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      const hasLitePrefix = input.some((item) => item?.type === "additional_tools");
      if (!hasLitePrefix) {
        const instructions = typeof body.instructions === "string" && body.instructions.trim()
          ? body.instructions
          : CODEX_DEFAULT_INSTRUCTIONS;
        const prefix = [{
          type: "additional_tools",
          role: "developer",
          tools: Array.isArray(body.tools) ? body.tools : [],
        }];
        if (instructions) {
          prefix.push({ type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] });
        }
        input.unshift(...prefix);
      }
      body.input = input;
      body.instructions = "";
      body.tools = null;
      body.tool_choice ||= "auto";
      body.parallel_tool_calls = false;
    } else {
      delete body.parallel_tool_calls;
    }

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = ['none', 'low', 'medium', 'high', 'xhigh'];
    let modelEffort = null;
    for (const level of effortLevels) {
      if (body.model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, '');
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    // 0.5.165 — Lite defaults to medium, takes no summary and adds
    // context: "all_turns" (upstream 95600db1).
    if (!body.reasoning) {
      const raw = body.reasoning_effort || modelEffort || (responsesLite ? 'medium' : 'low');
      const effort = responsesLite ? clampLiteEffort(raw) : raw;
      body.reasoning = responsesLite ? { effort } : { effort, summary: "auto" };
    } else {
      if (responsesLite && body.reasoning.effort) body.reasoning.effort = clampLiteEffort(body.reasoning.effort);
      if (!responsesLite && !body.reasoning.summary) body.reasoning.summary = "auto";
    }
    if (responsesLite) body.reasoning.context = "all_turns";
    delete body.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens; // Responses API clients send this but Codex rejects it
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // store=false → backend can't resolve previous resp; avoid 404

    // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }
}
