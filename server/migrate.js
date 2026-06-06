// ----------------------------------------------------------------------------
// Minimal, dependency-light SQL migration runner.
//
// Applies every *.sql file in ./migrations in filename order that has not yet
// been recorded in the schema_migrations table. Each file runs inside a
// transaction (Postgres DDL is transactional) so a failure rolls back cleanly
// and leaves schema_migrations consistent.
//
// Deliberate, manual invocation only — `npm run migrate`. NOT run on server
// boot: auto-migrating on deploy would race across multiple Railway instances
// and apply schema changes as a side effect of a restart.
//
// Run once against the shared Supabase database (locally or via the Railway
// env). Idempotent — already-applied files are skipped. Never logs the
// connection string.
// ----------------------------------------------------------------------------

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const appliedRes = await client.query("select filename from schema_migrations");
    const applied = new Set(appliedRes.rows.map((r) => r.filename));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`[migrate] applying ${file} ...`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into schema_migrations (filename) values ($1)",
          [file],
        );
        await client.query("commit");
        appliedCount++;
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query("rollback");
        console.error(`[migrate] FAILED ${file}: ${err.message}`);
        throw err;
      }
    }

    console.log(
      `[migrate] done — ${appliedCount} migration(s) applied, ${files.length} file(s) total`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("[migrate] error:", err.message);
  process.exit(1);
});
