// ----------------------------------------------------------------------------
// importNhtsaMakes.js — populate nhtsa_make from NHTSA's public GetAllMakes.
//
// The canonical make-spelling authority (§5.B) and the source list the #14
// make-picker will read. One public, free network call (~10-12k rows, <1 MB);
// re-runnable (upsert). NOT run on boot — invoked manually after migrate:
//   npm run import:nhtsa-makes
//
// Never logs the connection string. Fails loud (non-zero exit) so a partial
// import is visible. Run once against the shared Supabase DB.
// ----------------------------------------------------------------------------

import "dotenv/config";
import { pool } from "../db.js";

const URL = "https://vpic.nhtsa.dot.gov/api/vehicles/getallmakes?format=json";

async function run() {
  console.log(`[import-makes] fetching ${URL} ...`);
  const res = await fetch(URL, { method: "GET" });
  if (!res.ok) throw new Error(`NHTSA GetAllMakes returned ${res.status}`);
  const payload = await res.json();
  const rows = Array.isArray(payload.Results) ? payload.Results : [];
  if (rows.length === 0) throw new Error("NHTSA GetAllMakes returned no results");

  // Clean + dedupe by make_id (GetAllMakes is large; dedupe defensively).
  const byId = new Map();
  for (const r of rows) {
    const id = Number(r.Make_ID);
    const name = String(r.Make_Name ?? "").trim();
    if (Number.isInteger(id) && name) byId.set(id, name);
  }
  const clean = [...byId.entries()];
  console.log(`[import-makes] ${clean.length} makes received; upserting in chunks ...`);

  // CHUNKED MULTI-ROW upserts — one statement (one round-trip) per chunk.
  // A single ~10k-statement transaction over the Supabase TRANSACTION pooler is
  // fragile (the pooler drops a long-lived transaction mid-flight → rollback);
  // batched multi-row inserts are each a single atomic, idempotent (on-conflict)
  // statement, so the import is pooler-safe AND re-runnable. Each chunk is its
  // own one-shot parameterized query via pool.query (no held client).
  const CHUNK = 500; // 500 rows * 2 params = 1000 (well under the 65535 param cap)
  let upserted = 0;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const slice = clean.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    slice.forEach(([id, name], j) => {
      values.push(`($${j * 2 + 1}, $${j * 2 + 2})`);
      params.push(id, name);
    });
    await pool.query(
      `insert into nhtsa_make (make_id, make_name) values ${values.join(", ")}
       on conflict (make_id) do update set make_name = excluded.make_name`,
      params,
    );
    upserted += slice.length;
  }
  const count = await pool.query("select count(*)::int n from nhtsa_make");
  console.log(`[import-makes] done — ${upserted} upserted, ${count.rows[0].n} total in nhtsa_make`);
  await pool.end();
}

run().catch((err) => {
  console.error("[import-makes] error:", err.message);
  process.exit(1);
});
