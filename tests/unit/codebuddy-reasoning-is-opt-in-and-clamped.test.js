// 0.5.165 — CodeBuddy CN forced reasoning_effort:"medium" + reasoning_summary:"auto"
// onto every request the client sent no reasoning on. Upstream removed that in
// d1e98d9a (#2071): the pair trips CodeBuddy's content filter and the answer comes
// back as an error. "medium" is also outside most per-model effort sets.
//
// Second half (upstream e014cb53 + the upstream/master end state): the gateway
// publishes a per-model `supportedEfforts` set and silently clamps anything else,
// so clamp here instead and keep the request inside the published set.
import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";

const exec = new CodeBuddyExecutor();
const run = (model, extra = {}) =>
  exec.transformRequest(model, { messages: [{ role: "user", content: "hi" }], ...extra }, false, {});

describe("CodeBuddy CN reasoning params are opt-in (#2071)", () => {
  it("sends no reasoning params when the client asked for none", () => {
    const out = run("glm-5.2");
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning_summary).toBeUndefined();
    expect(out.stream).toBe(true);
  });

  it("mirrors reasoning_summary:auto only when the client asked for reasoning", () => {
    const out = run("glm-5.1", { reasoning_effort: "high" });
    expect(out.reasoning_effort).toBe("high");
    expect(out.reasoning_summary).toBe("auto");
  });

  it("drops reasoning_effort for none/off and adds no reasoning_summary", () => {
    for (const effort of ["none", "off"]) {
      const out = run("glm-5.2", { reasoning_effort: effort });
      expect(out.reasoning_effort).toBeUndefined();
      expect(out.reasoning_summary).toBeUndefined();
    }
  });

  it("never mutates the caller's body", () => {
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" };
    exec.transformRequest("glm-5.3", body, false, {});
    expect(body.reasoning_effort).toBe("medium");
    expect(body.stream).toBeUndefined();
    expect(body.reasoning_summary).toBeUndefined();
  });
});

describe("CodeBuddy CN clamps reasoning_effort to each model's published set", () => {
  it("keeps a level the model publishes", () => {
    expect(run("glm-5.3", { reasoning_effort: "max" }).reasoning_effort).toBe("max");
    expect(run("deepseek-v4-pro", { reasoning_effort: "xhigh" }).reasoning_effort).toBe("xhigh");
    expect(run("hy3", { reasoning_effort: "low" }).reasoning_effort).toBe("low");
  });

  it("steps an unpublished level down to the next one the model has", () => {
    // glm-5.3: low | high | max — "medium" and "xhigh" are not in the set.
    expect(run("glm-5.3", { reasoning_effort: "medium" }).reasoning_effort).toBe("low");
    expect(run("glm-5.3-flash", { reasoning_effort: "xhigh" }).reasoning_effort).toBe("high");
    // deepseek-v4-pro: low | high | xhigh — "max" is above the ceiling.
    expect(run("deepseek-v4-pro", { reasoning_effort: "max" }).reasoning_effort).toBe("xhigh");
    // hy3: low | high.
    expect(run("hy3", { reasoning_effort: "xhigh" }).reasoning_effort).toBe("high");
  });

  it("raises a level below the model's floor up to that floor", () => {
    // glm-5.2 publishes high | xhigh only.
    expect(run("glm-5.2", { reasoning_effort: "low" }).reasoning_effort).toBe("high");
    expect(run("glm-5.2", { reasoning_effort: "minimal" }).reasoning_effort).toBe("high");
    // hy4-preview publishes exactly one level.
    expect(run("hy4-preview", { reasoning_effort: "low" }).reasoning_effort).toBe("high");
    expect(run("hy4-preview", { reasoning_effort: "max" }).reasoning_effort).toBe("high");
  });

  it("leaves models that publish no set alone", () => {
    for (const model of ["glm-5.1", "kimi-k3-1", "minimax-m3"]) {
      expect(run(model, { reasoning_effort: "medium" }).reasoning_effort).toBe("medium");
    }
  });

  it("clamps the dotted flash id rather than falling through to the pro set", () => {
    // deepseek-v4.1-flash publishes low | high | max; deepseek-v4-pro publishes
    // low | high | xhigh. A prefix match on "deepseek-v4" would use the wrong one.
    expect(run("deepseek-v4.1-flash", { reasoning_effort: "max" }).reasoning_effort).toBe("max");
    expect(run("deepseek-v4.1-flash", { reasoning_effort: "xhigh" }).reasoning_effort).toBe("high");
  });

  it("still drops none/off rather than clamping it up to the floor", () => {
    expect(run("hy4-preview", { reasoning_effort: "none" }).reasoning_effort).toBeUndefined();
    expect(run("glm-5.2", { reasoning_effort: "off" }).reasoning_summary).toBeUndefined();
  });
});
