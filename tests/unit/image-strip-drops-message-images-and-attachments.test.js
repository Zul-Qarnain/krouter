// 0.5.165 (upstream 345cdcf6, strip half) — Ollama/Hermes clients put images in
// msg.images[] and the Vercel AI SDK puts them in msg.experimental_attachments /
// msg.attachments, beside a plain string content. 0.5.142 taught combo.js to
// detect those shapes, but stripImagesFromBody only filtered content blocks, so a
// text-only model still received the image and 400'd again on the retry.
import { describe, expect, it } from "vitest";
import { stripImagesFromBody } from "../../open-sse/services/imageCapability.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("stripImagesFromBody — message-level images", () => {
  it("drops msg.images and keeps the string content", () => {
    const body = { messages: [{ role: "user", content: "describe this", images: ["iVBORw0KGgo="] }] };
    const out = stripImagesFromBody(body);
    expect(out.messages[0]).toEqual({ role: "user", content: "describe this" });
  });

  it("drops image attachments and keeps non-image attachments", () => {
    const body = {
      messages: [{
        role: "user",
        content: "summarise these",
        experimental_attachments: [
          { contentType: "image/png", url: PNG },
          { contentType: "text/plain", url: "data:text/plain;base64,aGk=" },
        ],
        attachments: [
          { mediaType: "image/jpeg", url: "https://example.com/a.jpg" },
          { url: "data:image/webp;base64,UklGRg==" },
          { mediaType: "application/pdf", url: "https://example.com/a.pdf" },
        ],
      }],
    };
    const out = stripImagesFromBody(body);
    expect(out.messages[0].experimental_attachments).toEqual([
      { contentType: "text/plain", url: "data:text/plain;base64,aGk=" },
    ]);
    expect(out.messages[0].attachments).toEqual([
      { mediaType: "application/pdf", url: "https://example.com/a.pdf" },
    ]);
    expect(out.messages[0].content).toBe("summarise these");
  });

  it("leaves an image-only message with the omission marker instead of empty content", () => {
    const body = { messages: [{ role: "user", content: "", images: ["iVBORw0KGgo="] }] };
    const out = stripImagesFromBody(body);
    expect(out.messages[0].images).toBeUndefined();
    expect(out.messages[0].content).toMatch(/image omitted/);
  });

  it("strips side images and content blocks on the same message", () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: PNG } },
        ],
        images: ["iVBORw0KGgo="],
      }],
    };
    const out = stripImagesFromBody(body);
    expect(out.messages[0]).toEqual({ role: "user", content: "what is this" });
  });

  it("never mutates the caller's body", () => {
    const msg = {
      role: "user",
      content: "describe this",
      images: ["iVBORw0KGgo="],
      attachments: [{ contentType: "image/png", url: PNG }],
    };
    const body = { messages: [msg] };
    const snapshot = structuredClone(body);
    stripImagesFromBody(body);
    expect(body).toEqual(snapshot);
    expect(body.messages[0]).toBe(msg);
  });

  it("returns the same message object when there is nothing to strip", () => {
    const msg = { role: "user", content: "plain", attachments: [{ contentType: "text/plain", url: "x" }] };
    const out = stripImagesFromBody({ messages: [msg] });
    expect(out.messages[0]).toBe(msg);
  });
});
