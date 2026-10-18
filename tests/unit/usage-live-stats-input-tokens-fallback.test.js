/**
 * The 24h/today branch of getUsageStats read only tokens.prompt_tokens /
 * completion_tokens from the stored JSON. Rows recorded in the input_tokens /
 * output_tokens shape (embeddings, Gemini, some Claude-shaped bodies) counted as
 * zero there, while the daily rollup and the history columns counted them -- so
 * "Today" showed less than "7 days" for the same requests.
 *
 * Ported from upstream 813a0121 (token fallback half).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-input-tokens-"));
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

describe("live usage stats count input_tokens rows", () => {
  it("counts an input_tokens/output_tokens row in the 24h and today views", async () => {
    await db.saveRequestUsage({
      provider: "gemini", model: "text-embedding-004", connectionId: "c1",
      tokens: { input_tokens: 40, output_tokens: 7 },
      endpoint: "/v1/embeddings", status: "ok",
    });

    for (const period of ["24h", "today"]) {
      const stats = await db.getUsageStats(period);
      expect(stats.totalPromptTokens).toBe(40);
      expect(stats.totalCompletionTokens).toBe(7);
      expect(stats.byProvider.gemini.promptTokens).toBe(40);
      expect(stats.byModel["text-embedding-004 (gemini)"].completionTokens).toBe(7);
    }
  });

  it("matches the daily rollup for the same rows", async () => {
    const live = await db.getUsageStats("24h");
    const daily = await db.getUsageStats("7d");
    expect(live.byProvider.gemini.promptTokens).toBe(daily.byProvider.gemini.promptTokens);
    expect(live.byProvider.gemini.completionTokens).toBe(daily.byProvider.gemini.completionTokens);
  });
});
