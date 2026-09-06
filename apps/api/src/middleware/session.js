// Reads the portal session cookie and attaches { session, user, tenant, membership } to req.auth.
import { one, query } from "../db.js";
import { sha256, randomToken } from "../lib/crypto.js";
import { config } from "../config.js";

export async function attachSession(req, res, next) {
  req.auth = null;
  const raw = req.signedCookies?.[config.cookieName];
  if (!raw) return next();
  try {
    const session = await one(
      `SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [sha256(raw)]
    );
    if (!session) return next();
    const user = await one(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [session.user_id]);
    if (!user) return next();

    let tenant = null, membership = null;
    if (session.tenant_id) {
      tenant = await one(`SELECT * FROM tenants WHERE id = $1 AND status = 'active'`, [session.tenant_id]);
      if (tenant) {
        membership = await one(`SELECT * FROM memberships WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`, [user.id, tenant.id]);
        if (!membership && !user.is_platform_admin) tenant = null;
        // Tenant session policy (hours) applies once a tenant is active.
        const hours = Number(tenant?.settings?.sessionHours);
        if (hours > 0 && new Date(session.created_at).getTime() + hours * 3600e3 < Date.now()) {
          await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [session.id]);
          return next();
        }
      }
    }
    if (Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60e3) {
      query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [session.id]).catch(() => {});
    }
    req.auth = { session, user, tenant, membership };
  } catch (e) {
    console.error("[session]", e.message);
  }
  next();
}

export async function createSession(res, { user, tenantId, req }) {
  const raw = randomToken(32);
  const hours = config.sessionHoursDefault;
  const session = await one(
    `INSERT INTO sessions (user_id, tenant_id, token_hash, mfa_passed, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval) RETURNING *`,
    [user.id, tenantId, sha256(raw), !user.mfa_enabled, (req.headers["user-agent"] ?? "").slice(0, 300), req.ip, String(hours)]
  );
  res.cookie(config.cookieName, raw, cookieOptions(hours * 3600e3));
  return session;
}

export const cookieOptions = (maxAge) => ({
  httpOnly: true,
  signed: true,
  sameSite: "lax",
  secure: config.isProd,
  path: "/",
  maxAge,
});

export const clearSessionCookie = (res) => res.clearCookie(config.cookieName, { path: "/" });
