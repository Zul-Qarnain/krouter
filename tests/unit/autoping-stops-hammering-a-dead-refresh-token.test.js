/**
 * 0.5.166 review follow-up to p1-oauth-refresh.
 *
 * The token warmer learned to stop after a refresh token is rejected
 * (deadRefreshTokens + REFRESH_UNRECOVERABLE_CODE), but quota auto-ping did not -
 * and auto-ping is the writer upstream blames for the logouts. With a revoked Codex
 * refresh token the stored expiry never moves, so every 60 s tick POSTed the dead
 * token again, forever, and logged a fresh warning each time.
 *
 * Auto-ping must remember the rejection per connection, keyed on the refresh token
 * itself, so a reconnect (new token) resumes on its own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p) => readFileSync(join(process.cwd(), p), "utf8");
const warmer = read("src/shared/services/tokenWarmer.js");
const autoping = read("src/shared/services/quotaAutoPing.js");

describe("the token warmer's guard (the shape to mirror)", () => {
  it("remembers a rejected refresh token per connection", () => {
    expect(warmer).toMatch(/deadRefreshTokens/);
    expect(warmer).toMatch(/REFRESH_UNRECOVERABLE_CODE/);
  });

  it("keys the memo on the token, so a reconnect clears it", () => {
    expect(warmer).toMatch(/deadRefreshTokens\.get\(conn\.id\) === conn\.refreshToken/);
    expect(warmer).toMatch(/deadRefreshTokens\.set\(conn\.id, conn\.refreshToken\)/);
  });
});

describe("quota auto-ping has the same guard", () => {
  it("imports the unrecoverable-refresh code", () => {
    expect(autoping).toMatch(/REFRESH_UNRECOVERABLE_CODE/);
  });

  it("skips a connection whose stored refresh token was already rejected", () => {
    expect(autoping).toMatch(/deadRefreshTokens\.get\([^)]*\) === [\w.]*refreshToken/);
  });

  it("records the rejection, keyed on the token that was rejected", () => {
    expect(autoping).toMatch(/deadRefreshTokens\.set\([^)]*, [\w.]*refreshToken\)/);
  });

  it("keeps the memo on the shared global, like the warmer", () => {
    expect(autoping).toMatch(/g\.deadRefreshTokens/);
  });

  it("still returns early on an ordinary refresh failure", () => {
    expect(autoping).toMatch(/refresh failed/);
  });
});
