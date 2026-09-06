// Applies db/migrations/*.sql in filename order. Safe to run on every boot.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const dir = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));

export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(dir + file, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${file}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => { console.log("[migrate] up to date"); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
}
