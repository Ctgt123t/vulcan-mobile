// ----------------------------------------------------------------------------
// End-to-end DB smoke test: insert a `source` row, read it back, delete it,
// confirm it's gone. Proves the backend can actually connect AND read/write
// through the Supabase transaction pooler before we trust the connection.
//
// Run: `npm run db:smoke` (from server/). Prints PASS/FAIL only — never the
// connection string or any secret. Requires the 0001 migration to have run.
// ----------------------------------------------------------------------------

import "dotenv/config";
import { pool } from "../db.js";

async function main() {
  const marker = `vulcan-smoke-${Date.now()}`;
  let ok = true;

  try {
    // INSERT
    const ins = await pool.query(
      `insert into source (source_type, title, url_or_ref, publisher, license, trust_tier)
       values ($1, $2, $3, $4, $5, $6)
       returning id, created_at`,
      ["other", marker, "n/a", "vulcan-smoke-test", "n/a", 5],
    );
    const id = ins.rows[0].id;
    console.log(`[smoke] inserted source id=${id}`);

    // READ
    const sel = await pool.query(
      "select id, title from source where id = $1",
      [id],
    );
    if (sel.rowCount !== 1 || sel.rows[0].title !== marker) {
      throw new Error("read-back mismatch (row not found or title differs)");
    }
    console.log("[smoke] read back ok — title matches");

    // DELETE
    const del = await pool.query("delete from source where id = $1", [id]);
    if (del.rowCount !== 1) {
      throw new Error(`delete affected ${del.rowCount} rows, expected 1`);
    }

    // CONFIRM GONE
    const gone = await pool.query("select 1 from source where id = $1", [id]);
    if (gone.rowCount !== 0) {
      throw new Error("row still present after delete");
    }
    console.log("[smoke] deleted and confirmed gone");

    console.log("[smoke] PASS — insert/read/delete round-trip succeeded");
  } catch (err) {
    ok = false;
    console.error("[smoke] FAIL:", err.message);
  } finally {
    await pool.end();
  }

  process.exit(ok ? 0 : 1);
}

main();
