// Admin CLI: create or reset a person (for support and end-to-end testing).
//   node scripts/test-user.mjs <base64url json>   with {"email":..,"name":..,"password":..,"tenant":"<slug>","roles":["driver"],"remove":false}
// Sets must_change_password = false so the account can sign in immediately. With "remove": true the user is deleted.
import pg from "pg";
import bcrypt from "bcryptjs";

const spec = JSON.parse(Buffer.from(process.argv[2] || "", "base64url").toString("utf8") || "{}");
if (!spec.email) { console.error("email required"); process.exit(1); }
const url = process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|\.internal/.test(url) ? undefined : { rejectUnauthorized: false } });
try {
  const email = String(spec.email).toLowerCase();
  if (spec.remove) {
    const r = await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
    console.log(JSON.stringify({ removed: r.rowCount }));
  } else {
    const hash = await bcrypt.hash(String(spec.password || "Test-pass-2026"), 12);
    const u = (await pool.query(
      `INSERT INTO users (email, name, password_hash, must_change_password) VALUES ($1, $2, $3, false)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = false, status = 'active', mfa_enabled = false, mfa_secret = NULL, failed_logins = 0, locked_until = NULL
       RETURNING id, email`, [email, spec.name || email, hash])).rows[0];
    if (spec.tenant) {
      const t = (await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [spec.tenant])).rows[0];
      if (!t) throw new Error(`tenant ${spec.tenant} not found`);
      await pool.query(
        `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, status = 'active'`,
        [t.id, u.id, spec.roles || ["driver"]]
      );
    }
    console.log(JSON.stringify({ ok: true, id: u.id, email: u.email }));
  }
} catch (e) {
  console.error("error:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
