// 0.5.165 (kRouter-own) — the quota sort ran over the WHOLE combo list after the
// capability sort, so a text-only member with quota data jumped ahead of the
// member that can read the request's image (unknown quota sorts last). The
// image was then stripped at the text-only model. Capability is now a hard
// partition: quota only reorders inside the capable group and inside the rest.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: (provider, model) => (model.startsWith("vision") ? { vision: true } : { vision: false }),
}));
// Only the text-only members have quota data; the vision members have none.
vi.mock("../../open-sse/services/quotaPreflight.js", () => ({
  bestScoreForProviderModel: (provider, model) => ({ "text-a": 90, "text-b": 40, "vision-b": 70 }[model] ?? null),
}));

import { handleComboChat } from "../../open-sse/services/combo.js";

const quietLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

async function firstTried(body, models) {
  const calls = [];
  await handleComboChat({
    body,
    models,
    handleSingleModel: async (_b, m) => { calls.push(m); return ok(); },
    log: quietLog,
  });
  return calls[0];
}

const IMAGE_BODY = {
  messages: [{ role: "user", content: [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ] }],
};
const TEXT_BODY = { messages: [{ role: "user", content: "hello" }] };

describe("combo ordering: capability partition, then quota", () => {
  it("keeps a vision-capable member first for an image request", async () => {
    expect(await firstTried(IMAGE_BODY, ["p/text-a", "p/vision-a"])).toBe("p/vision-a");
  });

  it("lets quota reorder inside the capable group", async () => {
    // vision-b has quota data (70), vision-a has none -> vision-b first.
    expect(await firstTried(IMAGE_BODY, ["p/text-a", "p/vision-a", "p/vision-b"])).toBe("p/vision-b");
  });

  it("still sorts a text-only request purely by quota", async () => {
    expect(await firstTried(TEXT_BODY, ["p/text-b", "p/vision-a", "p/text-a"])).toBe("p/text-a");
  });
});
