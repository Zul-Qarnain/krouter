// 0.5.166 — three Codex call sites each carried their own hardcoded CLI version,
// and all three had gone stale (upstream a7047a07, ca6e8407).
//
//   open-sse/handlers/imageProviders/codex.js   codex_cli_rs/0.136.0
//   src/app/api/providers/[id]/test/testUtils.js codex_cli_rs/0.136.0
//   src/app/api/providers/[id]/models/route.js   client_version=0.144.6
//
// The last one is the expensive copy: backend-api/codex/models gates every entry
// by `minimal_client_version`, so a stale client_version hides the whole GPT-6
// family from the model picker. Everything now reads CODEX_CLI_VERSION from
// open-sse/config/providers.js, which is also what the chat transport sends.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";
import { CODEX_CLI_VERSION, PROVIDERS } from "../../open-sse/config/providers.js";

const TEST_UTILS = "src/app/api/providers/[id]/test/testUtils.js";
const MODELS_ROUTE = "src/app/api/providers/[id]/models/route.js";

describe("Codex CLI version is single-sourced", () => {
  it("sends the shared version on the image request's user-agent and version headers", () => {
    const headers = codexImageAdapter.buildHeaders({ accessToken: "t", idToken: null });
    expect(headers["user-agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
    expect(headers["version"]).toBe(CODEX_CLI_VERSION);
  });

  it("matches the chat transport's own User-Agent", () => {
    expect(PROVIDERS.codex.headers["User-Agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
  });

  it("leaves no hardcoded codex_cli_rs version in the image adapter", () => {
    const src = readFileSync("open-sse/handlers/imageProviders/codex.js", "utf8");
    expect(src).not.toMatch(/codex_cli_rs\/\d/);
    expect(src).toContain("CODEX_CLI_VERSION");
  });

  it("builds the connection-test User-Agent from the shared constant", () => {
    const src = readFileSync(TEST_UTILS, "utf8");
    expect(src).not.toMatch(/codex_cli_rs\/\d/);
    expect(src).toMatch(/codex_cli_rs\/\$\{CODEX_CLI_VERSION\}/);
  });

  it("asks backend-api/codex/models with the shared client_version", () => {
    const src = readFileSync(MODELS_ROUTE, "utf8");
    expect(src).not.toMatch(/client_version=\d/);
    expect(src).toMatch(/client_version=\$\{CODEX_CLI_VERSION\}/);
  });
});
