import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Codex card read the first `base_url` anywhere in ~/.codex/config.toml.
 * Apply writes [model_providers.krouter] after any provider table already in
 * the file (confbox keeps table order), so with another provider configured
 * the card showed that provider's URL as "Current" and flagged a working
 * kRouter setup as "Other". The route now reports the provider Codex actually
 * uses (`model_provider` -> [model_providers.<name>]) and the card reads that
 * (upstream 8f20daac). The GET also has to be dynamic so the refetch after
 * Apply never shows the old file.
 */
const { GET, POST } = await import("../../src/app/api/cli-tools/codex-settings/route.js");

const ROUTE = path.join(process.cwd(), "src/app/api/cli-tools/codex-settings/route.js");
const CARD = path.join(process.cwd(), "src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js");

let tmpHome;
let savedHome;
let savedUserProfile;
const configFile = () => path.join(tmpHome, ".codex", "config.toml");
const writeConfig = (text) => {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), text);
};
const status = async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  return res.json();
};

// Another router configured before kRouter, as in the upstream report.
const OTHER_PROVIDER_FIRST = `model = "gpt-5"
model_provider = "openai"

[model_providers.omniroute]
name = "OmniRoute"
base_url = "https://omniroute.example/v1"

[model_providers.omniroute.http_headers]
Authorization = "Bearer omni-key"
`;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-codex-active-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("Codex settings report the active provider", () => {
  it("runs against the temp HOME, not the real one", () => {
    expect(os.homedir()).toBe(tmpHome);
  });

  it("reports kRouter's URL and key after Apply, not the provider listed first", async () => {
    writeConfig(OTHER_PROVIDER_FIRST);
    const res = await POST(new Request("http://localhost/api/cli-tools/codex-settings", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:20128/v1", apiKey: "sk-dashboard-1111", model: "cc/claude-sonnet-4-6" }),
    }));
    expect(res.status).toBe(200);

    // The other provider's table still comes first in the file.
    const text = fs.readFileSync(configFile(), "utf-8");
    expect(text.indexOf("omniroute.example")).toBeLessThan(text.indexOf("127.0.0.1:20128"));

    expect((await status()).activeProvider).toEqual({
      name: "krouter",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-dashboard-1111",
    });
  });

  it("reads an inline http_headers table", async () => {
    writeConfig(`model_provider = "krouter"

[model_providers.krouter]
base_url = "https://my-tunnel.example.com/v1/"
http_headers = { Authorization = "Bearer sk-inline-2222" }
`);
    expect((await status()).activeProvider).toEqual({
      name: "krouter",
      baseUrl: "https://my-tunnel.example.com/v1/",
      apiKey: "sk-inline-2222",
    });
  });

  it("reports no URL when the active provider is a built-in one", async () => {
    writeConfig(OTHER_PROVIDER_FIRST);
    expect((await status()).activeProvider).toEqual({ name: "openai", baseUrl: "", apiKey: "" });
  });

  it("reports no active provider when none is set or the file does not parse", async () => {
    writeConfig(`model = "gpt-5"\n`);
    expect((await status()).activeProvider).toBeNull();

    writeConfig(`model_provider = "krouter"\n[model_providers.krouter\nbase_url = "x"\n`);
    const data = await status();
    expect(data.installed).toBe(true);
    expect(data.activeProvider).toBeNull();
  });
});

describe("Codex card reads the active provider", () => {
  const route = fs.readFileSync(ROUTE, "utf-8");
  const card = fs.readFileSync(CARD, "utf-8");

  it("the status route is dynamic and not a Server Action file", () => {
    // A "use server" file may export only async functions, so it cannot carry the dynamic flag.
    expect(route).not.toMatch(/^"use server";/m);
    expect(route).toContain('export const dynamic = "force-dynamic";');
  });

  it("the card refetches without the browser cache after Apply", () => {
    expect(card).toContain('fetch("/api/cli-tools/codex-settings", { cache: "no-store" })');
  });

  it("the card no longer takes the first base_url in the file", () => {
    expect(card).not.toMatch(/match\(\/base_url/);
    expect(card).toContain("activeProvider");
  });
});
