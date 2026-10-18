// 0.5.166 (upstream f6e7cabe) — getClineAccessToken prefixed EVERY token with
// "workos:". That is right for Cline OAuth access tokens (WorkOS JWTs, "eyJ...")
// but wrong for ClinePass API keys ("clp_..."), which api.cline.bot accepts only
// verbatim, so every ClinePass API-key request came back 401.
import { describe, expect, it } from "vitest";
import {
  getClineAccessToken,
  getClineAuthorizationHeader,
  buildClineHeaders,
} from "../../src/shared/utils/clineAuth.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln";

describe("getClineAccessToken", () => {
  it("prefixes a bare WorkOS JWT with workos:", () => {
    expect(getClineAccessToken(JWT)).toBe(`workos:${JWT}`);
  });

  it("keeps an existing workos: prefix and never doubles it", () => {
    expect(getClineAccessToken(`workos:${JWT}`)).toBe(`workos:${JWT}`);
    expect(getClineAccessToken(`  workos:${JWT}  `)).toBe(`workos:${JWT}`);
    expect(getClineAccessToken(`WorkOS:${JWT}`)).toBe(`WorkOS:${JWT}`);
  });

  it("sends a ClinePass API key verbatim", () => {
    expect(getClineAccessToken("clp_1234567890abcdef")).toBe("clp_1234567890abcdef");
    expect(getClineAccessToken("  clp_abc  ")).toBe("clp_abc");
  });

  it("does not treat an opaque eyJ-looking string without a JWT body as a JWT", () => {
    expect(getClineAccessToken("eyJnotajwt")).toBe("eyJnotajwt");
  });

  it("returns an empty string for empty or non-string input", () => {
    expect(getClineAccessToken("")).toBe("");
    expect(getClineAccessToken("   ")).toBe("");
    expect(getClineAccessToken(undefined)).toBe("");
    expect(getClineAccessToken(null)).toBe("");
    expect(getClineAccessToken(42)).toBe("");
  });
});

describe("Cline Authorization header", () => {
  it("builds Bearer headers for both token shapes", () => {
    expect(getClineAuthorizationHeader("clp_abc")).toBe("Bearer clp_abc");
    expect(getClineAuthorizationHeader(JWT)).toBe(`Bearer workos:${JWT}`);
    expect(buildClineHeaders("clp_abc").Authorization).toBe("Bearer clp_abc");
  });

  it("reaches the wire unprefixed for a ClinePass API-key connection", () => {
    const headers = new DefaultExecutor("clinepass").buildHeaders({ apiKey: "clp_live_key" });
    expect(headers.Authorization).toBe("Bearer clp_live_key");
  });

  it("still prefixes a Cline OAuth access token on the wire", () => {
    const headers = new DefaultExecutor("cline").buildHeaders({ accessToken: JWT });
    expect(headers.Authorization).toBe(`Bearer workos:${JWT}`);
  });
});
