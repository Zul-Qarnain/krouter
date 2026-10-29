import { getDbPool } from "@/lib/auth/betterAuthServer.js";

export const SYNC_TABLES = {
  _meta: { pk: ["key"] },
  settings: { pk: ["id"] },
  providerConnections: { pk: ["id"] },
  providerNodes: { pk: ["id"] },
  proxyPools: { pk: ["id"] },
  apiKeys: { pk: ["id"] },
  combos: { pk: ["id"] },
  kv: { pk: ["scope", "key"] },
  usageDaily: { pk: ["dateKey"] },
};

export function isLayerbaseSyncEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

const pendingSyncTimers = new Map();
let currentAdapter = null;

// Debounce helper to push table changes to Layerbase
export function scheduleSyncTable(tableName) {
  if (!isLayerbaseSyncEnabled() || !currentAdapter || !SYNC_TABLES[tableName]) return;

  if (pendingSyncTimers.has(tableName)) {
    clearTimeout(pendingSyncTimers.get(tableName));
  }

  const timer = setTimeout(() => {
    pendingSyncTimers.delete(tableName);
    syncTableToLayerbase(tableName, currentAdapter).catch((err) => {
      console.warn(`[LayerbaseSync] Failed to sync ${tableName}:`, err.message);
    });
  }, 200);

  pendingSyncTimers.set(tableName, timer);
}

// Build generic UPSERT query for a table row
function buildUpsertSql(tableName, cols, pkCols) {
  const colList = cols.join(", ");
  const valPlaceholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const updateCols = cols.filter((c) => !pkCols.includes(c));

  if (updateCols.length === 0) {
    return `INSERT INTO ${tableName} (${colList}) VALUES (${valPlaceholders}) ON CONFLICT (${pkCols.join(", ")}) DO NOTHING`;
  }

  const updateSet = updateCols.map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${tableName} (${colList}) VALUES (${valPlaceholders}) ON CONFLICT (${pkCols.join(", ")}) DO UPDATE SET ${updateSet}`;
}

export async function syncTableToLayerbase(tableName, adapter) {
  if (!isLayerbaseSyncEnabled()) return;
  const pool = getDbPool();
  if (!pool) return;

  const tableMeta = SYNC_TABLES[tableName];
  if (!tableMeta) return;

  const localRows = adapter.all(`SELECT * FROM ${tableName}`);
  const client = await pool.connect();

  try {
    if (localRows.length === 0) {
      // Clear remote table if local was emptied
      await client.query(`DELETE FROM ${tableName}`);
      return;
    }

    const cols = Object.keys(localRows[0]);
    const upsertSql = buildUpsertSql(tableName, cols, tableMeta.pk);

    // Upsert every local row
    for (const row of localRows) {
      const values = cols.map((c) => row[c]);
      await client.query(upsertSql, values);
    }

    // Delete remote rows that no longer exist locally
    if (tableMeta.pk.length === 1) {
      const pk = tableMeta.pk[0];
      const localPks = localRows.map((r) => r[pk]);
      const placeholders = localPks.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(`DELETE FROM ${tableName} WHERE ${pk} NOT IN (${placeholders})`, localPks);
    }
  } finally {
    client.release();
  }
}

// Restore data from Layerbase into local SQLite on boot
export async function syncFromLayerbase(adapter) {
  if (!isLayerbaseSyncEnabled()) return;
  const pool = getDbPool();
  if (!pool) return;

  const client = await pool.connect();
  let totalRestored = 0;

  try {
    for (const [tableName, meta] of Object.entries(SYNC_TABLES)) {
      let remoteRows = [];
      try {
        const res = await client.query(`SELECT * FROM ${tableName}`);
        remoteRows = res.rows || [];
      } catch (err) {
        // Table might not exist yet in Layerbase
        continue;
      }

      const localCount = adapter.get(`SELECT COUNT(*) as c FROM ${tableName}`)?.c || 0;

      if (remoteRows.length > 0) {
        // Layerbase has data: hydrate local SQLite
        const cols = Object.keys(remoteRows[0]);
        const placeholders = cols.map(() => "?").join(", ");
        const insertSql = `INSERT OR REPLACE INTO ${tableName} (${cols.join(", ")}) VALUES (${placeholders})`;

        adapter.transaction(() => {
          for (const row of remoteRows) {
            const vals = cols.map((c) => {
              const val = row[c];
              if (val === null || val === undefined) return null;
              if (typeof val === "object") return JSON.stringify(val);
              return val;
            });
            adapter.run(insertSql, vals);
          }
        });

        totalRestored += remoteRows.length;
      } else if (localCount > 0) {
        // Layerbase is empty but local has data: seed Layerbase
        await syncTableToLayerbase(tableName, adapter);
      }
    }

    if (totalRestored > 0) {
      console.log(`[LayerbaseSync] Restored ${totalRestored} state rows from Layerbase into local storage.`);
    }
  } catch (err) {
    console.warn("[LayerbaseSync] syncFromLayerbase error:", err.message);
  } finally {
    client.release();
  }
}

// Attach write hooks to SQLite adapter to automatically trigger background sync
export async function initLayerbaseSync(adapter) {
  if (!isLayerbaseSyncEnabled()) return;
  currentAdapter = adapter;

  // Restore latest state from Layerbase on startup
  await syncFromLayerbase(adapter);

  const tableNames = Object.keys(SYNC_TABLES);
  const regex = new RegExp(`\\b(${tableNames.join("|")})\\b`, "i");

  function checkAndSchedule(sql) {
    if (typeof sql === "string") {
      const match = sql.match(regex);
      if (match && match[1]) {
        // Find exact casing
        const matched = tableNames.find((t) => t.toLowerCase() === match[1].toLowerCase());
        if (matched) scheduleSyncTable(matched);
      }
    }
  }

  // Intercept run
  const origRun = adapter.run.bind(adapter);
  adapter.run = function (sql, params) {
    const result = origRun(sql, params);
    checkAndSchedule(sql);
    return result;
  };

  // Intercept exec
  const origExec = adapter.exec.bind(adapter);
  adapter.exec = function (sql) {
    const result = origExec(sql);
    checkAndSchedule(sql);
    return result;
  };

  // Intercept transaction
  const origTransaction = adapter.transaction.bind(adapter);
  adapter.transaction = function (fn) {
    const result = origTransaction(fn);
    for (const t of tableNames) {
      // In transactions, multiple tables might be modified, schedule check
      scheduleSyncTable(t);
    }
    return result;
  };

  // Flush on shutdown
  const onExit = async () => {
    for (const timer of pendingSyncTimers.values()) {
      clearTimeout(timer);
    }
    for (const t of tableNames) {
      try {
        await syncTableToLayerbase(t, adapter);
      } catch {}
    }
  };

  process.once("beforeExit", onExit);
  process.once("SIGTERM", onExit);
  process.once("SIGINT", onExit);

  console.log("[LayerbaseSync] Synchronizer initialized for tables:", tableNames.join(", "));
}
