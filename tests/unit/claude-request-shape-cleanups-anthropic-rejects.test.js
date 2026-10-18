// 0.5.166 — Claude message-shape cleanups for bodies Anthropic (or a strict gateway)
// rejects with a 400:
//   8a81085a  a turn whose content is ONE block object (not an array) was dropped;
//             a client already at 4 cache_control markers reached 5 in
//             preserveCacheControl mode (the tool re-anchor) — non-retryable 400.
//   4f274c7f  a user turn whose only block is container_upload was dropped,
//             forwarding messages: [].
//   75834e96  cleanup that empties the final user turn leaves the body ending on
//   5e9bd464  assistant ("does not support assistant message prefill"); append
//             "Continue." unless the client itself ended on assistant.
//   c8644368  context_management is Anthropic-only; blank thinking blocks are a 400.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import {
  hasValidContent, normalizeClaudePassthrough, prepareClaudeRequest,
} from "../../open-sse/translator/helpers/claudeHelper.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const countMarkers = (body) => {
  let n = 0;
  for (const b of body.system || []) if (b?.cache_control) n++;
  for (const t of body.tools || []) if (t?.cache_control) n++;
  for (const m of body.messages || []) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b?.cache_control) n++;
  }
  return n;
};

describe("single-object content turns (8a81085a)", () => {
  it("hasValidContent accepts a bare text block object", () => {
    expect(hasValidContent({ role: "user", content: { type: "text", text: "hi" } })).toBe(true);
    expect(hasValidContent({ role: "user", content: { type: "text", text: "  " } })).toBe(false);
  });

  it("prepareClaudeRequest keeps the turn and wraps it as a one-block array", () => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5",
      messages: [
        { role: "user", content: { type: "text", text: "first" } },
        { role: "assistant", content: "ok" },
        { role: "user", content: { type: "text", text: "second", cache_control: { type: "ephemeral" } } },
      ],
    }, "claude");
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0].content).toEqual([{ type: "text", text: "first" }]);
    expect(out.messages[2].content[0].text).toBe("second");
  });

  it("does not mutate the client's message objects when wrapping", () => {
    const block = { type: "text", text: "hi", cache_control: { type: "ephemeral" } };
    const msg = { role: "user", content: block };
    prepareClaudeRequest({ model: "claude-opus-5", messages: [msg] }, "claude");
    expect(msg.content).toBe(block);
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("normalizeClaudePassthrough wraps it before hoisting a mid-conversation system turn", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: { type: "text", text: "hi" } },
        { role: "system", content: { type: "text", text: "reminder" } },
      ],
    });
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(out.system).toEqual([{ type: "text", text: "reminder" }]);
  });
});

describe("cache_control 4-marker budget (8a81085a)", () => {
  it("a client already at 4 markers stays at 4 when preserveCacheControl re-anchors the tool", () => {
    const eph = { type: "ephemeral" };
    const body = {
      model: "claude-opus-5",
      system: [{ type: "text", text: "a", cache_control: eph }, { type: "text", text: "b", cache_control: eph }],
      tools: [{ name: "t1", input_schema: { type: "object" } }, { name: "t2", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "u1", cache_control: eph }] },
        { role: "assistant", content: [{ type: "text", text: "a1", cache_control: eph }] },
        { role: "user", content: [{ type: "text", text: "u2" }] },
      ],
    };
    const out = prepareClaudeRequest(body, "claude", null, null, true);
    expect(countMarkers(out)).toBe(4);
    // the head anchors survive: last system block and the last cacheable tool
    expect(out.system[1].cache_control).toBeDefined();
    expect(out.tools[1].cache_control).toBeDefined();
    // the remaining slots go to the tail-most markers; the oldest non-head one goes
    expect(out.messages[0].content[0].cache_control).toBeDefined();
    expect(out.messages[1].content[0].cache_control).toBeDefined();
    expect(out.system[0].cache_control).toBeUndefined();
  });

  it("leaves a body under budget alone", () => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5",
      system: [{ type: "text", text: "a" }],
      tools: [{ name: "t1", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "u1" }] }],
    }, "claude");
    expect(countMarkers(out)).toBe(2);
  });
});

describe("container_upload-only user turn (4f274c7f)", () => {
  it("is valid content and survives prepareClaudeRequest", () => {
    const turn = { role: "user", content: [{ type: "container_upload", file_id: "file_abc" }] };
    expect(hasValidContent(turn)).toBe(true);
    const out = prepareClaudeRequest({ model: "claude-opus-5", messages: [turn] }, "claude");
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].content[0].type).toBe("container_upload");
  });
});

describe("trailing user turn (75834e96 + 5e9bd464)", () => {
  it("appends Continue. when cleanup emptied the client's final user turn", () => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "   " }] },
      ],
    }, "claude");
    expect(out.messages.at(-1).role).toBe("user");
    expect(out.messages.at(-1).content).toEqual([{ type: "text", text: "Continue." }]);
  });

  it("keeps real prefill when the client ended on assistant", () => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "{" }] }],
    }, "claude");
    expect(out.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("covers the passthrough cleanup too", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "" }] },
      ],
    });
    expect(out.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Continue." }] });
  });

  it("covers an OpenAI client whose last user message carried nothing Claude accepts", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-5", {
      model: "claude-opus-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "" },
      ],
    }, true, null, "claude");
    expect(out.messages.at(-1).role).toBe("user");
    expect(out.messages.at(-1).content).toEqual([{ type: "text", text: "Continue." }]);
  });

  it("keeps an OpenAI client's own assistant prefill", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-5", {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "{" }],
    }, true, null, "claude");
    expect(out.messages.at(-1).role).toBe("assistant");
  });
});

describe("context_management is Anthropic-only (c8644368)", () => {
  const withCm = () => ({
    model: "claude-haiku-5-5",
    max_tokens: 1024,
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    messages: [{ role: "user", content: "hi" }],
  });

  it.each(["glm", "kimi-coding", "minimax", "opencode-go"])("is stripped for %s", (provider) => {
    expect(prepareClaudeRequest(withCm(), provider).context_management).toBeUndefined();
  });

  it.each(["claude", "anthropic", "anthropic-compatible-node"])("is kept for %s", (provider) => {
    expect(prepareClaudeRequest(withCm(), provider).context_management).toBeDefined();
  });
});

describe("blank thinking blocks (c8644368)", () => {
  const thinking = (text) => ({ type: "thinking", thinking: text, signature: "sig" });

  it("passthrough drops an empty or whitespace thinking block and keeps its sibling", () => {
    for (const text of ["", "  \n\t "]) {
      const out = normalizeClaudePassthrough({
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [thinking(text), { type: "text", text: "kept" }] }, { role: "user", content: "go" }],
      });
      expect(out.messages[1].content).toEqual([{ type: "text", text: "kept" }]);
    }
  });

  it("passthrough keeps thinking that has text, and redacted_thinking", () => {
    const keep = thinking("considered it");
    const redacted = { type: "redacted_thinking", data: "abc" };
    const out = normalizeClaudePassthrough({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [redacted, keep, { type: "text", text: "kept" }] }, { role: "user", content: "go" }],
    });
    expect(out.messages[1].content.map(b => b.type)).toEqual(["redacted_thinking", "thinking", "text"]);
  });

  it.each(["claude", "glm"])("prepareClaudeRequest drops a blank thinking block for %s", (provider) => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [thinking("  "), { type: "text", text: "kept" }] }, { role: "user", content: "go" }],
    }, provider);
    expect(out.messages[1].content.map(b => b.type)).toEqual(["text"]);
  });
});
