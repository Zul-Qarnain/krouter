/**
 * 0.5.165 — Claude -> Kiro: images a tool returned (screenshots) used to be
 * JSON.stringify'd into the tool result text when the result had no text
 * block, flooding the context with base64 and losing the image. Kiro tool
 * results are text-only, so the image now rides on the user turn's
 * `images` (upstream f4f06f29, Kiro half).
 */
import { describe, expect, it } from "vitest";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const TOOLS = [{
  name: "screenshot",
  description: "Take a screenshot",
  input_schema: { type: "object", properties: {} }
}];

const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: BASE64 } };

function translate(toolResultContent) {
  return claudeToKiroRequest("claude-sonnet-4.6", {
    tools: TOOLS,
    messages: [
      { role: "user", content: "Take a screenshot." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: toolResultContent }] }
    ]
  }, true, {});
}

describe("Claude -> Kiro tool_result images", () => {
  it("moves an image-only tool result into userInputMessage.images", () => {
    const current = translate([imageBlock]).conversationState.currentMessage.userInputMessage;

    expect(current.images).toEqual([{ format: "png", source: { bytes: BASE64 } }]);
    const resultText = current.userInputMessageContext.toolResults[0].content[0].text;
    expect(resultText).not.toContain(BASE64);
    expect(resultText).toBe("(image attached)");
  });

  it("keeps the tool result text and still forwards the image", () => {
    const current = translate([{ type: "text", text: "Captured 800x600." }, imageBlock])
      .conversationState.currentMessage.userInputMessage;

    expect(current.images).toHaveLength(1);
    expect(current.userInputMessageContext.toolResults[0].content[0].text).toBe("Captured 800x600.");
  });

  it("never puts base64 anywhere in the text the model reads", () => {
    const payload = translate([imageBlock]);
    const texts = JSON.stringify({
      content: payload.conversationState.currentMessage.userInputMessage.content,
      toolResults: payload.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults
    });

    expect(texts).not.toContain(BASE64);
  });

  it("still stringifies a non-image structured result that has no text", () => {
    const current = translate([{ type: "json", value: { ok: true } }])
      .conversationState.currentMessage.userInputMessage;

    expect(current.images).toBeUndefined();
    expect(current.userInputMessageContext.toolResults[0].content[0].text).toContain("\"ok\":true");
  });
});
