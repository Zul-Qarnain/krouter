// 0.5.165 (upstream 4ad1e7a4) — Anthropic stopped shipping model-scoped weekly
// windows as `seven_day_<model>` keys. Fable (and any future scoped model)
// arrives inside `limits[]` as
//   { kind: "weekly_scoped", percent, resets_at, scope: { model: { display_name } } }
// The parser only read `seven_day*`, so the Fable weekly bar never rendered.
//
// The row must come from the payload only. Upstream's first attempt (e214fb1c)
// fabricated a 100%-available Fable row whenever a weekly window existed; that
// lied to every account without a Fable window and was reverted.
import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

const { getClaudeUsage } = await import("../../open-sse/services/usage.js");

let tokenSeq = 0;
// Each case needs its own token: usage.js dedups in flight and caches the last
// good payload per access token.
const freshToken = () => `tok-weekly-scoped-${++tokenSeq}`;

function oauthUsage(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Claude model-scoped weekly limits from limits[]", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it("turns a weekly_scoped limit into a weekly <model> (7d) row", async () => {
    proxyFetchMock.mockResolvedValueOnce(oauthUsage({
      five_hour: { utilization: 10, resets_at: "2026-10-18T12:00:00Z" },
      seven_day: { utilization: 20, resets_at: "2026-10-22T12:00:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 42,
          resets_at: "2026-10-24T09:00:00Z",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    }));

    const usage = await getClaudeUsage(freshToken());

    expect(Object.keys(usage.quotas)).toContain("weekly fable (7d)");
    const fable = usage.quotas["weekly fable (7d)"];
    expect(fable.used).toBe(42);
    expect(fable.total).toBe(100);
    expect(fable.remaining).toBe(58);
    expect(fable.remainingPercentage).toBe(58);
    expect(fable.resetAt).toBe("2026-10-24T09:00:00.000Z");
    expect(fable.unlimited).toBe(false);
  });

  it("never fabricates a scoped row when limits[] carries none", async () => {
    proxyFetchMock.mockResolvedValueOnce(oauthUsage({
      five_hour: { utilization: 10, resets_at: "2026-10-18T12:00:00Z" },
      seven_day: { utilization: 20, resets_at: "2026-10-22T12:00:00Z" },
      limits: [{ kind: "five_hour", percent: 10 }],
    }));

    const usage = await getClaudeUsage(freshToken());

    expect(Object.keys(usage.quotas)).toEqual(["session (5h)", "weekly (7d)"]);
  });

  it("ignores scoped limits with no display name or a non-numeric percent", async () => {
    proxyFetchMock.mockResolvedValueOnce(oauthUsage({
      seven_day: { utilization: 1, resets_at: "2026-10-22T12:00:00Z" },
      limits: [
        { kind: "weekly_scoped", percent: 50, scope: { model: {} } },
        { kind: "weekly_scoped", percent: "50", scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 50, scope: null },
        null,
      ],
    }));

    const usage = await getClaudeUsage(freshToken());

    expect(Object.keys(usage.quotas)).toEqual(["weekly (7d)"]);
  });

  it("clamps percent into 0..100 so a bad payload cannot render a negative bar", async () => {
    proxyFetchMock.mockResolvedValueOnce(oauthUsage({
      limits: [
        { kind: "weekly_scoped", percent: 140, scope: { model: { display_name: "Over" } } },
        { kind: "weekly_scoped", percent: -30, scope: { model: { display_name: "Under" } } },
      ],
    }));

    const usage = await getClaudeUsage(freshToken());

    expect(usage.quotas["weekly over (7d)"].used).toBe(100);
    expect(usage.quotas["weekly over (7d)"].remaining).toBe(0);
    expect(usage.quotas["weekly under (7d)"].used).toBe(0);
    expect(usage.quotas["weekly under (7d)"].remaining).toBe(100);
  });

  it("lower-cases and trims the display name into the row key", async () => {
    proxyFetchMock.mockResolvedValueOnce(oauthUsage({
      limits: [
        { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "  Opus  " } } },
      ],
    }));

    const usage = await getClaudeUsage(freshToken());

    expect(usage.quotas["weekly opus (7d)"].used).toBe(5);
  });

  it("tolerates a non-array limits field", async () => {
    proxyFetchMock.mockResolvedValueOnce(oauthUsage({
      seven_day: { utilization: 7, resets_at: "2026-10-22T12:00:00Z" },
      limits: { kind: "weekly_scoped" },
    }));

    const usage = await getClaudeUsage(freshToken());

    expect(Object.keys(usage.quotas)).toEqual(["weekly (7d)"]);
  });

  it("still parses the legacy seven_day_<model> keys", async () => {
    proxyFetchMock.mockResolvedValueOnce(oauthUsage({
      seven_day: { utilization: 20, resets_at: "2026-10-22T12:00:00Z" },
      seven_day_opus: { utilization: 60, resets_at: "2026-10-22T12:00:00Z" },
      limits: [
        { kind: "weekly_scoped", percent: 42, scope: { model: { display_name: "Fable" } } },
      ],
    }));

    const usage = await getClaudeUsage(freshToken());

    expect(usage.quotas["weekly opus (7d)"].used).toBe(60);
    expect(usage.quotas["weekly fable (7d)"].used).toBe(42);
  });
});
