// 0.5.165 (upstream f4f06f29, OpenAI half) — an image returned inside a Claude
// tool_result (an MCP screenshot tool, say) was JSON-stringified into the OpenAI
// tool message: the model got a wall of base64 text instead of the picture. The
// OpenAI tool role is text-only, so the image now rides in the user message that
// follows the tool messages, tagged with the tool call it came from.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } };

const screenshotTurn = (resultContent) => ({
  model: "claude-x",
  max_tokens: 1024,
  tools: [{ name: "mcp__browser__computer", description: "browser", input_schema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: "take a screenshot" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__browser__computer", input: { action: "screenshot" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: resultContent }] },
  ],
});

const run = (body) => translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-x", body, true, null, "openai");

describe("tool_result images reach OpenAI-format upstreams", () => {
  it("keeps the tool text and moves the image into the following user message", () => {
    const out = run(screenshotTurn([{ type: "text", text: "Captured screenshot (1x1, png)" }, image]));
    const toolIdx = out.messages.findIndex((m) => m.role === "tool");
    const toolMsg = out.messages[toolIdx];
    expect(toolMsg.tool_call_id).toBe("toolu_1");
    expect(toolMsg.content).toBe("Captured screenshot (1x1, png)");
    expect(toolMsg.content).not.toContain(PNG);

    const follow = out.messages[toolIdx + 1];
    expect(follow.role).toBe("user");
    expect(Array.isArray(follow.content)).toBe(true);
    const img = follow.content.find((p) => p.type === "image_url");
    expect(img.image_url.url).toBe(`data:image/png;base64,${PNG}`);
    expect(follow.content.find((p) => p.type === "text").text).toContain("toolu_1");
  });

  it("never dumps base64 into a tool message that had only an image", () => {
    const out = run(screenshotTurn([image]));
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).not.toContain(PNG);
    expect(typeof toolMsg.content).toBe("string");
    expect(toolMsg.content.length).toBeGreaterThan(0);
    expect(out.messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"))).toBe(true);
  });

  it("leaves text-only tool results exactly as before", () => {
    const out = run(screenshotTurn("plain result"));
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("plain result");
    expect(out.messages[out.messages.length - 1]).toBe(toolMsg);

    const out2 = run(screenshotTurn([{ type: "text", text: "a" }, { type: "text", text: "b" }]));
    const toolMsg2 = out2.messages.find((m) => m.role === "tool");
    expect(toolMsg2.content).toBe("a\nb");
    expect(out2.messages[out2.messages.length - 1]).toBe(toolMsg2);
  });

  it("does not mutate the client's Claude body", () => {
    const body = screenshotTurn([{ type: "text", text: "shot" }, image]);
    const before = JSON.stringify(body);
    run(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("puts images from parallel tool results after all the tool messages", () => {
    const body = screenshotTurn([image]);
    body.messages[1].content.push({ type: "tool_use", id: "toolu_2", name: "mcp__browser__computer", input: {} });
    body.messages[2].content.push({ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "second" }, image] });
    const out = run(body);
    const roles = out.messages.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(["tool", "tool", "user"]);
    const images = out.messages[out.messages.length - 1].content.filter((p) => p.type === "image_url");
    expect(images).toHaveLength(2);
  });
});
