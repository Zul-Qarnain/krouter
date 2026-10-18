/**
 * 0.5.165 — a user turn that only carries tool results needs placeholder text
 * (Kiro rejects empty content), but "continue" reads like a new instruction:
 * models answer the word itself ("Nothing in progress to continue") and drop
 * the task they were in the middle of (upstream 82b1bca4).
 */
import { describe, expect, it } from "vitest";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const PLACEHOLDER = "Tool results provided.";

const TOOLS_OPENAI = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  }
}];

const TOOLS_CLAUDE = [{
  name: "get_weather",
  description: "Get weather",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
}];

describe("Kiro tool-result-only user turns", () => {
  it("OpenAI -> Kiro: a tool message gets the neutral placeholder, not \"continue\"", () => {
    const payload = buildKiroPayload("claude-sonnet-4.6", {
      tools: TOOLS_OPENAI,
      messages: [
        { role: "user", content: "The secret word is PINEAPPLE. Weather in Jakarta?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Jakarta\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "32C, humid" }
      ]
    }, true, {});

    const current = payload.conversationState.currentMessage.userInputMessage;
    expect(current.content).toContain(PLACEHOLDER);
    expect(current.content).not.toMatch(/\bcontinue\b/);
    expect(current.userInputMessageContext.toolResults).toHaveLength(1);
    expect(payload.conversationState.history[0].userInputMessage.content).toContain("PINEAPPLE");
  });

  it("Claude -> Kiro: a tool_result-only user message gets the neutral placeholder", () => {
    const payload = claudeToKiroRequest("claude-sonnet-4.6", {
      tools: TOOLS_CLAUDE,
      messages: [
        { role: "user", content: "Weather in Jakarta?" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Jakarta" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "32C, humid" }] }
      ]
    }, true, {});

    const current = payload.conversationState.currentMessage.userInputMessage;
    expect(current.content).toContain(PLACEHOLDER);
    expect(current.content).not.toMatch(/\bcontinue\b/);
    expect(current.userInputMessageContext.toolResults).toHaveLength(1);
  });

  it.each([
    ["OpenAI", buildKiroPayload, TOOLS_OPENAI, [
      { role: "user", content: "Weather in Jakarta?" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Jakarta\"}" } }] },
      { role: "tool", tool_call_id: "t1", content: "32C" },
      { role: "assistant", content: "It is 32C." },
      { role: "user", content: "Hot or cold?" }
    ]],
    ["Claude", claudeToKiroRequest, TOOLS_CLAUDE, [
      { role: "user", content: "Weather in Jakarta?" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Jakarta" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "32C" }] },
      { role: "assistant", content: "It is 32C." },
      { role: "user", content: "Hot or cold?" }
    ]]
  ])("%s -> Kiro: a history turn with tool results and no text uses the placeholder", (_name, translate, tools, messages) => {
    const payload = translate("claude-sonnet-4.6", { tools, messages }, true, {});

    const history = payload.conversationState.history;
    expect(history[2].userInputMessage.content).toBe(PLACEHOLDER);
    expect(history[2].userInputMessage.userInputMessageContext.toolResults).toHaveLength(1);
  });

  it("keeps real user text when a turn has both text and tool results", () => {
    const payload = claudeToKiroRequest("claude-sonnet-4.6", {
      tools: TOOLS_CLAUDE,
      messages: [
        { role: "user", content: "Weather in Jakarta?" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Jakarta" } }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "32C" },
          { type: "text", text: "Now answer in one word." }
        ] }
      ]
    }, true, {});

    const current = payload.conversationState.currentMessage.userInputMessage;
    expect(current.content).toContain("Now answer in one word.");
    expect(current.content).not.toContain(PLACEHOLDER);
  });

  it.each([
    ["OpenAI", buildKiroPayload],
    ["Claude", claudeToKiroRequest]
  ])("%s -> Kiro: an empty turn without tool results still falls back to \"continue\"", (_name, translate) => {
    const payload = translate("claude-sonnet-4.6", { messages: [{ role: "user", content: "" }] }, true, {});

    const current = payload.conversationState.currentMessage.userInputMessage;
    expect(current.content.endsWith("continue")).toBe(true);
    expect(current.content).not.toContain(PLACEHOLDER);
  });
});
