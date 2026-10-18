// 0.5.165 — every insert loaded the whole provider pool and renumbered every
// row's priority inside the transaction (O(pool) per key, O(n*m) for a bulk
// import). A new row with no explicit priority now gets MAX(priority)+1 and the
// pool is left alone; an explicit priority (the dashboard always sends one) still
// renumbers, so "priority 1 = first" keeps working. Upstream 239bcfc5.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

function closeDb() {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
}

function mockNextServer() {
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
}

function postProvider(body) {
  return new Request("https://krouter.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seed(provider, n) {
  for (let i = 0; i < n; i++) {
    await db.createProviderConnection({ provider, authType: "apikey", name: `seed-${i}`, apiKey: `k${i}` });
  }
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-insert-order-"));
  process.env.DATA_DIR = tempDir;
  // The DB adapter is cached on global (survives Next.js hot reload), so a fresh
  // DATA_DIR needs a fresh adapter.
  closeDb();
  vi.resetModules();
  db = await import("@/lib/db/index.js");
});

afterEach(() => {
  vi.doUnmock("next/server");
  vi.resetModules();
  closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("insert without an explicit priority appends at MAX(priority)+1", () => {
  it("keeps a large pool in insertion order with sequential priorities", async () => {
    await seed("openai", 60);
    const list = await db.getProviderConnections({ provider: "openai" });
    expect(list).toHaveLength(60);
    expect(list.map((c) => c.priority)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(list[0].name).toBe("seed-0");
    expect(list[59].name).toBe("seed-59");
  });

  it("does not renumber the existing rows (a gap survives the insert)", async () => {
    await seed("openai", 2);
    const [a, b] = await db.getProviderConnections({ provider: "openai" });
    // Open a gap without a reorder pass: priority 2 -> 5 written straight into the row.
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`UPDATE providerConnections SET priority = 5 WHERE id = ?`, [b.id]);

    const added = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "new", apiKey: "k-new" });

    expect(added.priority).toBe(6);
    expect((await db.getProviderConnectionById(a.id)).priority).toBe(1);
    expect((await db.getProviderConnectionById(b.id)).priority).toBe(5);
  });

  it("still renumbers when an explicit priority is given (priority 1 goes first)", async () => {
    await seed("openai", 3);
    // reorderInTx breaks a priority tie by updatedAt (newest first); keep the
    // timestamps apart so the tie-break is the one under test.
    await new Promise((r) => setTimeout(r, 10));
    const added = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "front", apiKey: "k-front", priority: 1 });
    const list = await db.getProviderConnections({ provider: "openai" });
    expect(list[0].id).toBe(added.id);
    expect(list.map((c) => c.priority)).toEqual([1, 2, 3, 4]);
  });

  it("still renumbers on delete, so gaps do not accumulate", async () => {
    await seed("openai", 4);
    const before = await db.getProviderConnections({ provider: "openai" });
    await db.deleteProviderConnection(before[0].id);
    const after = await db.getProviderConnections({ provider: "openai" });
    expect(after.map((c) => c.priority)).toEqual([1, 2, 3]);
  });
});

describe("POST /api/providers without a priority appends instead of renumbering", () => {
  it("adds API-posted keys in request order", async () => {
    mockNextServer();
    const { POST } = await import("@/app/api/providers/route.js");
    for (const name of ["one", "two", "three"]) {
      const res = await POST(postProvider({ provider: "openai", name, apiKey: `sk-${name}` }));
      expect(res.status).toBe(201);
    }
    const list = await db.getProviderConnections({ provider: "openai" });
    expect(list.map((c) => c.name)).toEqual(["one", "two", "three"]);
    expect(list.map((c) => c.priority)).toEqual([1, 2, 3]);
  });

  it("keeps the dashboard's explicit priority 1 = first", async () => {
    mockNextServer();
    const { POST } = await import("@/app/api/providers/route.js");
    await POST(postProvider({ provider: "openai", name: "old", apiKey: "sk-old", priority: 1 }));
    await new Promise((r) => setTimeout(r, 10));
    await POST(postProvider({ provider: "openai", name: "new", apiKey: "sk-new", priority: 1 }));
    const list = await db.getProviderConnections({ provider: "openai" });
    expect(list.map((c) => c.name)).toEqual(["new", "old"]);
    expect(list.map((c) => c.priority)).toEqual([1, 2]);
  });
});
