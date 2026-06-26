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
  console.log(`[import-makes] ${rows.length} makes received; upserting ...`);

  const client = await pool.connect();
  let upserted = 0;
  try {
    await client.query("begin");
    for (const r of rows) {
      const id = Number(r.Make_ID);
      const name = String(r.Make_Name ?? "").trim();
      if (!Number.isInteger(id) || !name) continue;
      await client.query(
        `insert into nhtsa_make (make_id, make_name) values ($1, $2)
         on conflict (make_id) do update set make_name = excluded.make_name`,
        [id, name],
      );
      upserted++;
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  const count = await pool.query("select count(*)::int n from nhtsa_make");
  console.log(`[import-makes] done — ${upserted} upserted, ${count.rows[0].n} total in nhtsa_make`);
  await pool.end();
}

run().catch((err) => {
  console.error("[import-makes] error:", err.message);
  process.exit(1);
});
