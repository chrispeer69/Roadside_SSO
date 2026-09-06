// Admin CLI: run one SQL statement against the Roadside database and print the rows as JSON.
// The statement is passed base64url-encoded so it survives any shell:  node scripts/db.mjs <base64url sql>
// Intended for operators via `railway ssh --service roadside-sso -- node scripts/db.mjs <b64>`.
import pg from "pg";

const arg = process.argv[2];
if (!arg) { console.error("usage: node scripts/db.mjs <base64url-sql>"); process.exit(1); }
const sql = Buffer.from(arg, "base64url").toString("utf8");
const url = process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|\.internal/.test(url) ? undefined : { rejectUnauthorized: false } });
try {
  const r = await pool.query(sql);
  console.log(JSON.stringify({ rowCount: r.rowCount, rows: r.rows }, null, 1));
} catch (e) {
  console.error("SQL error:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
