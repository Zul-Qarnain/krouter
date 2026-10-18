// 0.5.165 (upstream 13b468b8) — Command Code's /alpha/generate takes a native
// {type:"image"} block, but kRouter replaced every image with the literal text
// "[image omitted]", so vision through Command Code always answered about an
// image it never saw. The client's reasoning_effort was dropped outright: the
// envelope has no top-level slot for it and the native CLI sends it inside
// `params`.
//
// 0.5.165 (upstream 092c84ea) — a history turn that carries tool calls needs a
// reasoning block ahead of them, which is what the CLI sends.
import { describe, it, expect } from "vitest";
import { openaiToCommandCode } from "../../open-sse/translator/request/openai-to-commandcode.js";

const MODEL = "poolside/laguna-s-2.1-free";
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URI = `data:image/png;base64,${PNG_B64}`;
const run = (body) => openaiToCommandCode(MODEL, body, true);
const userContent = (out) => out.params.messages[0].content;

describe("openaiToCommandCode keeps images as native blocks", () => {
  it("maps an OpenAI image_url data URI to {type:image,image,mimeType,mediaType}", () => {
    const out = run({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what colour?" },
          { type: "image_url", image_url: { url: DATA_URI } },
        ],
      }],
    });
    expect(userContent(out)).toEqual([
      { type: "text", text: "what colour?" },
      { type: "image", image: DATA_URI, mimeType: "image/png", mediaType: "image/png" },
    ]);
  });

  it("accepts image_url given as a bare string", () => {
    const out = run({ messages: [{ role: "user", content: [{ type: "image_url", image_url: DATA_URI }] }] });
    expect(userContent(out)[0].image).toBe(DATA_URI);
  });

  it("maps a Claude base64 image source to a data-URI block", () => {
    const out = run({
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG_B64 } }],
      }],
    });
    expect(userContent(out)).toEqual([
      { type: "image", image: `data:image/jpeg;base64,${PNG_B64}`, mimeType: "image/jpeg", mediaType: "image/jpeg" },
    ]);
  });

  it("keeps an already-native image block with its declared mime type", () => {
    const out = run({
      messages: [{ role: "user", content: [{ type: "image", image: DATA_URI, mimeType: "image/webp" }] }],
    });
    expect(userContent(out)).toEqual([
      { type: "image", image: DATA_URI, mimeType: "image/webp", mediaType: "image/webp" },
    ]);
  });

  it("never stubs an inlinable image as [image omitted]", () => {
    const out = run({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "see this" }, { type: "image_url", image_url: { url: DATA_URI } }],
      }],
    });
    const texts = userContent(out).filter((b) => b.type === "text").map((b) => b.text);
    expect(texts).not.toContain("[image omitted]");
  });

  it("still tells the model an un-inlinable remote image was there", () => {
    // kRouter has no pre-translation image prefetch, so an http(s) URL cannot be
    // turned into a data URI here. Saying nothing would be worse than the stub.
    const out = run({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    });
    expect(userContent(out)).toEqual([{ type: "text", text: "[image omitted]" }]);
  });
});

describe("openaiToCommandCode puts reasoning_effort inside params", () => {
  it("passes each supported level through unmapped", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(run({ messages: [{ role: "user", content: "hi" }], reasoning_effort: effort }).params.reasoning_effort)
        .toBe(effort);
    }
  });

  it("omits the field for none/off and when the client sent nothing", () => {
    for (const effort of ["none", "off", undefined]) {
      const out = run({ messages: [{ role: "user", content: "hi" }], reasoning_effort: effort });
      expect(out.params.reasoning_effort).toBeUndefined();
    }
  });

  it("never puts reasoning_effort on the envelope wrapper", () => {
    const out = run({ messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" });
    expect(out.reasoning_effort).toBeUndefined();
  });
});

describe("openaiToCommandCode sends a reasoning block ahead of replayed tool calls", () => {
  it("replays the assistant's own reasoning when the client echoed it", () => {
    const out = run({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", reasoning_content: "I should look it up" },
      ],
    });
    expect(out.params.messages[1].content[0]).toEqual({ type: "reasoning", text: "I should look it up" });
  });

  it("adds a placeholder reasoning block on a tool-call turn with no reasoning", () => {
    const out = run({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"p\":\"a\"}" } }],
        },
      ],
    });
    const blocks = out.params.messages[1].content;
    expect(blocks[0]).toEqual({ type: "reasoning", text: " " });
    expect(blocks[blocks.length - 1]).toEqual({
      type: "tool-call", toolCallId: "call_1", toolName: "read", input: { p: "a" },
    });
  });

  it("leaves a plain text assistant turn without a reasoning block", () => {
    const out = run({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    });
    expect(out.params.messages[1].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("ignores a non-string reasoning field instead of stringifying it", () => {
    const out = run({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", reasoning: { exclude: true } },
      ],
    });
    expect(out.params.messages[1].content).toEqual([{ type: "text", text: "ok" }]);
  });
});
