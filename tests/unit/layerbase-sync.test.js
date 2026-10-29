import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isLayerbaseSyncEnabled,
  SYNC_TABLES,
  syncFromLayerbase,
  syncTableToLayerbase,
  initLayerbaseSync,
  scheduleSyncTable,
} from "@/lib/db/layerbaseSync.js";

const mocks = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockEnd: vi.fn(),
}));

vi.mock("@/lib/auth/betterAuthServer.js", () => ({
  getDbPool: () => ({
    connect: vi.fn(async () => ({
      query: mocks.mockQuery,
      release: mocks.mockRelease,
    })),
    end: mocks.mockEnd,
  }),
}));

describe("layerbaseSync", () => {
  const origEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgres://layerbase:test@localhost:5432/krouter";
  });

  afterEach(() => {
    process.env.DATABASE_URL = origEnv;
  });

  it("checks if layerbase sync is enabled correctly", () => {
    expect(isLayerbaseSyncEnabled()).toBe(true);
    delete process.env.DATABASE_URL;
    expect(isLayerbaseSyncEnabled()).toBe(false);
  });

  it("includes all core configuration tables in SYNC_TABLES", () => {
    expect(SYNC_TABLES).toHaveProperty("providerConnections");
    expect(SYNC_TABLES).toHaveProperty("settings");
    expect(SYNC_TABLES).toHaveProperty("combos");
    expect(SYNC_TABLES).toHaveProperty("apiKeys");
    expect(SYNC_TABLES).toHaveProperty("usageDaily");
    expect(SYNC_TABLES).toHaveProperty("kv");
  });

  it("hydrates local SQLite from Layerbase on startup when remote rows exist", async () => {
    mocks.mockQuery.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM providerConnections")) {
        return {
          rows: [
            {
              id: "conn-1",
              provider: "xai",
              authType: "oauth",
              name: "xAI Main",
              email: "test@xai.com",
              priority: 1,
              isActive: 1,
              data: "{}",
              createdAt: "2026-10-29",
              updatedAt: "2026-10-29",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const fakeAdapter = {
      get: vi.fn(() => ({ c: 0 })),
      all: vi.fn(() => []),
      run: vi.fn(),
      transaction: vi.fn((fn) => fn()),
    };

    await syncFromLayerbase(fakeAdapter);

    expect(fakeAdapter.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR REPLACE INTO providerConnections"),
      expect.arrayContaining(["conn-1", "xai", "xAI Main"])
    );
    expect(mocks.mockRelease).toHaveBeenCalled();
  });

  it("syncs local rows to Layerbase via upsert", async () => {
    const fakeAdapter = {
      all: vi.fn((sql) => {
        if (sql.includes("providerConnections")) {
          return [
            {
              id: "conn-coder",
              provider: "qoder",
              authType: "oauth",
              name: "Coder Account",
              email: "coder@example.com",
              priority: 1,
              isActive: 1,
              data: '{"token":"123"}',
              createdAt: "2026-10-29",
              updatedAt: "2026-10-29",
            },
          ];
        }
        return [];
      }),
    };

    mocks.mockQuery.mockResolvedValue({ rows: [] });

    await syncTableToLayerbase("providerConnections", fakeAdapter);

    expect(mocks.mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO providerConnections"),
      expect.arrayContaining(["conn-coder", "qoder", "Coder Account"])
    );
    expect(mocks.mockRelease).toHaveBeenCalled();
  });

  it("hooks adapter write operations to trigger background sync", async () => {
    mocks.mockQuery.mockResolvedValue({ rows: [] });

    const fakeAdapter = {
      get: vi.fn(() => ({ c: 0 })),
      all: vi.fn(() => []),
      run: vi.fn(),
      exec: vi.fn(),
      transaction: vi.fn((fn) => fn()),
    };

    await initLayerbaseSync(fakeAdapter);

    // Run an update on providerConnections
    fakeAdapter.run("UPDATE providerConnections SET priority = 2 WHERE id = 'conn-1'");

    // Wait for debounced sync timer
    await new Promise((r) => setTimeout(r, 250));

    // Ensure Layerbase query was executed
    expect(mocks.mockQuery).toHaveBeenCalled();
  });
});
