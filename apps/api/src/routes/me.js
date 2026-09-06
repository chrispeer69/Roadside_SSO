import { Router } from "express";
import { one, query, rows } from "../db.js";
import { appsForMember, membershipsFor, isTenantAdmin } from "../lib/access.js";
import { audit, clientIp } from "../lib/audit.js";
import { endSession } from "../lib/logout.js";
import { requireSession, requireUser, wrap, bad, notFound } from "../middleware/guards.js";

export const me = Router();

// GET /api/me  - everything the portal needs to render for the signed-in person.
// Works before MFA / password change so the UI can route to those screens.
me.get("/", requireSession, wrap(async (req, res) => {
  const { user, session } = req.auth;
  let { tenant, membership } = req.auth;
  const mfaRequired = user.mfa_enabled && !session.mfa_passed;
  const base = {
    user: {
      id: user.id, email: user.email, name: user.name, phone: user.phone,
      isPlatformAdmin: user.is_platform_admin, mfaEnabled: user.mfa_enabled,
      mustChangePassword: user.must_change_password, mfaRequired, lastLoginAt: user.last_login_at,
    },
  };
  if (mfaRequired || user.must_change_password) return res.json(base);

  const memberships = await membershipsFor(user.id);
  if (!tenant && memberships[0]) {
    await query(`UPDATE sessions SET tenant_id = $2 WHERE id = $1`, [session.id, memberships[0].tenant_id]);
    tenant = await one(`SELECT * FROM tenants WHERE id = $1`, [memberships[0].tenant_id]);
    membership = memberships[0];
  }
  const apps = tenant && membership ? await appsForMember(tenant.id, membership) : [];
  const s = tenant?.settings ?? {};
  res.json({
    ...base,
    tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, quickLinks: s.quickLinks ?? [], welcome: s.welcome ?? "", supportPhone: s.supportPhone ?? "", supportEmail: s.supportEmail ?? "", mfaRequiredRoles: s.mfaRequiredRoles ?? [] } : null,
    membership: membership ? { roles: membership.roles, locations: membership.locations, title: membership.title, isAdmin: isTenantAdmin(user, membership) } : null,
    tenants: memberships.map((m) => ({ id: m.tenant_id, slug: m.tenant_slug, name: m.tenant_name, roles: m.roles })),
    apps,
    mfaPolicy: !!(membership && (s.mfaRequiredRoles ?? []).some((r) => membership.roles.includes(r)) && !user.mfa_enabled),
  });
}));

// POST /api/me/tenant { tenantId } - switch active organization
me.post("/tenant", requireUser, wrap(async (req, res) => {
  const { user, session } = req.auth;
  const tenantId = String(req.body.tenantId ?? "");
  const m = user.is_platform_admin
    ? await one(`SELECT id FROM tenants WHERE id = $1 AND status = 'active'`, [tenantId])
    : await one(`SELECT tenant_id AS id FROM memberships WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`, [user.id, tenantId]);
  if (!m) throw notFound("You are not a member of that organization.");
  await query(`UPDATE sessions SET tenant_id = $2 WHERE id = $1`, [session.id, tenantId]);
  audit({ tenantId, userId: user.id, event: "tenant.switched", ip: clientIp(req) });
  res.json({ ok: true });
}));

me.patch("/", requireUser, wrap(async (req, res) => {
  const { user } = req.auth;
  const name = req.body.name !== undefined ? String(req.body.name).trim() : user.name;
  if (!name) throw bad("Name cannot be empty.");
  const phone = req.body.phone !== undefined ? (String(req.body.phone).trim() || null) : user.phone;
  await query(`UPDATE users SET name = $2, phone = $3 WHERE id = $1`, [user.id, name.slice(0, 120), phone]);
  res.json({ ok: true });
}));

me.get("/sessions", requireUser, wrap(async (req, res) => {
  const list = await rows(
    `SELECT s.id, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at, t.name AS tenant_name
     FROM sessions s LEFT JOIN tenants t ON t.id = s.tenant_id
     WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.last_seen_at DESC`,
    [req.auth.user.id]
  );
  res.json(list.map((s) => ({ ...s, current: s.id === req.auth.session.id })));
}));

me.delete("/sessions/:id", requireUser, wrap(async (req, res) => {
  const s = await one(`SELECT id FROM sessions WHERE id = $1 AND user_id = $2`, [req.params.id, req.auth.user.id]);
  if (!s) throw notFound();
  await endSession(s.id, { reason: "revoked" });
  res.json({ ok: true });
}));

me.get("/activity", requireUser, wrap(async (req, res) => {
  const list = await rows(
    `SELECT a.at, a.event, a.target, a.detail, a.ip, t.name AS tenant_name FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
     WHERE a.user_id = $1 ORDER BY a.at DESC LIMIT 60`,
    [req.auth.user.id]
  );
  res.json(list);
}));
