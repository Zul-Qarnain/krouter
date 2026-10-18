/**
 * OpenAI → CommandCode request translator
 *
 * Upstream `/alpha/generate` schema (verified live with curl 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - image_url / image source -> {type:"image", image:"data:...;base64,...", mimeType, mediaType}
 *  - params.reasoning_effort: the client's level, unmapped (the envelope has no slot for it)
 *  - tool_use blocks (assistant): {type:"tool-call", toolCallId, toolName, input}
 *  - tool_result blocks (role=user): {type:"tool-result", toolCallId, toolName, output}
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { randomUUID } from "crypto";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

// 0.5.166 (upstream 13b468b8) — `/alpha/generate` takes a native image block.
// Every image used to become the literal text "[image omitted]", so a vision
// request through Command Code answered about an image it had never seen.
const DATA_URI = /^data:([^;,]+);base64,(.+)$/s;
const DEFAULT_IMAGE_MIME = "image/png";

function imageBlock(dataUri, mimeType) {
  // mediaType is the AI SDK v5 name, mimeType the v4 one; the gateway has shipped
  // both, so send both rather than guessing which build answers.
  return { type: "image", image: dataUri, mimeType, mediaType: mimeType };
}

/**
 * An OpenAI image_url / native image / Claude image source as a native block.
 *
 * Only inlinable images convert: a data URI, or a Claude base64 source. kRouter
 * has no pre-translation image prefetch (upstream relies on one), so a remote
 * http(s) URL cannot be turned into base64 here and keeps the old text stub --
 * dropping it silently would leave the model answering about nothing.
 */
function toNativeImageBlock(part) {
  if (!part || typeof part !== "object") return null;

  if (part.type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const match = DATA_URI.exec(String(url || ""));
    if (!match) return null;
    return imageBlock(url, match[1]);
  }

  if (part.type !== "image") return null;

  if (typeof part.image === "string") {
    const match = DATA_URI.exec(part.image);
    if (!match) return null;
    return imageBlock(part.image, part.mimeType || match[1] || DEFAULT_IMAGE_MIME);
  }

  const source = part.source;
  if (source?.type === "base64" && typeof source.data === "string") {
    const mime = source.media_type || DEFAULT_IMAGE_MIME;
    return imageBlock(`data:${mime};base64,${source.data}`, mime);
  }

  return null;
}

function toContentBlocks(content) {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: "text", text: part });
      } else if (part && typeof part === "object") {
        if (part.type === "text" && typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        } else {
          const image = toNativeImageBlock(part);
          if (image) blocks.push(image);
          else if (part.type === "image_url" || part.type === "image") {
            blocks.push({ type: "text", text: "[image omitted]" });
          } else if (typeof part.text === "string") {
            blocks.push({ type: "text", text: part.text });
          }
        }
      }
    }
    return blocks.length ? blocks : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: String(content) }];
}

// Command Code's own ladder. "none"/"off" is absent on purpose: the gateway has
// no disable tier, so the field is omitted and the model's default applies.
const REASONING_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function convertMessages(messages = []) {
  const out = [];
  const systemTexts = [];

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;

    if (role === "system") {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === "tool") {
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || "",
          toolName: m.name || "",
          output: { type: "text", value },
        }],
      });
      continue;
    }

    if (role === "assistant") {
      const blocks = [];
      // 0.5.166 (upstream 092c84ea) — the native CLI opens a thinking turn with a
      // reasoning block and puts the tool calls after it. Replay the client's own
      // reasoning when it echoed any, and a placeholder on a tool-call turn so the
      // replayed history keeps the shape the gateway was built around.
      const reasoning = [m.reasoning_content, m.thought, m.reasoning]
        .find((value) => typeof value === "string" && value.trim());
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (reasoning || hasToolCalls) blocks.push({ type: "reasoning", text: reasoning || " " });
      const text = flattenText(m.content);
      if (text) blocks.push({ type: "text", text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
      continue;
    }

    out.push({ role: "user", content: toContentBlocks(m.content) });
  }

  return { messages: out, system: systemTexts.join("\n\n") };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === "function" && t.function) {
      result.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object" },
      });
    } else if (t.name && (t.input_schema || t.parameters)) {
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters,
      });
    }
  }
  return result.length ? result : undefined;
}

export function openaiToCommandCode(model, body, stream /* , credentials */) {
  const { messages, system } = convertMessages(body.messages);
  const params = {
    model,
    messages,
    stream: stream !== false,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? 64000,
    temperature: body.temperature ?? 0.3,
  };

  if (system) params.system = system;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;

  // 0.5.166 (upstream 13b468b8) — the native CLI sends the level inside params.
  // On the envelope wrapper the gateway ignores it, which is where the client's
  // effort used to go to die. Unmapped: Command Code accepts the whole ladder.
  const effort = body.reasoning_effort;
  if (REASONING_LEVELS.has(effort)) params.reasoning_effort = effort;

  const today = new Date().toISOString().slice(0, 10);

  return {
    threadId: randomUUID(),
    memory: "",
    config: {
      workingDir: process.cwd(),
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCode, null);
