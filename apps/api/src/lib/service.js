// Shared operations used by both tenant-admin and platform-admin routes.
import { one, query, rows } from "../db.js";
import { hashPassword, tempPassword, tempPin, randomToken, sha256, passwordProblem } from "./crypto.js";
import { ROLES } from "./access.js";
import { audit } from "./audit.js";
import { bad, notFound } from "../middleware/guards.js";
import { endAllSessionsForUser } from "./logout.js";
import { config } from "../config.js";

const cleanList = (v, allowed) => (Array.isArray(v) ? v.map((s) => String(s).trim().toLowerCase()).filter(Boolean).filter((s) => !allowed || allowed.includes(s)) : []);
const isEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export function tenantRoles(tenant) {
  const custom = Array.isArray(tenant?.settings?.customRoles) ? tenant.settings.customRoles : [];
  return [...new Set([...ROLES, ...custom.map((r) => String(r).toLowerCase())])];
}

// Create a new person (temporary password) or attach an existing person to the tenant.
export async function addPerson(tenant, body, actor, ip) {
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) throw bad("A valid email is required.");
  const name = String(body.name ?? "").trim();
  const allowedRoles = tenantRoles(tenant);
  const roles = cleanList(body.roles, allowedRoles);
  const locations = cleanList(body.locations);
  const domains = tenant.settings?.allowedEmailDomains ?? [];
  if (domains.length && !domains.includes(email.split("@")[1])) throw bad(`Email must be on: ${domains.join(", ")}`);

  let user = await one(`SELECT * FROM users WHERE email = $1`, [email]);
  let temp = null;
  if (!user) {
    if (!name) throw bad("Name is required for a new person.");
    temp = pinMode(tenant) ? tempPin() : tempPassword();
    user = await one(
      `INSERT INTO users (email, name, phone, password_hash, must_change_password) VALUES ($1,$2,$3,$4,true) RETURNING *`,
      [email, name, body.phone ? String(body.phone).trim() : null, await hashPassword(temp)]
    );
  }
  const existing = await one(`SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenant.id, user.id]);
  if (existing) throw bad("That person is already in this organization.", "exists");
  const membership = await one(
    `INSERT INTO memberships (tenant_id, user_id, roles, locations, title) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tenant.id, user.id, roles, locations, body.title ? String(body.title).trim() : null]
  );
  audit({ tenantId: tenant.id, userId: user.id, actorId: actor.id, event: temp ? "person.created" : "person.attached", target: email, detail: { roles, locations }, ip });
  return { user, membership, tempPassword: temp };
}

export async function updatePerson(tenant, userId, body, actor, ip) {
  const m = await one(`SELECT m.*, u.name, u.phone FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.user_id = $2`, [tenant.id, userId]);
  if (!m) throw notFound("Person not found in this organization.");
  const allowedRoles = tenantRoles(tenant);
  const roles = body.roles !== undefined ? cleanList(body.roles, allowedRoles) : m.roles;
  const locations = body.locations !== undefined ? cleanList(body.locations) : m.locations;
  const status = body.status === "disabled" ? "disabled" : body.status === "active" ? "active" : m.status;
  const overrides = {};
  const src = body.appOverrides !== undefined ? body.appOverrides : m.app_overrides;
  for (const [k, v] of Object.entries(src ?? {})) if (v === "allow" || v === "deny") overrides[k] = v;

  if (m.roles.includes("owner") && !roles.includes("owner")) await assertNotLastOwner(tenant.id, userId);
  if (status === "disabled" && m.roles.includes("owner")) await assertNotLastOwner(tenant.id, userId);

  await query(
    `UPDATE memberships SET roles = $3, locations = $4, title = $5, status = $6, app_overrides = $7 WHERE tenant_id = $1 AND user_id = $2`,
    [tenant.id, userId, roles, locations, body.title !== undefined ? (body.title ? String(body.title).trim() : null) : m.title, status, overrides]
  );
  if (body.name || body.phone !== undefined) {
    await query(`UPDATE users SET name = COALESCE($2, name), phone = $3 WHERE id = $1`, [userId, body.name ? String(body.name).trim() : null, body.phone !== undefined ? (body.phone ? String(body.phone).trim() : null) : m.phone]);
  }
  // Email is the sign-in identity; changing it takes effect everywhere at once.
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!isEmail(email)) throw bad("A valid email is required.");
    const current = await one(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (current && current.email.toLowerCase() !== email) {
      const domains = tenant.settings?.allowedEmailDomains ?? [];
      if (domains.length && !domains.includes(email.split("@")[1])) throw bad(`Email must be on: ${domains.join(", ")}`);
      if (await one(`SELECT 1 FROM users WHERE email = $1 AND id <> $2`, [email, userId])) throw bad("Another person already uses that email.", "exists");
      await query(`UPDATE users SET email = $2 WHERE id = $1`, [userId, email]);
      audit({ tenantId: tenant.id, userId, actorId: actor.id, event: "person.email_changed", target: email, detail: { from: current.email }, ip });
    }
  }
  if (status === "disabled" && m.status !== "disabled") {
    await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`, [userId, tenant.id]);
  }
  audit({ tenantId: tenant.id, userId, actorId: actor.id, event: "person.updated", detail: { roles, locations, status }, ip });
}

export async function removePerson(tenant, userId, actor, ip) {
  const m = await one(`SELECT * FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenant.id, userId]);
  if (!m) throw notFound("Person not found in this organization.");
  if (m.roles.includes("owner")) await assertNotLastOwner(tenant.id, userId);
  await query(`DELETE FROM memberships WHERE id = $1`, [m.id]);
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`, [userId, tenant.id]);
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`, [userId, tenant.id]);
  audit({ tenantId: tenant.id, userId, actorId: actor.id, event: "person.removed", ip });
}

async function assertNotLastOwner(tenantId, userId) {
  const others = await one(`SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND user_id <> $2 AND status = 'active' AND 'owner' = ANY(roles)`, [tenantId, userId]);
  if (!others.n) throw bad("An organization must keep at least one active owner.", "last_owner");
}

export async function issueTempPassword(userId, actor, tenantId, ip) {
  const t = await one(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
  const temp = pinMode(t) ? tempPin() : tempPassword();
  await query(`UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1`, [userId, await hashPassword(temp)]);
  await endAllSessionsForUser(userId);
  audit({ tenantId, userId, actorId: actor.id, event: "password.temp_issued", ip });
  return temp;
}

// Administrator sets a specific password (optionally forcing a change at next sign-in). Signs the person out everywhere.
export async function setPassword(userId, password, mustChange, actor, tenantId, ip) {
  const t = await one(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
  const problem = passwordProblem(password, { pin: pinMode(t) });
  if (problem) throw bad(problem, "weak_password");
  await query(`UPDATE users SET password_hash = $2, must_change_password = $3, failed_logins = 0, locked_until = NULL WHERE id = $1`, [userId, await hashPassword(password), !!mustChange]);
  await endAllSessionsForUser(userId);
  audit({ tenantId, userId, actorId: actor.id, event: "password.set_by_admin", detail: { mustChange: !!mustChange }, ip });
}

export async function issueResetLink(userId, actor, tenantId, ip) {
  const token = randomToken(32);
  await query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '24 hours')`, [sha256(token), userId]);
  audit({ tenantId, userId, actorId: actor.id, event: "password.reset_link", ip });
  return `${config.publicUrl}/reset?token=${token}`;
}

export async function resetMfa(userId, actor, tenantId, ip) {
  await query(`UPDATE users SET mfa_secret = NULL, mfa_enabled = false WHERE id = $1`, [userId]);
  audit({ tenantId, userId, actorId: actor.id, event: "mfa.reset", ip });
}

// Connect / configure an app tile for a tenant.
export async function upsertTenantApp(tenant, appId, body, actor, { allowPrivate = false, ip } = {}) {
  const app = await one(`SELECT * FROM apps WHERE id = $1`, [appId]);
  if (!app) throw notFound("App not found.");
  const existing = await one(`SELECT * FROM tenant_apps WHERE tenant_id = $1 AND app_id = $2`, [tenant.id, appId]);
  if (!existing && app.visibility !== "catalog" && !allowPrivate) throw bad("This app is assigned by the platform administrator.", "private_app");
  const allowedRoles = body.allowedRoles !== undefined ? cleanList(body.allowedRoles, tenantRoles(tenant)) : existing?.allowed_roles ?? [];
  const row = await one(
    `INSERT INTO tenant_apps (tenant_id, app_id, enabled, allowed_roles, label, launch_url, pinned, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, app_id) DO UPDATE SET enabled = EXCLUDED.enabled, allowed_roles = EXCLUDED.allowed_roles, label = EXCLUDED.label,
       launch_url = EXCLUDED.launch_url, pinned = EXCLUDED.pinned, sort = EXCLUDED.sort
     RETURNING *`,
    [
      tenant.id, appId,
      body.enabled !== undefined ? !!body.enabled : existing?.enabled ?? true,
      allowedRoles,
      body.label !== undefined ? (body.label ? String(body.label).trim().slice(0, 60) : null) : existing?.label ?? null,
      body.launchUrl !== undefined ? (body.launchUrl ? String(body.launchUrl).trim() : null) : existing?.launch_url ?? null,
      body.pinned !== undefined ? !!body.pinned : existing?.pinned ?? false,
      body.sort !== undefined ? Number(body.sort) || 100 : existing?.sort ?? 100,
    ]
  );
  audit({ tenantId: tenant.id, actorId: actor.id, event: existing ? "app.updated" : "app.connected", target: appId, detail: { enabled: row.enabled, allowedRoles }, ip });
  return row;
}

export async function removeTenantApp(tenant, appId, actor, ip) {
  await query(`DELETE FROM tenant_apps WHERE tenant_id = $1 AND app_id = $2`, [tenant.id, appId]);
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE tenant_id = $1 AND client_id = $2 AND revoked_at IS NULL`, [tenant.id, appId]);
  audit({ tenantId: tenant.id, actorId: actor.id, event: "app.disconnected", target: appId, ip });
}

export const peopleOf = (tenantId) =>
  rows(
    `SELECT u.id, u.email, u.name, u.phone, u.mfa_enabled, u.must_change_password, u.last_login_at, u.status AS user_status, u.is_platform_admin,
            m.roles, m.locations, m.title, m.status, m.app_overrides, m.created_at
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY u.name`,
    [tenantId]
  );

export const SETTING_KEYS = ["mfaRequiredRoles", "sessionHours", "quickLinks", "allowedEmailDomains", "customRoles", "welcome", "supportPhone", "supportEmail", "pinMode"];
export const pinMode = (tenant) => !!tenant?.settings?.pinMode;
export function cleanSettings(input, current = {}) {
  const out = { ...current };
  for (const k of SETTING_KEYS) {
    if (input[k] === undefined) continue;
    const v = input[k];
    if (k === "sessionHours") out[k] = Math.min(Math.max(Number(v) || 0, 0), 24 * 90);
    else if (k === "pinMode") out[k] = !!v;
    else if (k === "quickLinks") out[k] = (Array.isArray(v) ? v : []).slice(0, 12).map((l) => ({ label: String(l.label ?? "").slice(0, 40), url: String(l.url ?? "").slice(0, 500) })).filter((l) => l.label && l.url);
    else if (["mfaRequiredRoles", "allowedEmailDomains", "customRoles"].includes(k)) out[k] = cleanList(v);
    else out[k] = String(v ?? "").slice(0, 300);
  }
  return out;
}
