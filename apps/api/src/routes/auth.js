import { Router } from "express";
import rateLimit from "express-rate-limit";
import { one, query } from "../db.js";
import { verifyPassword, hashPassword, passwordProblem, sha256 } from "../lib/crypto.js";
import { newMfaSecret, otpauthUrl, verifyMfaCode } from "../lib/mfa.js";
import { audit, clientIp } from "../lib/audit.js";
import { membershipsFor } from "../lib/access.js";
import { pinMode } from "../lib/service.js";
import { endSession, endAllSessionsForUser } from "../lib/logout.js";
import { createSession, clearSessionCookie } from "../middleware/session.js";
import { requireSession, wrap, bad } from "../middleware/guards.js";

export const auth = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "rate_limited", message: "Too many attempts. Try again in a few minutes." } });

const publicUser = (u, session) => ({
  id: u.id, email: u.email, name: u.name, phone: u.phone,
  isPlatformAdmin: u.is_platform_admin, mfaEnabled: u.mfa_enabled,
  mustChangePassword: u.must_change_password, mfaRequired: u.mfa_enabled && !session.mfa_passed,
});

// POST /api/auth/login
auth.post("/login", loginLimiter, wrap(async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const ip = clientIp(req);
  const fail = (msg = "Email or password is incorrect.") => res.status(401).json({ error: "invalid_login", message: msg });
  if (!email || !password) return fail();
  const user = await one(`SELECT * FROM users WHERE email = $1`, [email]);
  if (!user) { audit({ event: "login.failed", target: email, ip }); return fail(); }
  if (user.status !== "active") return fail("This account is disabled. Contact your administrator.");
  if (user.locked_until && new Date(user.locked_until) > new Date()) return res.status(423).json({ error: "locked", message: "Too many failed attempts. Try again in 15 minutes." });
  if (!(await verifyPassword(password, user.password_hash))) {
    const n = user.failed_logins + 1;
    // PIN organizations lock after 5 wrong tries (a 4-digit PIN needs a tighter gate than a password).
    const pinOrg = await one(`SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND (t.settings->>'pinMode') = 'true' LIMIT 1`, [user.id]);
    const limit = pinOrg ? 5 : 10;
    await query(`UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $2 >= $3 THEN now() + interval '15 minutes' ELSE NULL END WHERE id = $1`, [user.id, n, limit]);
    audit({ userId: user.id, event: "login.failed", target: email, ip });
    return fail();
  }
  if (req.auth?.session) await endSession(req.auth.session.id);
  const memberships = await membershipsFor(user.id);
  const tenantId = memberships[0]?.tenant_id ?? null;
  const session = await createSession(res, { user, tenantId, req });
  await query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
  audit({ tenantId, userId: user.id, event: "login.success", ip, detail: { mfa: user.mfa_enabled } });
  res.json({ ok: true, user: publicUser(user, session) });
}));

// POST /api/auth/mfa  { code }
auth.post("/mfa", loginLimiter, requireSession, wrap(async (req, res) => {
  const { user, session } = req.auth;
  if (!user.mfa_enabled) return res.json({ ok: true });
  if (!verifyMfaCode(user.mfa_secret, req.body.code)) {
    audit({ userId: user.id, event: "mfa.failed", ip: clientIp(req) });
    return res.status(401).json({ error: "invalid_code", message: "That code is not valid." });
  }
  await query(`UPDATE sessions SET mfa_passed = true WHERE id = $1`, [session.id]);
  audit({ tenantId: session.tenant_id, userId: user.id, event: "mfa.passed", ip: clientIp(req) });
  res.json({ ok: true });
}));

// POST /api/auth/logout
auth.post("/logout", wrap(async (req, res) => {
  if (req.auth?.session) {
    await endSession(req.auth.session.id);
    audit({ tenantId: req.auth.session.tenant_id, userId: req.auth.user.id, event: "logout", ip: clientIp(req) });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// POST /api/auth/password  { currentPassword, newPassword }
auth.post("/password", requireSession, wrap(async (req, res) => {
  const { user, session } = req.auth;
  if (user.mfa_enabled && !session.mfa_passed) return res.status(401).json({ error: "mfa_required", message: "Enter your verification code first." });
  if (!(await verifyPassword(String(req.body.currentPassword ?? ""), user.password_hash))) throw bad("Current password is incorrect.", "wrong_password");
  const pin = pinMode(req.auth.tenant);
  const problem = passwordProblem(req.body.newPassword, { pin });
  if (problem) throw bad(problem, "weak_password");
  if (req.body.newPassword === req.body.currentPassword) throw bad(pin ? "Choose a PIN you have not used before." : "Choose a password you have not used before.", "weak_password");
  await query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [user.id, await hashPassword(req.body.newPassword)]);
  await endAllSessionsForUser(user.id, { exceptSessionId: session.id });
  audit({ tenantId: session.tenant_id, userId: user.id, event: "password.changed", ip: clientIp(req) });
  res.json({ ok: true });
}));

// POST /api/auth/reset  { token, newPassword }  (link generated by an administrator)
auth.post("/reset", loginLimiter, wrap(async (req, res) => {
  const token = String(req.body.token ?? "");
  const pr = token && (await one(`SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(token)]));
  if (!pr) throw bad("This reset link is invalid or has expired. Ask your administrator for a new one.", "bad_token");
  const pinOrg = await one(`SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND (t.settings->>'pinMode') = 'true' LIMIT 1`, [pr.user_id]);
  const problem = passwordProblem(req.body.newPassword, { pin: !!pinOrg });
  if (problem) throw bad(problem, "weak_password");
  await query(`UPDATE users SET password_hash = $2, must_change_password = false, failed_logins = 0, locked_until = NULL WHERE id = $1`, [pr.user_id, await hashPassword(req.body.newPassword)]);
  await query(`UPDATE password_resets SET used_at = now() WHERE token_hash = $1`, [pr.token_hash]);
  await endAllSessionsForUser(pr.user_id);
  audit({ userId: pr.user_id, event: "password.reset", ip: clientIp(req) });
  res.json({ ok: true });
}));

// MFA enrollment
auth.post("/mfa/setup", requireSession, wrap(async (req, res) => {
  const { user } = req.auth;
  const secret = newMfaSecret();
  await query(`UPDATE users SET mfa_secret = $2, mfa_enabled = false WHERE id = $1`, [user.id, secret]);
  res.json({ secret, otpauthUrl: otpauthUrl(secret, user.email) });
}));

auth.post("/mfa/enable", requireSession, wrap(async (req, res) => {
  const { user, session } = req.auth;
  const fresh = await one(`SELECT mfa_secret FROM users WHERE id = $1`, [user.id]);
  if (!verifyMfaCode(fresh?.mfa_secret, req.body.code)) throw bad("That code is not valid. Check the time on your phone and try again.", "invalid_code");
  await query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [user.id]);
  await query(`UPDATE sessions SET mfa_passed = true WHERE id = $1`, [session.id]);
  await endAllSessionsForUser(user.id, { exceptSessionId: session.id });
  audit({ tenantId: session.tenant_id, userId: user.id, event: "mfa.enabled", ip: clientIp(req) });
  res.json({ ok: true });
}));

auth.post("/mfa/disable", requireSession, wrap(async (req, res) => {
  const { user, session } = req.auth;
  if (!(await verifyPassword(String(req.body.password ?? ""), user.password_hash))) throw bad("Password is incorrect.", "wrong_password");
  await query(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`, [user.id]);
  audit({ tenantId: session.tenant_id, userId: user.id, event: "mfa.disabled", ip: clientIp(req) });
  res.json({ ok: true });
}));
