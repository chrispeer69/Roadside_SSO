// Tenant administration: people, app tiles, security policy, sessions, audit.
import { Router } from "express";
import { one, query, rows } from "../db.js";
import { tenantApps, tileOf } from "../lib/access.js";
import { audit, clientIp } from "../lib/audit.js";
import { endSession } from "../lib/logout.js";
import { addPerson, updatePerson, removePerson, issueTempPassword, issueResetLink, setPassword, resetMfa, upsertTenantApp, removeTenantApp, peopleOf, cleanSettings, tenantRoles } from "../lib/service.js";
import { requireUser, requireTenantAdmin, wrap, bad, notFound } from "../middleware/guards.js";

export const tenant = Router();
tenant.use(requireUser, requireTenantAdmin);

tenant.get("/", wrap(async (req, res) => {
  const t = req.auth.tenant;
  const stats = await one(
    `SELECT (SELECT count(*)::int FROM memberships WHERE tenant_id = $1 AND status = 'active') AS people,
            (SELECT count(*)::int FROM tenant_apps WHERE tenant_id = $1 AND enabled) AS apps,
            (SELECT count(*)::int FROM sessions s JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = $1
               WHERE s.revoked_at IS NULL AND s.expires_at > now()) AS sessions,
            (SELECT count(*)::int FROM audit_log WHERE tenant_id = $1 AND event = 'login.success' AND at > now() - interval '24 hours') AS logins24h,
            (SELECT count(*)::int FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.status='active' AND NOT u.mfa_enabled) AS noMfa`,
    [t.id]
  );
  res.json({ tenant: { id: t.id, slug: t.slug, name: t.name, status: t.status, settings: t.settings }, roles: tenantRoles(t), stats });
}));

tenant.patch("/", wrap(async (req, res) => {
  const t = req.auth.tenant;
  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 120) : t.name;
  if (!name) throw bad("Organization name cannot be empty.");
  const settings = req.body.settings ? cleanSettings(req.body.settings, t.settings) : t.settings;
  await query(`UPDATE tenants SET name = $2, settings = $3 WHERE id = $1`, [t.id, name, settings]);
  audit({ tenantId: t.id, actorId: req.auth.user.id, event: "tenant.updated", ip: clientIp(req), detail: { keys: Object.keys(req.body.settings ?? {}) } });
  res.json({ ok: true });
}));

// ----- People -----
tenant.get("/people", wrap(async (req, res) => res.json(await peopleOf(req.auth.tenant.id))));

tenant.post("/people", wrap(async (req, res) => {
  const r = await addPerson(req.auth.tenant, req.body, req.auth.user, clientIp(req));
  res.status(201).json({ id: r.user.id, email: r.user.email, tempPassword: r.tempPassword, existing: !r.tempPassword });
}));

tenant.patch("/people/:userId", wrap(async (req, res) => {
  await updatePerson(req.auth.tenant, req.params.userId, req.body, req.auth.user, clientIp(req));
  res.json({ ok: true });
}));

tenant.delete("/people/:userId", wrap(async (req, res) => {
  if (req.params.userId === req.auth.user.id) throw bad("You cannot remove yourself.");
  await removePerson(req.auth.tenant, req.params.userId, req.auth.user, clientIp(req));
  res.json({ ok: true });
}));

const memberOnly = async (req) => {
  const m = await one(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [req.auth.tenant.id, req.params.userId]);
  if (!m) throw notFound("Person not found in this organization.");
};
tenant.post("/people/:userId/temp-password", wrap(async (req, res) => { await memberOnly(req); res.json({ tempPassword: await issueTempPassword(req.params.userId, req.auth.user, req.auth.tenant.id, clientIp(req)) }); }));
tenant.post("/people/:userId/password", wrap(async (req, res) => { await memberOnly(req); await setPassword(req.params.userId, String(req.body.password ?? ""), !!req.body.mustChange, req.auth.user, req.auth.tenant.id, clientIp(req)); res.json({ ok: true }); }));
tenant.post("/people/:userId/reset-link", wrap(async (req, res) => { await memberOnly(req); res.json({ url: await issueResetLink(req.params.userId, req.auth.user, req.auth.tenant.id, clientIp(req)) }); }));
tenant.post("/people/:userId/mfa-reset", wrap(async (req, res) => { await memberOnly(req); await resetMfa(req.params.userId, req.auth.user, req.auth.tenant.id, clientIp(req)); res.json({ ok: true }); }));

// ----- Apps / tiles -----
tenant.get("/apps", wrap(async (req, res) => {
  const t = req.auth.tenant;
  const connected = await tenantApps(t.id);
  const connectedIds = new Set(connected.map((c) => c.app_id));
  const catalog = await rows(`SELECT id, name, category, description, icon, base_url, launch_url, owner, mobile, sort FROM apps WHERE status = 'active' AND visibility = 'catalog' ORDER BY sort, name`);
  res.json({
    connected: connected.map((c) => ({ ...tileOf(c), enabled: c.enabled, allowedRoles: c.allowed_roles, label: c.label, launchUrlOverride: c.tenant_launch_url, sort: c.tenant_sort, appStatus: c.app_status, visibility: c.visibility })),
    available: catalog.filter((a) => !connectedIds.has(a.id)),
  });
}));

tenant.put("/apps/:appId", wrap(async (req, res) => {
  const row = await upsertTenantApp(req.auth.tenant, req.params.appId, req.body, req.auth.user, { allowPrivate: req.auth.user.is_platform_admin, ip: clientIp(req) });
  res.json(row);
}));

tenant.delete("/apps/:appId", wrap(async (req, res) => {
  await removeTenantApp(req.auth.tenant, req.params.appId, req.auth.user, clientIp(req));
  res.json({ ok: true });
}));

// ----- Sessions & audit -----
tenant.get("/sessions", wrap(async (req, res) => {
  const list = await rows(
    `SELECT s.id, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.mfa_passed, u.name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
     WHERE s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.last_seen_at DESC LIMIT 200`,
    [req.auth.tenant.id]
  );
  res.json(list.map((s) => ({ ...s, current: s.id === req.auth.session.id })));
}));

tenant.delete("/sessions/:id", wrap(async (req, res) => {
  const s = await one(`SELECT s.id FROM sessions s JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = $2 WHERE s.id = $1`, [req.params.id, req.auth.tenant.id]);
  if (!s) throw notFound();
  await endSession(s.id, { reason: "revoked" });
  audit({ tenantId: req.auth.tenant.id, actorId: req.auth.user.id, event: "session.revoked", target: s.id, ip: clientIp(req) });
  res.json({ ok: true });
}));

tenant.get("/audit", wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const list = await rows(
    `SELECT a.id, a.at, a.event, a.target, a.detail, a.ip, u.name AS user_name, u.email AS user_email, act.name AS actor_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users act ON act.id = a.actor_id
     WHERE a.tenant_id = $1 ORDER BY a.at DESC LIMIT $2`,
    [req.auth.tenant.id, limit]
  );
  res.json(list);
}));
