/**
 * Every key kRouter mints shares the `sk-{machineId}` prefix. The 24h/today
 * branch of getUsageStats bucketed byApiKey on maskApiKey(), which kept only
 * those first 8 characters, so every key of one instance collapsed into a
 * single bucket and one holder's usage was shown under another key.
 *
 * Ported from upstream a406381f + 4a57df8b (full-key bucket, first8***last4
 * mask) and 813a0121 (trimmed lookup, masked-key name fallback).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-apikey-attr-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function usage(apiKey, model, promptTokens) {
  return db.saveRequestUsage({
    provider: "openai", model, connectionId: "c1", apiKey,
    tokens: { prompt_tokens: promptTokens, completion_tokens: 1 },
    endpoint: "/v1/chat/completions", status: "ok",
  });
}

function entriesFor(stats, model) {
  return Object.values(stats.byApiKey).filter((e) => e.rawModel === model);
}

describe("usage stats API key attribution", () => {
  it("keeps two keys that share the machine-id prefix in separate live buckets", async () => {
    await usage("sk-machine1-aaaaaa-11111111", "attr-live", 10);
    await usage("sk-machine1-bbbbbb-22222222", "attr-live", 20);

    for (const period of ["24h", "today"]) {
      const entries = entriesFor(await db.getUsageStats(period), "attr-live");
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.promptTokens).sort((a, b) => a - b)).toEqual([10, 20]);
    }
  });

  it("agrees with the daily rollup, which already keyed by the full key", async () => {
    await usage("sk-machine2-cccccc-33333333", "attr-daily", 5);
    await usage("sk-machine2-dddddd-44444444", "attr-daily", 7);

    const live = entriesFor(await db.getUsageStats("24h"), "attr-daily");
    const daily = entriesFor(await db.getUsageStats("7d"), "attr-daily");
    expect(live).toHaveLength(2);
    expect(daily).toHaveLength(2);
  });

  it("masks keys as first8***last4 so same-prefix keys stay distinguishable", async () => {
    await usage("sk-machine3-eeeeee-55555555", "attr-mask", 3);
    await usage("sk-machine3-ffffff-66666666", "attr-mask", 4);

    const masked = entriesFor(await db.getUsageStats("24h"), "attr-mask").map((e) => e.apiKeyMasked).sort();
    expect(masked).toEqual(["sk-machi***5555", "sk-machi***6666"]);
    // The mask never carries the middle of the key.
    for (const m of masked) expect(m).not.toContain("eeeeee");
  });

  it("names a key that is not in the key store by its masked form, not a shared prefix", async () => {
    await usage("sk-machine4-gggggg-77777777", "attr-name", 2);
    await usage("sk-machine4-hhhhhh-88888888", "attr-name", 2);

    for (const period of ["24h", "7d"]) {
      const names = entriesFor(await db.getUsageStats(period), "attr-name").map((e) => e.keyName).sort();
      expect(names).toEqual(["sk-machi***7777", "sk-machi***8888"]);
    }
  });

  it("resolves a stored key's name even when the request carried stray whitespace", async () => {
    const created = await db.createApiKey("Team laptop", "machine5");
    await usage(`${created.key}\n`, "attr-trim", 9);

    const [entry] = entriesFor(await db.getUsageStats("24h"), "attr-trim");
    expect(entry.keyName).toBe("Team laptop");
    expect(entry.apiKeyMasked).toBe(`${created.key.slice(0, 8)}***${created.key.slice(-4)}`);
  });

  it("never ships a raw key in the stats payload, in any period (AUDIT-002)", async () => {
    const rawA = "sk-machine6-iiiiii-99999999";
    const rawB = "sk-machine6-jjjjjj-00000000";
    await usage(rawA, "attr-leak", 1);
    await usage(rawB, "attr-leak", 1);

    for (const period of ["24h", "today", "7d", "30d", "60d", "all"]) {
      const payload = JSON.stringify(await db.getUsageStats(period));
      expect(payload, period).not.toContain(rawA);
      expect(payload, period).not.toContain(rawB);
      expect(payload, period).not.toContain("iiiiii");
    }
  });

  it("puts the live, daily and lastUsed-overlay rows of one key in one bucket", async () => {
    const raw = "sk-machine7-kkkkkk-12121212";
    await usage(raw, "attr-same", 2);
    await usage(raw, "attr-same", 3);

    const live = entriesFor(await db.getUsageStats("24h"), "attr-same");
    const daily = entriesFor(await db.getUsageStats("all"), "attr-same");
    expect(live).toHaveLength(1);
    expect(daily).toHaveLength(1);
    expect(live[0].requests).toBe(2);
    expect(daily[0].requests).toBe(2);
    // The overlay found the daily bucket: lastUsed is a precise timestamp, not a dateKey.
    expect(daily[0].lastUsed).toMatch(/T\d{2}:\d{2}/);
    const liveIds = Object.keys((await db.getUsageStats("24h")).byApiKey).filter((k) => k.includes("attr-same"));
    const dailyIds = Object.keys((await db.getUsageStats("all")).byApiKey).filter((k) => k.includes("attr-same"));
    expect(liveIds).toEqual(dailyIds);
  });

  it("still masks short keys to a single leading character", async () => {
    await usage("short-key-12", "attr-short", 1);
    const [entry] = entriesFor(await db.getUsageStats("24h"), "attr-short");
    expect(entry.apiKeyMasked).toBe("s***");
  });
});
