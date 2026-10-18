import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";
// Account-wide hold — MODEL_LOCK_ALL in open-sse/services/accountFallback.js.
const ACCOUNT_LOCK_KEY = `${MODEL_LOCK_PREFIX}__all`;

function isLockRunning(value, nowMs) {
  const untilMs = value ? new Date(value).getTime() : 0;
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

// 0.5.166 — a re-login or a validated key edit says testStatus "active" but merged
// over the old row, keeping every modelLock_*, backoffLevel, rateLimitedUntil and
// errorCode, so the fresh account stayed skipped until Test connection (upstream
// 7fee56ba). Drop them. A hold a new login does not lift stays, with the status that
// explains it: a running modelLock___all (0.5.164 Anthropic spend cap, GitHub/Kiro
// monthly quota) or a permanent ban. Test connection lifts those with a live probe.
function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;
  const nowMs = Date.now();
  const isAccountHeld = isLockRunning(existing?.[ACCOUNT_LOCK_KEY], nowMs);
  const clearedLocks = {};
  for (const key of Object.keys(existing || {})) {
    if (!key.startsWith(MODEL_LOCK_PREFIX)) continue;
    if (key === ACCOUNT_LOCK_KEY && isAccountHeld) continue;
    clearedLocks[key] = null;
  }
  const reset = { ...clearedLocks, ...patch, backoffLevel: 0, rateLimitedUntil: null };

  if (isAccountHeld || existing?.isPermanentlyBanned === true) {
    return {
      ...reset,
      testStatus: existing.isPermanentlyBanned === true ? "banned" : "unavailable",
      lastError: existing.lastError ?? null,
      lastErrorAt: existing.lastErrorAt ?? null,
      errorCode: existing.errorCode ?? null,
    };
  }
  return {
    ...reset,
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
  };
}

// 0.5.166 — adding a key under a name the provider already has used to replace the
// stored key silently. Typed so POST /api/providers can answer 409 (upstream 239bcfc5).
function nameConflictError(existing, provider) {
  const err = new Error(
    `A connection named "${existing.name}" already exists for provider "${provider}". ` +
    `Pass allowOverwrite: true to replace it.`
  );
  err.code = "PROVIDER_NAME_CONFLICT";
  err.existingId = existing.id;
  err.existingName = existing.name;
  return err;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    // 0.5.166 — write only the rows whose position changed (upstream 239bcfc5).
    if ((c.priority || 0) !== i + 1) {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, c.id]);
    }
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  // 0.5.166 — caller flags, never stored: allowOverwrite / the id of the row being
  // edited permit replacing an apikey row that has the same name.
  const { allowOverwrite, id: editId, ...fields } = data;
  let result;

  db.transaction(() => {
    // 0.5.166 — an apikey row is deduped by name only, so look up that name instead
    // of loading the whole pool on every insert (upstream 239bcfc5, #4311). OAuth
    // still scans: its identity rules compare fields inside providerSpecificData.
    const isNamedApikey = data.authType === "apikey" && !!data.name;
    const all = isNamedApikey
      ? db.all(
          `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
          [data.provider, "apikey", data.name]
        ).map(rowToConn)
      : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;
        // If both sides have a workspace ID, they must match for dedup
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        return true; // fallback: email-only match for non-workspace providers
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      if (existing.authType === "apikey" && allowOverwrite !== true && editId !== existing.id) {
        throw nameConflictError(existing, data.provider);
      }
      const merged = { ...existing, ...resetHealthStateOnActivation(existing, fields), updatedAt: now };
      upsert(db, merged);
      if (fields.priority !== undefined) reorderInTx(db, existing.provider);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = data.email || `Account ${all.length + 1}`;
    }
    const hasExplicitPriority = !!data.priority;
    let connectionPriority = data.priority;
    if (!hasExplicitPriority) {
      // 0.5.166 — MAX(priority)+1 from the (provider, priority) index: the apikey
      // path no longer has the pool in memory.
      const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
      connectionPriority = (maxRow?.m || 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    // 0.5.166 — MAX+1 already sorts last, so the full-pool renumber (~2N statements
    // per insert, O(n*m) for a bulk import) runs only when the caller placed the row,
    // e.g. the dashboard's priority 1 = first.
    if (hasExplicitPriority) reorderInTx(db, data.provider);
    result = conn;
  });

  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction.
// 0.5.166 — { reactivate: true } (a validated edit) also drops the stale health state
// when data says testStatus "active". Opt-in: a successful request (clearAccountError)
// and a mid-request token refresh also write "active" and must keep other models' locks.
export async function updateProviderConnection(id, data, { reactivate = false } = {}) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const patch = reactivate ? resetHealthStateOnActivation(existing, data) : data;
    const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  return result;
}

/**
 * Compute-and-write update inside a single transaction.
 *
 * Use when the update *depends on the current row value* (read-modify-write).
 * Plain updateProviderConnection() reads stale snapshots outside any tx, so
 * two concurrent callers can both read N and both write N+1 instead of N+2.
 * This variant runs the read AND the compute inside the tx — better-sqlite3's
 * synchronous transactions guarantee no other writer interleaves.
 *
 * @param {string} id - Connection id
 * @param {(existing:object)=>object|null} computeUpdates - Receives the
 *   current row as an object; return the update patch, or null to skip the
 *   write entirely. The function MUST be synchronous — async work inside a
 *   sync transaction would break atomicity.
 * @returns {Promise<object|null>} Merged row after write, or the existing
 *   row when computeUpdates returned null, or null if the row was missing.
 */
export async function updateProviderConnectionAtomic(id, computeUpdates) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const updates = computeUpdates(existing);
    if (updates == null) { result = existing; return; }
    const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    if (updates.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return before?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
