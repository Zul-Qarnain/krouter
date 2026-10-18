/**
 * 0.5.166 (upstream 5798b308) — Google buckets Antigravity chat requests that
 * carry `requestType: "agent"` and answers 429 RESOURCE_EXHAUSTED with no
 * detail, even with quota left. The official Antigravity client omits the field
 * entirely on the chat path, so kRouter must too: in the executor envelope and
 * in both openai -> Cloud Code wrappers. `requestType: "image_gen"` is a
 * different bucket and stays.
 */
import { describe, it, expect } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const ex = () => getExecutor("antigravity");
const creds = { projectId: "proj-1", email: "u@gmail.com", connectionId: "c1" };
const chatBody = () => ({ request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } });

describe("Antigravity chat envelope omits requestType", () => {
  it("the executor does not set requestType on the chat path", () => {
    const out = ex().transformRequest("gemini-3-flash-agent", chatBody(), true, creds);
    expect("requestType" in out).toBe(false);
  });

  it("an inbound requestType is not leaked through the ...body spread", () => {
    // The MITM path forwards the IDE's own envelope, which carries requestType.
    const out = ex().transformRequest("gemini-3-flash-agent", { ...chatBody(), requestType: "agent" }, true, creds);
    expect("requestType" in out).toBe(false);
  });

  it("image generation keeps requestType image_gen", () => {
    const out = ex().transformRequest("gemini-3.1-flash-image", chatBody(), false, creds);
    expect(out.requestType).toBe("image_gen");
  });

  it("the gemini Cloud Code wrapper omits requestType for Antigravity", () => {
    const out = openaiToAntigravityRequest(
      "gemini-3-flash-agent",
      { messages: [{ role: "user", content: "hi" }] },
      true,
      creds,
    );
    expect("requestType" in out).toBe(false);
    expect(out.userAgent).toBe("antigravity");
  });

  it("the Claude Cloud Code wrapper omits requestType", () => {
    const out = openaiToAntigravityRequest(
      "claude-sonnet-4-6",
      { messages: [{ role: "user", content: "hi" }] },
      true,
      creds,
    );
    expect("requestType" in out).toBe(false);
    expect(out.userAgent).toBe("antigravity");
  });

  it("still sends the rest of the envelope the backend requires", () => {
    const out = ex().transformRequest("gemini-3-flash-agent", chatBody(), true, creds);
    expect(out.project).toBe("proj-1");
    expect(out.model).toBe("gemini-3-flash-agent");
    expect(typeof out.requestId).toBe("string");
    expect(out.requestId.length).toBeGreaterThan(0);
    expect(out.request.contents).toBeTruthy();
  });
});
