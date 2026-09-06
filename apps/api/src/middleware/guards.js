import { isTenantAdmin } from "../lib/access.js";

const deny = (res, status, code, message) => res.status(status).json({ error: code, message });

// Signed in, MFA satisfied, no forced password change pending.
export function requireUser(req, res, next) {
  const a = req.auth;
  if (!a) return deny(res, 401, "unauthenticated", "Sign in required.");
  if (a.user.mfa_enabled && !a.session.mfa_passed) return deny(res, 401, "mfa_required", "Enter your verification code.");
  if (a.user.must_change_password) return deny(res, 403, "password_change_required", "Set a new password to continue.");
  next();
}

// Signed in with a valid cookie only (used by MFA / password change endpoints).
export function requireSession(req, res, next) {
  if (!req.auth) return deny(res, 401, "unauthenticated", "Sign in required.");
  next();
}

export function requireTenant(req, res, next) {
  if (!req.auth?.tenant) return deny(res, 400, "no_tenant", "Choose an organization first.");
  next();
}

export function requireTenantAdmin(req, res, next) {
  if (!req.auth?.tenant) return deny(res, 400, "no_tenant", "Choose an organization first.");
  if (!isTenantAdmin(req.auth.user, req.auth.membership)) return deny(res, 403, "forbidden", "Administrator access required.");
  next();
}

export function requirePlatformAdmin(req, res, next) {
  if (!req.auth?.user?.is_platform_admin) return deny(res, 403, "forbidden", "Platform administrator access required.");
  next();
}

// CSRF: mutating JSON API calls must be JSON (forces a CORS preflight cross-site) or carry the XHR header.
export function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const ct = req.headers["content-type"] ?? "";
  if (ct.startsWith("application/json") || req.headers["x-requested-with"] === "XMLHttpRequest") return next();
  deny(res, 403, "csrf", "Request blocked.");
}

// Wrap async handlers so thrown errors reach the error middleware.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, code, message) { super(message ?? code); this.status = status; this.code = code; }
}
export const bad = (message, code = "bad_request") => new HttpError(400, code, message);
export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);
