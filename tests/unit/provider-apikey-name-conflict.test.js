// 0.5.165 — adding an API key under a name that already exists for the provider
// used to replace the stored key silently (connectionsRepo upserted apikey rows
// BY NAME with { ...existing, ...data }). Now the repo refuses with a typed
// PROVIDER_NAME_CONFLICT unless the caller opts in, and POST /api/providers
// answers 409. Upstream 239bcfc5 + 57c04f00 (its tests wrote to the real user
// DB, so every case here runs against a temp DATA_DIR).
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

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-name-conflict-"));
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

describe("apikey name collision is refused instead of overwriting the key", () => {
  it("throws PROVIDER_NAME_CONFLICT and leaves the stored key untouched", async () => {
    const orig = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-original" });

    await expect(
      db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-replacement" })
    ).rejects.toMatchObject({ code: "PROVIDER_NAME_CONFLICT", existingId: orig.id, existingName: "Main" });

    const list = await db.getProviderConnections({ provider: "openai" });
    expect(list).toHaveLength(1);
    expect(list[0].apiKey).toBe("sk-original");
  });

  it("replaces the key when the caller passes allowOverwrite: true, and does not store the flag", async () => {
    const orig = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-original" });

    const updated = await db.createProviderConnection({
      provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-replacement", allowOverwrite: true,
    });

    expect(updated.id).toBe(orig.id);
    const back = await db.getProviderConnectionById(orig.id);
    expect(back.apiKey).toBe("sk-replacement");
    expect(back).not.toHaveProperty("allowOverwrite");
  });

  it("treats an explicit id of the colliding row as an edit, and refuses any other id", async () => {
    const orig = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-original" });
    const other = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Other", apiKey: "sk-other" });

    await expect(
      db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-x", id: other.id })
    ).rejects.toMatchObject({ code: "PROVIDER_NAME_CONFLICT", existingId: orig.id });

    const edited = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-edit", id: orig.id });
    expect(edited.id).toBe(orig.id);
    expect((await db.getProviderConnectionById(orig.id)).apiKey).toBe("sk-edit");
    expect((await db.getProviderConnectionById(other.id)).apiKey).toBe("sk-other");
  });

  it("does not collide across providers", async () => {
    const a = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "Main", apiKey: "sk-a" });
    const b = await db.createProviderConnection({ provider: "groq", authType: "apikey", name: "Main", apiKey: "gsk-b" });
    expect(b.id).not.toBe(a.id);
  });

  it("still merges an OAuth re-login onto the same account (no conflict for oauth rows)", async () => {
    const first = await db.createProviderConnection({ provider: "claude", authType: "oauth", email: "me@example.com", accessToken: "old" });
    const again = await db.createProviderConnection({ provider: "claude", authType: "oauth", email: "me@example.com", accessToken: "new" });
    expect(again.id).toBe(first.id);
    expect((await db.getProviderConnectionById(first.id)).accessToken).toBe("new");
  });
});

describe("POST /api/providers maps the name conflict to 409", () => {
  it("answers 409 with the existing row and keeps the first key", async () => {
    mockNextServer();
    const { POST } = await import("@/app/api/providers/route.js");
    const models = await import("@/models/index.js");

    const first = await POST(postProvider({ provider: "openai", name: "Work", apiKey: "sk-first" }));
    expect(first.status).toBe(201);
    const { connection } = await first.json();

    const second = await POST(postProvider({ provider: "openai", name: "Work", apiKey: "sk-second" }));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body).toMatchObject({ code: "PROVIDER_NAME_CONFLICT", existingId: connection.id, existingName: "Work" });
    expect(body.error).toMatch(/already exists/i);

    const stored = await models.getProviderConnections({ provider: "openai" });
    expect(stored).toHaveLength(1);
    expect(stored[0].apiKey).toBe("sk-first");
  });

  it("replaces the key when the request opts in with allowOverwrite", async () => {
    mockNextServer();
    const { POST } = await import("@/app/api/providers/route.js");
    const models = await import("@/models/index.js");

    await POST(postProvider({ provider: "openai", name: "Work", apiKey: "sk-first" }));
    const res = await POST(postProvider({ provider: "openai", name: "Work", apiKey: "sk-second", allowOverwrite: true }));
    expect(res.status).toBe(201);

    const stored = await models.getProviderConnections({ provider: "openai" });
    expect(stored).toHaveLength(1);
    expect(stored[0].apiKey).toBe("sk-second");
  });

  it("keeps the row's place in the pool when an API overwrite omits priority", async () => {
    mockNextServer();
    const { POST } = await import("@/app/api/providers/route.js");
    const models = await import("@/models/index.js");

    await POST(postProvider({ provider: "openai", name: "First", apiKey: "sk-1" }));
    await POST(postProvider({ provider: "openai", name: "Second", apiKey: "sk-2" }));
    const res = await POST(postProvider({ provider: "openai", name: "Second", apiKey: "sk-2b", allowOverwrite: true }));
    expect(res.status).toBe(201);

    const stored = await models.getProviderConnections({ provider: "openai" });
    expect(stored.map((c) => [c.name, c.priority])).toEqual([["First", 1], ["Second", 2]]);
    expect(stored[1].apiKey).toBe("sk-2b");
  });
});
