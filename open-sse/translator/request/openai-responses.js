/**
 * Translator: OpenAI Responses API → OpenAI Chat Completions
 * 
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput } from "../helpers/responsesApiHelper.js";

// Responses API enforces max 64 chars on call_id (#393)
const MAX_CALL_ID_LEN = 64;
// 0.5.165 — strict Responses upstreams also cap tool names at 128 (upstream e74db4d0)
const MAX_TOOL_NAME_LEN = 128;

// 0.5.165 — a missing call_id used to stay undefined and 400 the request; fall back
// to a unique id. The sequence keeps same-millisecond fallbacks distinct (upstream
// e74db4d0 + 11222eff).
let fallbackCallIdSeq = 0;
const clampCallId = (id) => {
  if (typeof id !== "string" || !id) return `call_${Date.now()}_${(fallbackCallIdSeq += 1)}`;
  return id.length > MAX_CALL_ID_LEN ? id.substring(0, MAX_CALL_ID_LEN) : id;
};

// 0.5.165 — arguments must be exactly one JSON string: objects are stringified once,
// valid JSON strings pass through, anything else (partial fragment, empty) becomes
// "{}" instead of tripping InputValidationError (upstream e74db4d0).
function coerceCallArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try { return JSON.stringify(value) ?? "{}"; } catch { return "{}"; }
  }
  try { JSON.parse(value); return value; } catch { return "{}"; }
}

// 0.5.165 — function_call_output.output must be a string; null used to go out as
// "null". Fail-soft on circular / BigInt values (upstream e74db4d0 + 11222eff).
function stringifySoft(value) {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
function coerceCallOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((c) => (typeof c?.text === "string" ? c.text : stringifySoft(c))).join("");
  return stringifySoft(value);
}

// 0.5.165 — a nameless call or tool is rejected by strict Responses upstreams (#444).
const toolName = (name) => (typeof name === "string" ? name.trim().slice(0, MAX_TOOL_NAME_LEN) : "");

// 0.5.165 — Responses takes the cap as max_output_tokens (upstream ab044e6d). 0 or a
// negative value means "unset" to some clients; never turn it into a cap.
const outputCap = (body) => [body.max_output_tokens, body.max_completion_tokens, body.max_tokens]
  .find((v) => Number.isFinite(v) && v > 0);

/**
 * Convert OpenAI Responses API request to OpenAI Chat Completions format
 */
export function openaiResponsesToOpenAIRequest(model, body, stream, credentials) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: "system", content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolResults = [];
  let pendingReasoning = "";

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  // Extract reasoning text from summary[].text or encrypted_content fallback
  const extractReasoningText = (item) => {
    if (Array.isArray(item.summary)) {
      const txt = item.summary.map(s => s?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    if (Array.isArray(item.content)) {
      const txt = item.content.map(c => c?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    return "";
  };

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? "message" : null);

    if (itemType === "message") {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === "input_text") return { type: "text", text: c.text };
          if (c.type === "output_text") return { type: "text", text: c.text };
          if (c.type === "input_image") {
            const url = c.image_url || c.file_id || "";
            return { type: "image_url", image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      const msg = { role: item.role, content };
      // Attach buffered reasoning to assistant turn (required by xiaomi-mimo thinking mode)
      if (item.role === "assistant" && pendingReasoning) {
        msg.reasoning_content = pendingReasoning;
      }
      pendingReasoning = "";
      result.messages.push(msg);
    }
    else if (itemType === "function_call") {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: "assistant",
          content: null,
          tool_calls: []
        };
        if (pendingReasoning) {
          currentAssistantMsg.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
      }
      // Skip items with empty/missing name — Codex/OpenAI reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === "function_call_output") {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush any pending tool results first
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }
      // Add tool result immediately
      result.messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === "reasoning") {
      // Buffer reasoning text; attached to next assistant message/function_call
      const txt = extractReasoningText(item);
      if (txt) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${txt}` : txt;
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Convert tools format.
  // Responses API supports "hosted" tools (e.g. { type: "request_user_input" }) that carry no
  // explicit `name` field and cannot be represented as Chat Completions function declarations.
  // Filter them out to avoid sending nameless functionDeclarations to downstream providers
  // such as Gemini, which strictly validates function names.
  if (body.tools && Array.isArray(body.tools)) {
    const converted = [];
    const hosted = [];
    for (const tool of body.tools) {
      if (tool.function) { converted.push(tool); continue; }
      const name = tool.name;
      if (!name || typeof name !== "string" || name.trim() === "") {
        hosted.push(tool);
        continue;
      }
      converted.push({
        type: "function",
        function: {
          name,
          description: String(tool.description || ""),
          parameters: normalizeToolParameters(tool.parameters),
          strict: tool.strict
        }
      });
    }
    result.tools = converted;
    if (hosted.length > 0) result._hostedTools = hosted;
  }

  // Cleanup Responses API specific fields
  // The Responses API uses `max_output_tokens`; the Chat Completions API
  // upstream uses `max_tokens`. Map and delete so the upstream provider
  // doesn't receive an unknown field. (port of upstream aba4c45)
  if (result.max_output_tokens !== undefined) {
    if (result.max_tokens === undefined) result.max_tokens = result.max_output_tokens;
    delete result.max_output_tokens;
  }

  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;
  // 0.5.113 (upstream e567ba80) — client_metadata is a Responses-API field the
  // plain Chat Completions endpoint rejects; strip it during the conversion.
  delete result.client_metadata;

  return result;
}

/**
 * Ensure object schema always has properties field (required by Codex Responses API)
 */
function normalizeToolParameters(params) {
  if (!params) return { type: "object", properties: {} };
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

/**
 * Convert OpenAI Chat Completions to OpenAI Responses API format
 */
export function openaiToOpenAIResponsesRequest(model, body, stream, credentials) {
  // Body already in Responses API format (e.g. Cursor CLI calling /chat/completions with input[])
  // 0.5.165 — still map the Chat-style cap: OpenAI-compatible Responses nodes go
  // through DefaultExecutor, which never strips max_tokens (upstream ab044e6d).
  if (body.input) {
    const { max_tokens, max_completion_tokens, ...rest } = body;
    const out = { ...rest, model, stream: true };
    if (out.max_output_tokens === undefined) {
      const cap = outputCap(body);
      if (cap !== undefined) out.max_output_tokens = cap;
    }
    return out;
  }

  const result = {
    model,
    input: [],
    stream: true,
    store: false
  };

  // System and developer messages become instructions -- all of them, in order.
  // Only the first system message used to be kept: a second system message, any
  // developer message (Codex sends these) and array-shaped content were dropped
  // silently, so the model never saw part of its instructions.
  let hasSystemMessage = false;
  const messages = body.messages || [];
  const instructionParts = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n")
          : "";
      if (text) instructionParts.push(text);
      hasSystemMessage = true;
      continue; // Skip system/developer messages in input
    }

    // Convert user/assistant messages to input items
    if (msg.role === "user" || msg.role === "assistant") {
      const contentType = msg.role === "user" ? "input_text" : "output_text";
      const content = typeof msg.content === "string"
        ? [{ type: contentType, text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map(c => {
            if (c.type === "text") return { type: contentType, text: c.text };
            // Convert Chat Completions image_url → Responses API input_image
            // Responses API expects: { type: "input_image", image_url: "<url string>" }
            // Chat Completions sends: { type: "image_url", image_url: { url: "...", detail: "..." } }
            if (c.type === "image_url") {
              const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
              return { type: "input_image", image_url: url, detail: c.image_url?.detail || "auto" };
            }
            if (c.type === "input_image") return c;
            // Serialize any unknown type (tool_use, tool_result, thinking, etc.) as text
            const text = c.text || c.content || JSON.stringify(c);
            return { type: contentType, text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          : [];

      // Only push a message block if content is non-empty.
      // Assistant messages with only tool_calls have content: null — skip the
      // message block in that case; the tool_calls are pushed separately below.
      if (content.length > 0) {
        result.input.push({
          type: "message",
          role: msg.role,
          content
        });
      }
    }

    // Convert tool calls
    // 0.5.165 — skip nameless calls (was "_unknown"), clamp names, one JSON string
    // of arguments (upstream e74db4d0).
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const name = toolName(tc.function?.name);
        if (!name) continue;
        result.input.push({
          type: "function_call",
          call_id: clampCallId(tc.id),
          name,
          arguments: coerceCallArguments(tc.function?.arguments)
        });
      }
    }

    // Convert tool results - output must be a string for Responses API
    if (msg.role === "tool") {
      result.input.push({
        type: "function_call_output",
        call_id: clampCallId(msg.tool_call_id),
        output: coerceCallOutput(msg.content)
      });
    }
  }

  // If no system message, leave instructions empty (will be filled by executor)
  result.instructions = hasSystemMessage ? instructionParts.join("\n\n") : "";

  // Convert tools format
  // 0.5.165 — drop nameless function tools and clamp names (upstream e74db4d0).
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      if (tool.type === "function") {
        const name = toolName(tool.function?.name);
        if (!name) return null;
        return {
          type: "function",
          name,
          description: String(tool.function.description || ""),
          parameters: normalizeToolParameters(tool.function.parameters),
          strict: tool.function.strict
        };
      }
      return tool;
    }).filter(Boolean);
  }

  // Pass through other relevant fields
  if (body.temperature !== undefined) result.temperature = body.temperature;
  // 0.5.165 — Responses wants max_output_tokens; max_tokens 400s on real OpenAI
  // /v1/responses and max_completion_tokens was dropped (upstream ab044e6d).
  const cap = outputCap(body);
  if (cap !== undefined) result.max_output_tokens = cap;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  // 0.5.165 — reasoning_effort was dropped, so a chat client's effort never reached
  // Codex / Grok CLI / Copilot /responses (upstream ab044e6d). Only the Responses
  // fields are forwarded: other shapes (OpenRouter's {enabled, max_tokens}) would be
  // rejected by a strict upstream.
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  if (typeof effort === "string" && effort) {
    result.reasoning = { effort, summary: body.reasoning?.summary || "auto" };
  }
  // 0.5.121 (upstream c97963c4) — forward service_tier (priority/default/flex)
  // instead of silently dropping it on the OpenAI→Responses conversion.
  if (body.service_tier !== undefined) result.service_tier = body.service_tier;
  // upstream 70ba0024 — keep the caller's cache key so upstream prompt caching
  // actually keys on the same value across turns.
  if (body.prompt_cache_key !== undefined) result.prompt_cache_key = body.prompt_cache_key;

  return result;
}

// Register both directions
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiToOpenAIResponsesRequest, null);
