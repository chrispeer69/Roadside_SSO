// Admin CLI: configure a catalog app (OIDC client) directly in the database.
// Usage (DATABASE_URL must point at the Roadside SSO database):
//   node scripts/app-config.mjs <appId> [--redirect <uri,...>] [--post-logout <uri,...>] [--login <initiate_login_uri>]
//                                       [--backchannel <uri>] [--launch <url>] [--new-secret]
// Prints the new client secret once when --new-secret is given.
import pg from "pg";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const [appId, ...rest] = process.argv.slice(2);
if (!appId) { console.error("usage: node scripts/app-config.mjs <appId> [options]"); process.exit(1); }
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (k === "--new-secret") opts.newSecret = true;
  else if (k === "--create") opts.create = true;
  else if (k === "--b64") Object.assign(opts, JSON.parse(Buffer.from(rest[++i], "base64url").toString("utf8")));   // shell-safe: {"name":"US Tow Crew",...}
  else if (k.startsWith("--")) opts[k.slice(2)] = rest[++i];
}
if (opts["new-secret"] || opts.newSecret === true) opts.newSecret = true;
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|\.internal/.test(url) ? undefined : { rejectUnauthorized: false } });
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

let app = (await pool.query(`SELECT * FROM apps WHERE id = $1`, [appId])).rows[0];
if (!app && opts.create) {
  // --create --name "..." [--category ..] [--icon ..] [--description ..] [--base <url>] [--owner internal|partner] [--sort n]
  app = (await pool.query(
    `INSERT INTO apps (id, name, category, description, icon, base_url, launch_url, owner, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [appId, opts.name || appId, opts.category || "General", opts.description || "", opts.icon || "apps", opts.base || "", opts.launch || opts.base || "", opts.owner === "partner" ? "partner" : "internal", Number(opts.sort) || 100]
  )).rows[0];
  if (opts.tenants !== "none") {
    // Put the new tile on every existing organization's dashboard (visible to everyone; admins can restrict later).
    await pool.query(`INSERT INTO tenant_apps (tenant_id, app_id, sort) SELECT id, $1, $2 FROM tenants ON CONFLICT DO NOTHING`, [appId, Number(opts.sort) || 100]);
  }
  console.log(`created app ${appId}`);
}
if (!app) { console.error(`app "${appId}" not found (use --create)`); process.exit(1); }
if (opts.name || opts.category || opts.icon || opts.description || opts.base) {
  await pool.query(`UPDATE apps SET name = COALESCE($2, name), category = COALESCE($3, category), icon = COALESCE($4, icon), description = COALESCE($5, description), base_url = COALESCE($6, base_url) WHERE id = $1`,
    [appId, opts.name || null, opts.category || null, opts.icon || null, opts.description || null, opts.base || null]);
}

const sets = [], vals = [appId];
const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
if (opts.redirect) set("redirect_uris", list(opts.redirect));
if (opts["post-logout"]) set("post_logout_uris", list(opts["post-logout"]));
if (opts.login !== undefined) set("initiate_login_uri", opts.login || null);
if (opts.backchannel !== undefined) set("backchannel_logout_uri", opts.backchannel || null);
if (opts.launch) set("launch_url", opts.launch);
let secret = null;
if (opts.newSecret) { secret = randomBytes(32).toString("base64url"); set("client_secret_hash", await bcrypt.hash(secret, 12)); set("client_type", "confidential"); }
if (sets.length) await pool.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = $1`, vals);

const after = (await pool.query(`SELECT id, name, redirect_uris, post_logout_uris, initiate_login_uri, backchannel_logout_uri, launch_url, client_type, (client_secret_hash IS NOT NULL) AS has_secret FROM apps WHERE id = $1`, [appId])).rows[0];
console.log(JSON.stringify(after, null, 2));
if (secret) console.log(`\nCLIENT SECRET (shown once): ${secret}`);
await pool.end();
