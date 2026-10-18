// 0.5.165 (upstream 84035760 + cbffeb97) — Anthropic answers Opus 5.5 requests from
// a claude-cli older than 2.1.280 with 400 `claude_code_version_too_old`. kRouter
// spoofs the version in two places (the User-Agent and the billing header in the
// system prompt); both must report the same, current version, from one constant.
import { describe, it, expect } from "vitest";
import { CLAUDE_CLI_VERSION, CLAUDE_CLI_SPOOF_HEADERS, PROVIDERS } from "../../open-sse/config/providers.js";
import { applyCloaking } from "../../open-sse/utils/claudeCloaking.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

function versionParts(v) {
  return String(v).split(".").map(Number);
}

describe("spoofed Claude Code version", () => {
  it("is at least 2.1.280, the floor Opus 5.5 accepts", () => {
    const [major, minor, patch] = versionParts(CLAUDE_CLI_VERSION);
    expect(major).toBe(2);
    expect(minor).toBe(1);
    expect(patch).toBeGreaterThanOrEqual(280);
  });

  it("is the version in the User-Agent the claude provider sends", () => {
    expect(CLAUDE_CLI_SPOOF_HEADERS["User-Agent"]).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`);
    expect(PROVIDERS.claude.headers["User-Agent"]).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`);
    const headers = new DefaultExecutor("claude").buildHeaders({ accessToken: "sk-ant-oat-x" }, true, null, "claude-opus-5-5");
    expect(headers["User-Agent"]).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`);
  });

  it("is the version in the billing header", () => {
    const body = applyCloaking({ messages: [] }, "sk-ant-oat-test", "session-id");
    const escaped = CLAUDE_CLI_VERSION.replace(/\./g, "\\.");
    expect(body.system[0].text).toMatch(new RegExp(`^x-anthropic-billing-header: cc_version=${escaped}\\.`));
  });
});
