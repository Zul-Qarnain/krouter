// 0.5.166 (upstream 468aa7d9) — OpenCode Go's relay answers 400 for every
// `response_format` on its deepseek family (both json_schema and json_object)
// while serving it for glm / kimi / mimo / minimax / qwen / grok on the same
// relay. The rejection body is a bare model echo ({"model":"deepseek-v4.1-flash"})
// that names neither the field nor the reason, so the 400 self-healing in
// base.js cannot classify it and the client keeps re-sending the field: every
// structured-output call to a Go deepseek model fails. Upstream measured 12/12
// structured calls 400 and 4/4 identical calls without the field 200 on
// 2026-10-13. The field has to be dropped, not downgraded.
import { describe, it, expect } from "vitest";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

const exec = new OpenCodeGoExecutor();
const JSON_SCHEMA = {
  type: "json_schema",
  json_schema: { name: "session_title", strict: true, schema: { type: "object" } },
};
const JSON_OBJECT = { type: "json_object" };
const body = (response_format) => ({ messages: [{ role: "user", content: "hi" }], response_format });

describe("OpenCode Go drops response_format for its deepseek family", () => {
  it("drops both structured-output shapes on every deepseek id", () => {
    const models = [
      "deepseek-v4.1-flash",
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ];
    for (const model of models) {
      for (const format of [JSON_SCHEMA, JSON_OBJECT]) {
        const out = exec.transformRequest(model, body(format), true, {});
        expect(out.response_format, `${model} / ${format.type}`).toBeUndefined();
        expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
      }
    }
  });

  it("keeps response_format for the Go models that serve it", () => {
    for (const model of ["glm-5.3-flash", "glm-5.3", "kimi-k3", "mimo-v2.6-flash", "omen-alpha"]) {
      const out = exec.transformRequest(model, body(JSON_SCHEMA), true, {});
      expect(out.response_format, model).toEqual(JSON_SCHEMA);
    }
  });

  it("never mutates the caller's body", () => {
    const original = body(JSON_SCHEMA);
    exec.transformRequest("deepseek-v4.1-flash", original, true, {});
    expect(original.response_format).toEqual(JSON_SCHEMA);
  });

  it("matches deepseek only as a prefix, not anywhere in the id", () => {
    const out = exec.transformRequest("glm-5.3-deepseek-tuned", body(JSON_SCHEMA), true, {});
    expect(out.response_format).toEqual(JSON_SCHEMA);
  });
});
