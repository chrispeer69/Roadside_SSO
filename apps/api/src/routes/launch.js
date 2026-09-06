// GET /launch/:appId  - dashboard tile click. Verifies access for the active tenant, records it, and sends the person to the app.
import { Router } from "express";
import { query } from "../db.js";
import { config } from "../config.js";
import { tenantApp, canOpen, membershipsFor, tileOf } from "../lib/access.js";
import { audit, clientIp } from "../lib/audit.js";
import { wrap } from "../middleware/guards.js";
import { errorPage } from "../lib/pages.js";

export const launch = Router();

launch.get("/launch/:appId", wrap(async (req, res) => {
  const a = req.auth;
  const appId = String(req.params.appId);
  if (!a || (a.user.mfa_enabled && !a.session.mfa_passed) || a.user.must_change_password) {
    return res.redirect(`${config.publicUrl}/login?next=${encodeURIComponent(`/launch/${appId}`)}`);
  }
  let tenantId = a.tenant?.id ?? null, membership = a.membership, ta = tenantId ? await tenantApp(tenantId, appId) : null;
  if (!(ta && canOpen(membership, ta))) {
    ta = null;
    for (const m of await membershipsFor(a.user.id)) {
      const cand = await tenantApp(m.tenant_id, appId);
      if (cand && canOpen(m, cand)) { tenantId = m.tenant_id; membership = m; ta = cand; break; }
    }
    if (ta) await query(`UPDATE sessions SET tenant_id = $2 WHERE id = $1`, [a.session.id, tenantId]);
  }
  if (!ta) {
    audit({ tenantId, userId: a.user.id, event: "app.denied", target: appId, ip: clientIp(req) });
    return res.status(403).send(errorPage("No access", "This app is not on your dashboard. Ask your administrator if you need it.", { link: config.publicUrl, label: "Back to dashboard" }));
  }
  const tile = tileOf(ta);
  // Placeholders let one tile open the right account per person, e.g. Gmail's authuser={email}.
  const fill = (s) => s.replace(/\{email\}/g, encodeURIComponent(a.user.email)).replace(/\{org\}/g, encodeURIComponent(ta.tenant_id ? (a.tenant?.slug ?? "") : "")).replace(/\{user\}/g, a.user.id);
  let target = tile.launchUrl ? fill(tile.launchUrl) : "";
  if (ta.initiate_login_uri) {
    const u = new URL(ta.initiate_login_uri);
    u.searchParams.set("iss", config.publicUrl);
    u.searchParams.set("login_hint", a.user.email);
    if (target) u.searchParams.set("target_link_uri", target);
    target = u.toString();
  }
  if (!target) return res.status(500).send(errorPage("Not configured", `${tile.name} has no launch address yet.`, { link: config.publicUrl, label: "Back to dashboard" }));
  audit({ tenantId, userId: a.user.id, event: "app.launched", target: appId, ip: clientIp(req), detail: { via: "tile" } });
  res.redirect(target);
}));
