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
  else if (k.startsWith("--")) opts[k.slice(2)] = rest[++i];
}
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|\.internal/.test(url) ? undefined : { rejectUnauthorized: false } });
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const app = (await pool.query(`SELECT * FROM apps WHERE id = $1`, [appId])).rows[0];
if (!app) { console.error(`app "${appId}" not found`); process.exit(1); }

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
