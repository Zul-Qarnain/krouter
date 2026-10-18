// 0.5.165 (upstream 6b9dc54d) — cli-chat-proxy.grok.com answers HTTP 426
// "Upgrade Required" to any Grok CLI identity below 1.0.13. kRouter sent 0.2.99,
// so every grok-cli request failed. The version is single-sourced in
// open-sse/config/grokCli.js; these assertions pin both the floor and the
// places that must carry it on the wire.
import { describe, expect, it } from "vitest";
import {
  GROK_CLI_VERSION,
  GROK_CLI_USER_AGENT,
} from "../../open-sse/config/grokCli.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const MIN_ACCEPTED = [1, 0, 13];

function parseSemver(v) {
  return String(v).split(".").map((n) => Number.parseInt(n, 10));
}

function atLeast(version, floor) {
  const parts = parseSemver(version);
  for (let i = 0; i < floor.length; i++) {
    if ((parts[i] || 0) > floor[i]) return true;
    if ((parts[i] || 0) < floor[i]) return false;
  }
  return true;
}

describe("Grok CLI client identity", () => {
  it("is at or above the 1.0.13 floor the proxy enforces", () => {
    expect(atLeast(GROK_CLI_VERSION, MIN_ACCEPTED)).toBe(true);
  });

  it("is the 1.0.44 release upstream verified live", () => {
    expect(GROK_CLI_VERSION).toBe("1.0.44");
  });

  it("carries the same version in the User-Agent and x-grok-client-version", () => {
    expect(GROK_CLI_USER_AGENT).toBe(`grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`);
    const cfg = PROVIDERS["grok-cli"];
    expect(cfg.clientVersion).toBe(GROK_CLI_VERSION);
    expect(cfg.headers["User-Agent"]).toBe(GROK_CLI_USER_AGENT);
    expect(cfg.headers["x-grok-client-version"]).toBe(GROK_CLI_VERSION);
  });
});
