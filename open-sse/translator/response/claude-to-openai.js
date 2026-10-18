import { register } from "../index.js";
import { FORMATS } from "../formats.js";

// Create OpenAI chunk helper
function createChunk(state, delta, finishReason = null) {
  return {
    id: `chatcmpl-${state.messageId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason
    }]
  };
}

// Convert Claude stream chunk to OpenAI format
export function claudeToOpenAIResponse(chunk, state) {
  if (!chunk) return null;

  const results = [];
  const event = chunk.type;

  switch (event) {
    case "message_start": {
      state.messageId = chunk.message?.id || `msg_${Date.now()}`;
      state.model = chunk.message?.model;
      state.toolCallIndex = 0;
      // 0.5.165 — Anthropic reports the prompt side (input + both cache buckets) here;
      // some Claude-shaped upstreams then send only output_tokens in message_delta, so
      // the final chunk said prompt_tokens 0 and a Codex client on a Claude connection
      // never learned its context size (upstream 54e3245a, needed by 7111db35). Kept
      // apart from state.usage, which stream.js overwrites from every chunk.
      const startUsage = chunk.message?.usage;
      if (startUsage && typeof startUsage === "object") state.claudeStartUsage = startUsage;
      results.push(createChunk(state, { role: "assistant" }));
      break;
    }

    case "content_block_start": {
      const block = chunk.content_block;
      if (block?.type === "server_tool_use") {
        // Built-in tool (web search) - Claude handles internally, skip
        state.serverToolBlockIndex = chunk.index;
        break;
      }
      // 0.5.165 — no "<think>"/"</think>" markers in delta.content: thinking travels
      // only in reasoning_content, and OpenAI clients rendered the empty pair as literal
      // text above every answer (upstream 5d2cfbf3).
      if (block?.type === "text") {
        state.textBlockStarted = true;
      } else if (block?.type === "tool_use") {
        const toolCallIndex = state.toolCallIndex++;
        // Restore original tool name from mapping (Claude OAuth)
        const toolName = state.toolNameMap?.get(block.name) || block.name;
        const toolCall = {
          index: toolCallIndex,
          id: block.id,
          type: "function",
          function: {
            name: toolName,
            arguments: ""
          }
        };
        state.toolCalls.set(chunk.index, toolCall);
        results.push(createChunk(state, { tool_calls: [toolCall] }));
      }
      break;
    }

    case "content_block_delta": {
      // Skip deltas for built-in server tool blocks (web search)
      if (chunk.index === state.serverToolBlockIndex) break;
      const delta = chunk.delta;
      if (delta?.type === "text_delta" && delta.text) {
        results.push(createChunk(state, { content: delta.text }));
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        results.push(createChunk(state, { reasoning_content: delta.thinking }));
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        const toolCall = state.toolCalls.get(chunk.index);
        if (toolCall) {
          toolCall.function.arguments += delta.partial_json;
          results.push(createChunk(state, {
            tool_calls: [{
              index: toolCall.index,
              id: toolCall.id,
              function: { arguments: delta.partial_json }
            }]
          }));
        }
      }
      break;
    }

    case "content_block_stop": {
      // Skip stop for built-in server tool blocks (web search)
      if (chunk.index === state.serverToolBlockIndex) {
        state.serverToolBlockIndex = -1;
        break;
      }
      state.textBlockStarted = false;
      state.thinkingBlockStarted = false;
      break;
    }

    case "message_delta": {
      // Extract usage from message_delta event (Claude native format)
      // Normalize to OpenAI format (prompt_tokens/completion_tokens) for consistent logging
      if (chunk.usage && typeof chunk.usage === "object") {
        // 0.5.165 — a count the delta omits falls back to message_start's (see above).
        const start = state.claudeStartUsage || {};
        const count = (key) => typeof chunk.usage[key] === "number" ? chunk.usage[key]
          : typeof start[key] === "number" ? start[key] : 0;
        const inputTokens = count("input_tokens");
        const outputTokens = typeof chunk.usage.output_tokens === "number" ? chunk.usage.output_tokens : 0;
        const cacheReadTokens = count("cache_read_input_tokens");
        const cacheCreationTokens = count("cache_creation_input_tokens");

        // prompt_tokens = input_tokens + cache_read + cache_creation (all prompt-side tokens)
        const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;

        state.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          total_tokens: promptTokens + outputTokens,
          input_tokens: inputTokens,
          output_tokens: outputTokens
        };

        if (cacheReadTokens > 0) state.usage.cache_read_input_tokens = cacheReadTokens;
        if (cacheCreationTokens > 0) state.usage.cache_creation_input_tokens = cacheCreationTokens;
      }

      if (chunk.delta?.stop_reason) {
        state.finishReason = convertStopReason(chunk.delta.stop_reason);
        // 0.5.165 — a refusal has no content blocks at all; send Anthropic's own
        // explanation as the text so the client shows why the turn is empty (upstream 0f488c70).
        const refusalNote = refusalExplanation(chunk.delta);
        if (refusalNote) results.push(createChunk(state, { content: refusalNote }));
        const finalChunk = {
          id: `chatcmpl-${state.messageId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: {}, finish_reason: state.finishReason }]
        };

        if (state.usage) {
          finalChunk.usage = {
            prompt_tokens: state.usage.prompt_tokens,
            completion_tokens: state.usage.completion_tokens,
            total_tokens: state.usage.total_tokens
          };

          const cacheRead = state.usage.cache_read_input_tokens;
          const cacheCreate = state.usage.cache_creation_input_tokens;
          if (cacheRead > 0 || cacheCreate > 0) {
            finalChunk.usage.prompt_tokens_details = {};
            if (cacheRead > 0) finalChunk.usage.prompt_tokens_details.cached_tokens = cacheRead;
            if (cacheCreate > 0) finalChunk.usage.prompt_tokens_details.cache_creation_tokens = cacheCreate;
          }
        }

        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }

    case "message_stop": {
      if (!state.finishReasonSent) {
        const finishReason = state.finishReason || (state.toolCalls?.size > 0 ? "tool_calls" : "stop");
        const usageObj = (state.usage && typeof state.usage === 'object') ? {
          usage: {
            prompt_tokens: state.usage.input_tokens || 0,
            completion_tokens: state.usage.output_tokens || 0,
            total_tokens: (state.usage.input_tokens || 0) + (state.usage.output_tokens || 0)
          }
        } : {};
        results.push({
          id: `chatcmpl-${state.messageId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: finishReason
          }],
          ...usageObj
        });
        state.finishReasonSent = true;
      }
      break;
    }
  }

  return results.length > 0 ? results : null;
}

// Convert Claude stop_reason to OpenAI finish_reason.
// 0.5.165 — exported so the non-streaming path maps identically (it leaked raw
// "max_tokens"/"refusal"). "refusal" is a blocked turn, not a clean stop: as "stop"
// an OpenAI client could not tell it from a real, empty answer (upstream 0f488c70).
export function convertStopReason(reason) {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "stop_sequence": return "stop";
    case "refusal": return "content_filter";
    default: return "stop";
  }
}

// Anthropic's reason for a refusal (stop_details.explanation), or null. Takes the
// streaming message_delta.delta or a non-streaming message -- both carry the pair.
export function refusalExplanation(source) {
  if (source?.stop_reason !== "refusal") return null;
  const explanation = source.stop_details?.explanation;
  return typeof explanation === "string" && explanation ? explanation : null;
}

// Register
register(FORMATS.CLAUDE, FORMATS.OPENAI, null, claudeToOpenAIResponse);

