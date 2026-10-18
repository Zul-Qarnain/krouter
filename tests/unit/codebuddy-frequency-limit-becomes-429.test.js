// 0.5.166 (upstream e706e4f2) — CodeBuddy CN answers a per-model rate limit with
// its own envelope code 6004 ("超出频率限制 ... 请于<time>后重试") on an HTTP status
// that is not 429, so kRouter classified it as a plain upstream error: no
// cross-account fallback, no cooldown, and the retry hammered the same account.
// parseUpstreamError() consults executor.parseError() for every status, so the
// executor is where the mapping belongs.
import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";

const exec = new CodeBuddyExecutor();
const res = (status) => ({ status, statusText: "" });

describe("CodeBuddyExecutor.parseError maps code 6004 to 429 with a reset", () => {
  it("reads the Chinese frequency-limit envelope and its UTC+8 reset", () => {
    const body = JSON.stringify({
      code: 6004,
      message: "当前模型超出频率限制，请于 2026-09-28 14:30:00 后重试",
    });
    const parsed = exec.parseError(res(400), body);
    expect(parsed.status).toBe(429);
    expect(parsed.message).toContain("超出频率限制");
    // No timezone in the text: CodeBuddy CN publishes Beijing time.
    expect(parsed.resetsAtMs).toBe(new Date("2026-09-28T14:30:00+08:00").getTime());
  });

  it("maps the 6004 code even when it arrives on HTTP 200", () => {
    const parsed = exec.parseError(res(200), JSON.stringify({ code: 6004, msg: "限额已用尽" }));
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeNull();
  });

  it("matches the English frequency-limit text without the 6004 code", () => {
    const body = JSON.stringify({
      code: 11000,
      msg: "frequency limit exceeded, please retry after 2026-09-28 12:00:00 UTC+0",
    });
    const parsed = exec.parseError(res(400), body);
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBe(new Date("2026-09-28T12:00:00+00:00").getTime());
  });

  it("honours an explicit UTC offset with minutes", () => {
    const body = JSON.stringify({
      code: 6004,
      msg: "frequency limit, retry after 2026-09-28 12:00:00 UTC+05:30",
    });
    expect(exec.parseError(res(429), body).resetsAtMs)
      .toBe(new Date("2026-09-28T12:00:00+05:30").getTime());
  });

  it("leaves every other CodeBuddy error exactly as it was", () => {
    const body = JSON.stringify({ code: 11101, message: "Non-stream chat request is currently not supported" });
    const parsed = exec.parseError(res(400), body);
    expect(parsed.status).toBe(400);
    expect(parsed.message).toBe(body);
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("does not throw on a non-JSON body", () => {
    const parsed = exec.parseError(res(502), "<html>502 Bad Gateway</html>");
    expect(parsed.status).toBe(502);
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});
