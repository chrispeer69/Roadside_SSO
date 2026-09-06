// First-run seed: app catalog from config/apps.json, and a bootstrap platform admin + first tenant when the users table is empty.
import { readFileSync } from "node:fs";
import { one, query } from "./db.js";
import { config } from "./config.js";
import { hashPassword, slugify } from "./lib/crypto.js";

export async function seed() {
  const catalog = JSON.parse(readFileSync(new URL("../../../config/apps.json", import.meta.url), "utf8"));
  const appCount = (await one(`SELECT count(*)::int AS n FROM apps`)).n;
  if (appCount === 0) {
    for (const a of catalog) {
      await query(
        `INSERT INTO apps (id, name, category, description, icon, base_url, launch_url, redirect_uris, post_logout_uris, owner, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [a.id, a.name, a.category ?? "General", a.description ?? "", a.icon ?? "apps", a.base_url ?? "", a.launch_url ?? a.base_url ?? "",
         a.redirect_uris ?? [], a.post_logout_uris ?? [], a.owner === "partner" ? "partner" : "internal", a.sort ?? 100]
      );
    }
    console.log(`[seed] catalog: ${catalog.length} apps`);
  }

  const userCount = (await one(`SELECT count(*)::int AS n FROM users`)).n;
  if (userCount === 0) {
    const b = config.bootstrap;
    const tenant = await one(`INSERT INTO tenants (slug, name, settings) VALUES ($1, $2, $3) RETURNING *`, [
      slugify(b.tenantSlug) || "roadside", b.tenantName,
      { mfaRequiredRoles: ["owner", "admin"], sessionHours: 720, quickLinks: [], welcome: "" },
    ]);
    const user = await one(
      `INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password) VALUES ($1, $2, $3, true, $4) RETURNING *`,
      [b.adminEmail.toLowerCase(), b.adminName, await hashPassword(b.adminPassword), config.isProd]
    );
    await query(`INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, '{owner}')`, [tenant.id, user.id]);
    await query(`INSERT INTO tenant_apps (tenant_id, app_id, sort) SELECT $1, id, sort FROM apps`, [tenant.id]);
    console.log(`[seed] bootstrap admin ${user.email} in tenant "${tenant.name}" (${tenant.slug}). Change the password after first sign-in.`);
  }
}
