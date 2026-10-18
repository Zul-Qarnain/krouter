/**
 * normalizeMessages flattened every message to plain text, so an image block
 * reached Qoder as nothing at all: a vision request silently became a text
 * request about an image the model never saw. Keep image blocks, convert
 * Claude-shaped ones, and fold images into chat_record_id so the same prompt
 * with a different image is a different record (upstream 2ab6a4c9).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async (_credentials, key) => ({ key, max_output_tokens: 1024 })),
  resolveQoderModels: vi.fn(),
  invalidateQoderCatalog: vi.fn(),
  clearQoderCatalog: vi.fn(),
}));

const { __test__ } = await import("../../open-sse/executors/qoder.js");
const { normalizeMessages, buildQoderRequestBody } = __test__;

const DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

describe("normalizeMessages keeps images", () => {
  it("preserves an image_url block with an http URL", () => {
    const { messages } = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ]);
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content).toContainEqual({ type: "text", text: "describe" });
    expect(messages[0].content).toContainEqual({ type: "image_url", image_url: { url: "https://example.com/a.png" } });
  });

  it("preserves a base64 data: URI image", () => {
    const { messages } = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: DATA_URI } },
          { type: "text", text: "what colour?" },
        ],
      },
    ]);
    expect(messages[0].content[0]).toEqual({ type: "image_url", image_url: { url: DATA_URI } });
    expect(messages[0].content.some((b) => b.type === "text" && b.text === "what colour?")).toBe(true);
  });

  it("converts a Claude base64 image block into an image_url data URI", () => {
    const { messages } = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        ],
      },
    ]);
    expect(messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AAAA" },
    });
  });

  it("defaults a Claude image block with no media_type to image/png", () => {
    const { messages } = normalizeMessages([
      { role: "user", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] },
    ]);
    expect(messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("converts a Claude url image block", () => {
    const { messages } = normalizeMessages([
      { role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/b.png" } }] },
    ]);
    expect(messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: "https://example.com/b.png" },
    });
  });

  it("drops image blocks with no usable url but keeps the text as a string", () => {
    const { messages } = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: {} },
          { type: "image", source: { type: "base64" } },
        ],
      },
    ]);
    expect(messages[0].content).toBe("hi");
  });

  it("still flattens text-only multipart content to a string", () => {
    const { messages } = normalizeMessages([
      { role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] },
    ]);
    expect(messages[0].content).toBe("part1\npart2");
  });

  it("keeps hoisting system messages when they are multipart", () => {
    const { messages, systemText } = normalizeMessages([
      { role: "system", content: [{ type: "text", text: "be brief" }] },
      { role: "user", content: [{ type: "image_url", image_url: { url: DATA_URI } }] },
    ]);
    expect(systemText).toBe("be brief");
    expect(messages).toHaveLength(1);
  });
});

describe("buildQoderRequestBody with images", () => {
  const credentials = { accessToken: "t", providerSpecificData: { userId: "u1", machineId: "m1" } };
  const build = (content) => buildQoderRequestBody({
    model: "qoder/auto",
    body: { messages: [{ role: "user", content }], max_tokens: 64 },
    credentials,
  });

  beforeEach(() => vi.clearAllMocks());

  it("gives the same prompt with a different image a different chat_record_id", async () => {
    const a = await build([{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }]);
    const b = await build([{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "https://example.com/b.png" } }]);
    expect(a.payload.chat_record_id).not.toBe(b.payload.chat_record_id);
  });

  it("is still stable for the same prompt and image", async () => {
    const a = await build([{ type: "image_url", image_url: { url: DATA_URI } }, { type: "text", text: "hi" }]);
    const b = await build([{ type: "image_url", image_url: { url: DATA_URI } }, { type: "text", text: "hi" }]);
    expect(a.payload.chat_record_id).toBe(b.payload.chat_record_id);
  });

  it("uses the text of a multipart user message as the chat context text", async () => {
    const { payload } = await build([
      { type: "text", text: "describe the picture" },
      { type: "image_url", image_url: { url: DATA_URI } },
    ]);
    expect(payload.chat_context.text).toBe("describe the picture");
    expect(payload.chat_context.extra.originalContent).toBe("describe the picture");
  });

  it("sends the image block through to the payload messages", async () => {
    const { payload } = await build([{ type: "image_url", image_url: { url: DATA_URI } }]);
    expect(payload.messages[0].content).toContainEqual({ type: "image_url", image_url: { url: DATA_URI } });
  });
});
