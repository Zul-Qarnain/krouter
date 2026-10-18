// 0.5.165 (upstream e214fb1c, sort half) — Claude quota rows arrived in
// payload order. `seven_day_*` keys and the new `limits[]` scoped rows are
// appended as Anthropic happens to send them, and the generic PROVIDER_MODELS
// sort cannot help: it keys on model ids ("claude-opus-5-5"), never on quota
// row names ("weekly opus (7d)"), so every Claude row scored 999 and kept
// insertion order. The Quota Tracker therefore reshuffled between polls.
import { describe, it, expect } from "vitest";
import {
  parseQuotaData,
  getRemainingPercentage,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

const row = (used) => ({ used, total: 100, remaining: 100 - used, resetAt: null });

describe("Claude quota row order", () => {
  it("renders session, weekly, fable, opus, sonnet regardless of payload order", () => {
    const parsed = parseQuotaData("claude", {
      quotas: {
        "weekly sonnet (7d)": row(40),
        "weekly opus (7d)": row(30),
        "weekly fable (7d)": row(20),
        "weekly (7d)": row(10),
        "session (5h)": row(5),
      },
    });

    expect(parsed.map((q) => q.name)).toEqual([
      "session (5h)",
      "weekly (7d)",
      "weekly fable (7d)",
      "weekly opus (7d)",
      "weekly sonnet (7d)",
    ]);
  });

  it("keeps unknown rows after the canonical ones, in payload order", () => {
    const parsed = parseQuotaData("claude", {
      quotas: {
        "weekly haiku (7d)": row(1),
        "weekly zebra (7d)": row(2),
        "session (5h)": row(3),
      },
    });

    expect(parsed.map((q) => q.name)).toEqual([
      "session (5h)",
      "weekly haiku (7d)",
      "weekly zebra (7d)",
    ]);
  });

  it("leaves the single error row untouched", () => {
    const parsed = parseQuotaData("claude", { message: "Claude connected. Usage API rate-limited." });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("error");
    expect(parsed[0].message).toContain("rate-limited");
  });

  // Upstream e214fb1c also forwarded `remaining` / `remainingPercentage` through
  // the claude branch. That was only load-bearing for its fabricated Fable row;
  // with the real payload shape the bar reads the same either way, so kRouter
  // keeps the narrower branch. This pins that equivalence.
  it("renders the right bar for a scoped row without forwarding remaining", () => {
    const [session, weekly, fable] = parseQuotaData("claude", {
      quotas: {
        "weekly fable (7d)": { used: 42, total: 100, remaining: 58, remainingPercentage: 58 },
        "session (5h)": { used: 0, total: 100, remaining: 100, remainingPercentage: 100 },
        "weekly (7d)": { used: 100, total: 100, remaining: 0, remainingPercentage: 0 },
      },
    });
    expect(getRemainingPercentage(session)).toBe(100);
    expect(getRemainingPercentage(weekly)).toBe(0);
    expect(getRemainingPercentage(fable)).toBe(58);
  });

  it("does not change the order other providers get", () => {
    const parsed = parseQuotaData("codex", {
      quotas: {
        weekly: { used: 2, total: 100, remaining: 98 },
        session: { used: 1, total: 100, remaining: 99 },
      },
    });
    expect(parsed.map((q) => q.name)).toEqual(["weekly", "session"]);
  });
});
