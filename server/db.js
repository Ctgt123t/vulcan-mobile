// ----------------------------------------------------------------------------
// Postgres connection layer for the unified vehicle-data layer (Supabase).
//
// This is server-side DB access ONLY — no Supabase auth/realtime, and the
// project's Data API (PostgREST) is intentionally disabled. We therefore use
// node-postgres (`pg`) for a direct Postgres connection over the Supabase
// Transaction Pooler (Supavisor, port 6543), NOT @supabase/supabase-js (which
// talks to the now-disabled Data API).
//
// The connection string lives ONLY in process.env.SUPABASE_DB_URL (set in
// server/.env locally and the Railway dashboard). It is never hardcoded and
// must never be logged, printed, or echoed anywhere.
//
// Transaction-pooler discipline: Supavisor transaction mode assigns a
// different upstream Postgres connection per transaction, so per-connection
// session state is NOT stable. We therefore use only parameterized (unnamed)
// queries — no named prepared statements, no session-scoped SET / LISTEN /
// NOTIFY. node-postgres' default parameterized queries are unnamed, so no
// special flag is required (unlike Prisma's pgbouncer=true).
//
// Scope guard: this module is additive. It does not read, write, or touch any
// of the existing JSON caches (cache.json / dtcCache.json / vehicleSpecCache
// .json / pidCache.json) — those remain the source of truth for their features.
// ----------------------------------------------------------------------------

import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.SUPABASE_DB_URL;

// Fail loud on missing config — same pattern as the ANTHROPIC_API_KEY check in
// index.js. A missing connection string is a deploy misconfiguration that must
// never ship silently.
if (!connectionString) {
  console.error(
    "[db] FATAL: SUPABASE_DB_URL is not set. Set it in server/.env (local) " +
      "and in the Railway dashboard. The data layer cannot start without it.",
  );
  process.exit(1);
}

// Bounded local pool sitting in front of the Supabase pooler. Keep `max`
// modest so multiple Railway instances don't exhaust the pooler's own limit.
export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Supabase requires TLS over the pooler
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Surface unexpected idle-client errors loudly instead of letting an idle
// connection drop crash the process. (err.message only — never the config.)
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

let dbReady = false;

// True once the startup probe has confirmed connectivity. Future DB-backed
// endpoints should check this and return a clear 503 when false, rather than
// silently degrading.
export function isDbReady() {
  return dbReady;
}

// Startup connectivity probe. Agreed failure mode: if the URL is present but
// Supabase is unreachable, log loudly and continue serving — Postgres has no
// live consumers yet, so a Supabase blip must NOT take down OBD2 / Claude.
// (A MISSING url is still fatal — see the guard above.)
export async function initDb() {
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      dbReady = true;
      console.log("[db] connected to Supabase (transaction pooler)");
    } finally {
      client.release();
    }
  } catch (err) {
    dbReady = false;
    console.error(
      "[db] ERROR: failed to connect to Supabase at startup:",
      err.message,
    );
    console.error(
      "[db] data-layer endpoints will report unavailable until this resolves; " +
        "non-DB features (OBD2, Claude) are unaffected.",
    );
  }
}

// Thin query helper so callers run one-shot parameterized queries against the
// pool without holding a client across awaits (transaction-pooler safe).
export function query(text, params) {
  return pool.query(text, params);
}
