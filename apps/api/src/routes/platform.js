// Platform administration: tenants, the app catalog (OIDC clients), and people across every tenant.
import { Router } from "express";
import { one, query, rows } from "../db.js";
import { hashPassword, randomToken, slugify } from "../lib/crypto.js";
import { audit, clientIp } from "../lib/audit.js";
import { addPerson, upsertTenantApp, removeTenantApp, peopleOf, cleanSettings, updatePerson, removePerson, issueTempPassword, issueResetLink, resetMfa } from "../lib/service.js";
import { tenantApps, tileOf } from "../lib/access.js";
import { endAllSessionsForUser } from "../lib/logout.js";
import { requireUser, requirePlatformAdmin, wrap, bad, notFound } from "../middleware/guards.js";

export const platform = Router();
platform.use(requireUser, requirePlatformAdmin);

platform.get("/overview", wrap(async (req, res) => {
  const stats = await one(
    `SELECT (SELECT count(*)::int FROM tenants WHERE status = 'active') AS tenants,
            (SELECT count(*)::int FROM users WHERE status = 'active') AS users,
            (SELECT count(*)::int FROM apps WHERE status = 'active') AS apps,
            (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > now()) AS sessions,
            (SELECT count(*)::int FROM audit_log WHERE event = 'login.success' AND at > now() - interval '24 hours') AS logins24h,
            (SELECT count(*)::int FROM audit_log WHERE event = 'app.launched' AND at > now() - interval '24 hours') AS launches24h,
            (SELECT count(*)::int FROM audit_log WHERE event = 'login.failed' AND at > now() - interval '24 hours') AS failed24h`
  );
  const recent = await rows(
    `SELECT a.at, a.event, a.target, a.ip, u.name AS user_name, t.name AS tenant_name FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.at DESC LIMIT 40`
  );
  res.json({ stats, recent });
}));

// ----- Tenants -----
platform.get("/tenants", wrap(async (req, res) => {
  res.json(await rows(
    `SELECT t.id, t.slug, t.name, t.status, t.settings, t.created_at,
            (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS people,
            (SELECT count(*)::int FROM tenant_apps ta WHERE ta.tenant_id = t.id AND ta.enabled) AS apps
     FROM tenants t ORDER BY t.name`
  ));
}));

platform.post("/tenants", wrap(async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) throw bad("Organization name is required.");
  const slug = slugify(req.body.slug || name);
  if (!slug) throw bad("Slug is required.");
  if (await one(`SELECT 1 FROM tenants WHERE slug = $1`, [slug])) throw bad("That slug is already in use.", "exists");
  const t = await one(`INSERT INTO tenants (slug, name, settings) VALUES ($1, $2, $3) RETURNING *`, [slug, name, cleanSettings(req.body.settings ?? {})]);
  audit({ tenantId: t.id, actorId: req.auth.user.id, event: "tenant.created", target: slug, ip: clientIp(req) });
  let owner = null;
  if (req.body.ownerEmail) {
    const r = await addPerson(t, { email: req.body.ownerEmail, name: req.body.ownerName, roles: ["owner"] }, req.auth.user, clientIp(req));
    owner = { email: r.user.email, tempPassword: r.tempPassword };
  }
  if (Array.isArray(req.body.appIds)) {
    for (const id of req.body.appIds) await upsertTenantApp(t, String(id), {}, req.auth.user, { allowPrivate: true, ip: clientIp(req) }).catch(() => {});
  }
  res.status(201).json({ tenant: t, owner });
}));

const loadTenant = async (req) => {
  const t = await one(`SELECT * FROM tenants WHERE id = $1`, [req.params.id]);
  if (!t) throw notFound("Organization not found.");
  return t;
};

platform.get("/tenants/:id", wrap(async (req, res) => {
  const t = await loadTenant(req);
  const apps = (await tenantApps(t.id)).map((c) => ({ ...tileOf(c), enabled: c.enabled, allowedRoles: c.allowed_roles, label: c.label, launchUrlOverride: c.tenant_launch_url, sort: c.tenant_sort, visibility: c.visibility }));
  res.json({ tenant: t, people: await peopleOf(t.id), apps });
}));

platform.patch("/tenants/:id", wrap(async (req, res) => {
  const t = await loadTenant(req);
  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 120) : t.name;
  const status = ["active", "suspended"].includes(req.body.status) ? req.body.status : t.status;
  const settings = req.body.settings ? cleanSettings(req.body.settings, t.settings) : t.settings;
  await query(`UPDATE tenants SET name = $2, status = $3, settings = $4 WHERE id = $1`, [t.id, name, status, settings]);
  if (status === "suspended") await query(`UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`, [t.id]);
  audit({ tenantId: t.id, actorId: req.auth.user.id, event: "tenant.updated", ip: clientIp(req), detail: { status } });
  res.json({ ok: true });
}));

platform.post("/tenants/:id/people", wrap(async (req, res) => {
  const t = await loadTenant(req);
  const r = await addPerson(t, req.body, req.auth.user, clientIp(req));
  res.status(201).json({ id: r.user.id, email: r.user.email, tempPassword: r.tempPassword, existing: !r.tempPassword });
}));
platform.patch("/tenants/:id/people/:userId", wrap(async (req, res) => { await updatePerson(await loadTenant(req), req.params.userId, req.body, req.auth.user, clientIp(req)); res.json({ ok: true }); }));
platform.delete("/tenants/:id/people/:userId", wrap(async (req, res) => { await removePerson(await loadTenant(req), req.params.userId, req.auth.user, clientIp(req)); res.json({ ok: true }); }));
platform.post("/tenants/:id/people/:userId/temp-password", wrap(async (req, res) => { const t = await loadTenant(req); res.json({ tempPassword: await issueTempPassword(req.params.userId, req.auth.user, t.id, clientIp(req)) }); }));
platform.post("/tenants/:id/people/:userId/reset-link", wrap(async (req, res) => { const t = await loadTenant(req); res.json({ url: await issueResetLink(req.params.userId, req.auth.user, t.id, clientIp(req)) }); }));
platform.post("/tenants/:id/people/:userId/mfa-reset", wrap(async (req, res) => { const t = await loadTenant(req); await resetMfa(req.params.userId, req.auth.user, t.id, clientIp(req)); res.json({ ok: true }); }));

platform.put("/tenants/:id/apps/:appId", wrap(async (req, res) => {
  const t = await loadTenant(req);
  res.json(await upsertTenantApp(t, req.params.appId, req.body, req.auth.user, { allowPrivate: true, ip: clientIp(req) }));
}));
platform.delete("/tenants/:id/apps/:appId", wrap(async (req, res) => { await removeTenantApp(await loadTenant(req), req.params.appId, req.auth.user, clientIp(req)); res.json({ ok: true }); }));

// ----- App catalog (OIDC clients) -----
const APP_FIELDS = ["name", "category", "description", "icon", "base_url", "launch_url", "initiate_login_uri", "backchannel_logout_uri", "client_type", "owner", "visibility", "status"];
const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);

platform.get("/apps", wrap(async (req, res) => {
  res.json(await rows(
    `SELECT a.id, a.name, a.category, a.description, a.icon, a.base_url, a.launch_url, a.initiate_login_uri, a.redirect_uris, a.post_logout_uris,
            a.backchannel_logout_uri, a.client_type, a.owner, a.visibility, a.mobile, a.status, a.sort, a.created_at,
            (a.client_secret_hash IS NOT NULL) AS has_secret,
            (SELECT count(*)::int FROM tenant_apps ta WHERE ta.app_id = a.id AND ta.enabled) AS tenants
     FROM apps a ORDER BY a.sort, a.name`
  ));
}));

function appValues(body, existing = {}) {
  const v = { ...existing };
  for (const f of APP_FIELDS) if (body[f] !== undefined) v[f] = body[f] == null ? null : String(body[f]).trim();
  if (body.redirect_uris !== undefined) v.redirect_uris = list(body.redirect_uris);
  if (body.post_logout_uris !== undefined) v.post_logout_uris = list(body.post_logout_uris);
  if (body.mobile !== undefined) v.mobile = !!body.mobile;
  if (body.sort !== undefined) v.sort = Number(body.sort) || 100;
  if (!["confidential", "public"].includes(v.client_type)) v.client_type = "confidential";
  if (!["internal", "partner"].includes(v.owner)) v.owner = "internal";
  if (!["catalog", "private"].includes(v.visibility)) v.visibility = "catalog";
  if (!["active", "disabled"].includes(v.status)) v.status = "active";
  if (!v.name) throw bad("App name is required.");
  return v;
}

platform.post("/apps", wrap(async (req, res) => {
  const id = slugify(req.body.id || req.body.name);
  if (!id) throw bad("App id is required.");
  if (await one(`SELECT 1 FROM apps WHERE id = $1`, [id])) throw bad("That app id already exists.", "exists");
  const v = appValues(req.body, { category: "General", description: "", icon: "apps", base_url: "", launch_url: "", redirect_uris: [], post_logout_uris: [], mobile: true, sort: 100 });
  const secret = v.client_type === "confidential" ? randomToken(32) : null;
  await query(
    `INSERT INTO apps (id, name, category, description, icon, base_url, launch_url, initiate_login_uri, redirect_uris, post_logout_uris, backchannel_logout_uri, client_type, client_secret_hash, owner, visibility, mobile, status, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, v.name, v.category, v.description, v.icon, v.base_url, v.launch_url, v.initiate_login_uri || null, v.redirect_uris, v.post_logout_uris, v.backchannel_logout_uri || null, v.client_type, secret ? await hashPassword(secret) : null, v.owner, v.visibility, v.mobile, v.status, v.sort]
  );
  audit({ actorId: req.auth.user.id, event: "catalog.app_created", target: id, ip: clientIp(req) });
  res.status(201).json({ id, clientSecret: secret });
}));

platform.patch("/apps/:id", wrap(async (req, res) => {
  const a = await one(`SELECT * FROM apps WHERE id = $1`, [req.params.id]);
  if (!a) throw notFound("App not found.");
  const v = appValues(req.body, a);
  await query(
    `UPDATE apps SET name=$2, category=$3, description=$4, icon=$5, base_url=$6, launch_url=$7, initiate_login_uri=$8, redirect_uris=$9, post_logout_uris=$10,
       backchannel_logout_uri=$11, client_type=$12, owner=$13, visibility=$14, mobile=$15, status=$16, sort=$17 WHERE id = $1`,
    [a.id, v.name, v.category, v.description, v.icon, v.base_url, v.launch_url, v.initiate_login_uri || null, v.redirect_uris, v.post_logout_uris, v.backchannel_logout_uri || null, v.client_type, v.owner, v.visibility, v.mobile, v.status, v.sort]
  );
  audit({ actorId: req.auth.user.id, event: "catalog.app_updated", target: a.id, ip: clientIp(req) });
  res.json({ ok: true });
}));

platform.post("/apps/:id/secret", wrap(async (req, res) => {
  const a = await one(`SELECT id FROM apps WHERE id = $1`, [req.params.id]);
  if (!a) throw notFound("App not found.");
  const secret = randomToken(32);
  await query(`UPDATE apps SET client_secret_hash = $2, client_type = 'confidential' WHERE id = $1`, [a.id, await hashPassword(secret)]);
  audit({ actorId: req.auth.user.id, event: "catalog.secret_rotated", target: a.id, ip: clientIp(req) });
  res.json({ clientSecret: secret });
}));

platform.delete("/apps/:id", wrap(async (req, res) => {
  await query(`DELETE FROM apps WHERE id = $1`, [req.params.id]);
  audit({ actorId: req.auth.user.id, event: "catalog.app_deleted", target: req.params.id, ip: clientIp(req) });
  res.json({ ok: true });
}));

// ----- People across the platform -----
platform.get("/users", wrap(async (req, res) => {
  const q = `%${String(req.query.q ?? "").trim()}%`;
  res.json(await rows(
    `SELECT u.id, u.email, u.name, u.phone, u.status, u.is_platform_admin, u.mfa_enabled, u.last_login_at, u.created_at,
            COALESCE(json_agg(json_build_object('id', t.id, 'name', t.name, 'roles', m.roles)) FILTER (WHERE t.id IS NOT NULL), '[]') AS tenants
     FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN tenants t ON t.id = m.tenant_id
     WHERE u.email ILIKE $1 OR u.name ILIKE $1 GROUP BY u.id ORDER BY u.name LIMIT 200`,
    [q]
  ));
}));

platform.patch("/users/:id", wrap(async (req, res) => {
  const u = await one(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
  if (!u) throw notFound("User not found.");
  if (u.id === req.auth.user.id && req.body.isPlatformAdmin === false) throw bad("You cannot remove your own platform access.");
  const isAdmin = req.body.isPlatformAdmin !== undefined ? !!req.body.isPlatformAdmin : u.is_platform_admin;
  const status = ["active", "disabled"].includes(req.body.status) ? req.body.status : u.status;
  await query(`UPDATE users SET is_platform_admin = $2, status = $3 WHERE id = $1`, [u.id, isAdmin, status]);
  if (status === "disabled") await endAllSessionsForUser(u.id);
  audit({ userId: u.id, actorId: req.auth.user.id, event: "user.updated", detail: { isPlatformAdmin: isAdmin, status }, ip: clientIp(req) });
  res.json({ ok: true });
}));
