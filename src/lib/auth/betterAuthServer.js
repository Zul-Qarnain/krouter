import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import pg from "pg";

// Layerbase SQLite-over-PostgreSQL proxy compatibility:
// Format parameterized queries so they use simple query protocol to avoid
// double execution/re-binding quirks on Layerbase's PostgreSQL proxy.
function escapeLiteral(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (val instanceof Date) return "'" + val.toISOString() + "'";
  if (typeof val === "object") return "'" + JSON.stringify(val).replace(/'/g, "''") + "'";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function interpolate(sql, values) {
  if (!values || !values.length) return sql;
  return sql.replace(/\$(\d+)/g, (_, i) => escapeLiteral(values[Number(i) - 1]));
}

if (!globalThis.__layerbasePgPatched) {
  globalThis.__layerbasePgPatched = true;
  const Client = pg.Client;
  const origClientQuery = Client.prototype.query;
  Client.prototype.query = function (text, values, cb) {
    if (typeof text === "string" && Array.isArray(values) && values.length > 0) {
      const interpolated = interpolate(text, values);
      return origClientQuery.call(this, interpolated, cb);
    }
    if (typeof text === "object" && text && typeof text.text === "string" && Array.isArray(text.values) && text.values.length > 0) {
      text.text = interpolate(text.text, text.values);
      text.values = [];
      return origClientQuery.call(this, text, values, cb);
    }
    return origClientQuery.apply(this, arguments);
  };
}

let pool = null;
let authInstance = null;

export function getDbPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("sslmode=disable")
        ? false
        : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[Better Auth pg pool warning]:", err.message);
      }
    });
  }
  return pool;
}

export function isBetterAuthConfigured() {
  return Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);
}

export function createBetterAuth() {
  const dbPool = getDbPool();
  if (!dbPool) return null;

  return betterAuth({
    database: dbPool,
    baseURL: process.env.BETTER_AUTH_URL || "https://krouter-gateway.onrender.com",
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      admin(),
    ],
    advanced: {
      database: {
        validateSchema: false,
      },
    },
  });
}

export function getBetterAuth() {
  if (!isBetterAuthConfigured()) return null;
  if (!authInstance) {
    authInstance = createBetterAuth();
  }
  return authInstance;
}

export const auth = isBetterAuthConfigured() ? getBetterAuth() : null;
