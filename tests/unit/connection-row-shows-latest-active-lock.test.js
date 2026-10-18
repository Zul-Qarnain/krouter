// 0.5.165 (kRouter-own) — the connection card's cooldown timer took the
// EARLIEST modelLock_* value, expired ones included. Expired keys are only
// cleared by a success, which a held account never gets, so a month-long
// account-wide hold next to an old 2s model lock showed "unavailable" with no
// countdown at all. The card now counts down to the latest lock still running.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getLatestModelLockUntil } from "../../open-sse/services/accountFallback.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

describe("getLatestModelLockUntil", () => {
  it("skips expired locks and returns the latest active one", () => {
    const conn = {
      id: "c1",
      "modelLock_claude-sonnet-5": iso(NOW - 10_000),          // stale 2s lock, never cleared
      modelLock___all: iso(Date.UTC(2026, 10, 1)),              // monthly hold
      "modelLock_claude-haiku-5": iso(NOW + 60_000),
    };
    expect(getLatestModelLockUntil(conn, NOW)).toBe(iso(Date.UTC(2026, 10, 1)));
  });

  it("returns null when every lock has expired or none is set", () => {
    expect(getLatestModelLockUntil({ modelLock_a: iso(NOW - 1), modelLock_b: null }, NOW)).toBeNull();
    expect(getLatestModelLockUntil({ id: "x", testStatus: "unavailable" }, NOW)).toBeNull();
    expect(getLatestModelLockUntil(null, NOW)).toBeNull();
  });

  it("ignores unparsable values", () => {
    expect(getLatestModelLockUntil({ modelLock_a: "garbage", modelLock_b: iso(NOW + 5_000) }, NOW)).toBe(iso(NOW + 5_000));
  });
});

describe("ConnectionRow uses it for the timer", () => {
  const src = readFileSync("src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js", "utf8");

  it("imports the helper instead of sorting raw lock values", () => {
    expect(src).toContain("getLatestModelLockUntil");
    expect(src).not.toMatch(/\.filter\(v => !!v\)\s*\.sort\(\)\[0\]/);
  });

  it("feeds the timer the active lock", () => {
    expect(src).toMatch(/<CooldownTimer until=\{cooldownUntil\} \/>/);
  });
});
