// OpenID Connect provider: discovery, JWKS, authorize (code + PKCE), token, userinfo, introspect, revoke, end-session.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { one, query, rows } from "../db.js";
import { config } from "../config.js";
import { sha256, randomToken, verifyPassword } from "../lib/crypto.js";
import { getJwks, signJwt, verifyJwt } from "../lib/keys.js";
import { buildClaims } from "../lib/claims.js";
import { tenantApp, canOpen, membershipFor, membershipsFor } from "../lib/access.js";
import { audit, clientIp } from "../lib/audit.js";
import { endSession } from "../lib/logout.js";
import { clearSessionCookie } from "../middleware/session.js";
import { wrap } from "../middleware/guards.js";
import { errorPage } from "../lib/pages.js";

export const oidc = Router();
const tokenLimiter = rateLimit({ windowMs: 60e3, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
const iss = () => config.publicUrl;

oidc.get("/.well-known/openid-configuration", (req, res) => {
  const b = iss();
  res.json({
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    userinfo_endpoint: `${b}/oauth/userinfo`,
    jwks_uri: `${b}/.well-known/jwks.json`,
    end_session_endpoint: `${b}/oauth/logout`,
    introspection_endpoint: `${b}/oauth/introspect`,
    revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email", "roadside"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["S256", "plain"],
    claims_supported: ["sub", "email", "email_verified", "name", "phone_number", "org_id", "org_slug", "org_name", "roles", "locations", "apps", "title"],
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
  });
});

oidc.get("/.well-known/jwks.json", (req, res) => {
  res.set("cache-control", "public, max-age=300");
  res.json(getJwks());
});

// ---------- /oauth/authorize ----------
oidc.get("/oauth/authorize", wrap(async (req, res) => {
  const q = req.query;
  const clientId = String(q.client_id ?? "");
  const redirectUri = String(q.redirect_uri ?? "");
  const app = clientId && (await one(`SELECT * FROM apps WHERE id = $1 AND status = 'active'`, [clientId]));
  if (!app) return res.status(400).send(errorPage("Unknown application", "This application is not registered with Roadside SSO."));
  if (!app.redirect_uris.includes(redirectUri)) return res.status(400).send(errorPage("Redirect not allowed", `The redirect address is not registered for ${app.name}.`));

  const back = (params) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    u.searchParams.set("iss", iss());
    return res.redirect(u.toString());
  };
  if (q.response_type !== "code") return back({ error: "unsupported_response_type", state: q.state });
  const method = q.code_challenge_method ? String(q.code_challenge_method) : (q.code_challenge ? "plain" : null);
  if (method && !["S256", "plain"].includes(method)) return back({ error: "invalid_request", error_description: "bad code_challenge_method", state: q.state });
  if (app.client_type === "public" && !q.code_challenge) return back({ error: "invalid_request", error_description: "PKCE required", state: q.state });

  // Need a full portal session (MFA satisfied, no pending password change).
  const a = req.auth;
  const needsLogin = !a || (a.user.mfa_enabled && !a.session.mfa_passed) || a.user.must_change_password || q.prompt === "login";
  if (needsLogin) {
    if (q.prompt === "none") return back({ error: "login_required", state: q.state });
    const next = req.originalUrl.replace(/([?&])prompt=login&?/, "$1").replace(/[?&]$/, "");
    const hint = q.login_hint ? `&hint=${encodeURIComponent(String(q.login_hint))}` : "";
    return res.redirect(`${iss()}/login?next=${encodeURIComponent(next)}${hint}`);
  }

  // Resolve the tenant this launch belongs to.
  let tenantId = a.tenant?.id ?? null, membership = a.membership, ta = tenantId ? await tenantApp(tenantId, app.id) : null;
  if (!(ta && canOpen(membership, ta))) {
    ta = null;
    for (const m of await membershipsFor(a.user.id)) {
      const cand = await tenantApp(m.tenant_id, app.id);
      if (cand && canOpen(m, cand)) { tenantId = m.tenant_id; membership = m; ta = cand; break; }
    }
    if (ta) await query(`UPDATE sessions SET tenant_id = $2 WHERE id = $1`, [a.session.id, tenantId]);
  }
  if (!ta) {
    audit({ tenantId, userId: a.user.id, event: "app.denied", target: app.id, ip: clientIp(req) });
    if (q.prompt === "none") return back({ error: "access_denied", state: q.state });
    return res.status(403).send(errorPage("No access", `Your account is not set up for ${app.name}. Ask your administrator to add it to your dashboard.`, { link: iss(), label: "Back to dashboard" }));
  }

  const code = randomToken(32);
  await query(
    `INSERT INTO auth_codes (code_hash, client_id, user_id, tenant_id, session_id, redirect_uri, scope, nonce, code_challenge, code_challenge_method, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' seconds')::interval)`,
    [sha256(code), app.id, a.user.id, tenantId, a.session.id, redirectUri, String(q.scope ?? "openid"), q.nonce ? String(q.nonce) : null, q.code_challenge ? String(q.code_challenge) : null, method, String(config.authCodeSeconds)]
  );
  audit({ tenantId, userId: a.user.id, event: "app.launched", target: app.id, ip: clientIp(req), detail: { via: "oidc" } });
  back({ code, state: q.state });
}));

// ---------- /oauth/token ----------
async function authenticateClient(req) {
  let id = req.body.client_id, secret = req.body.client_secret;
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Basic ")) {
    const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
    id = decodeURIComponent(u ?? ""); secret = decodeURIComponent(p ?? "");
  }
  if (!id) return { error: "invalid_client" };
  const app = await one(`SELECT * FROM apps WHERE id = $1 AND status = 'active'`, [id]);
  if (!app) return { error: "invalid_client" };
  if (app.client_type === "confidential") {
    if (!secret || !(await verifyPassword(secret, app.client_secret_hash))) return { error: "invalid_client" };
  }
  return { app };
}

async function issueTokens({ app, user, tenant, membership, sessionId, scope, nonce }) {
  const claims = await buildClaims({ user, tenant, membership });
  const accessToken = await signJwt(
    { ...claims, scope, client_id: app.id, sid: sessionId ?? undefined, token_use: "access" },
    { audience: app.id, subject: user.id, expiresIn: `${config.accessTokenSeconds}s` }
  );
  const atHash = createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url");
  const idToken = await signJwt(
    { ...claims, nonce: nonce ?? undefined, sid: sessionId ?? undefined, at_hash: atHash, auth_time: Math.floor(Date.now() / 1000) },
    { audience: app.id, subject: user.id, expiresIn: "1h" }
  );
  const refresh = randomToken(32);
  await query(
    `INSERT INTO refresh_tokens (token_hash, client_id, user_id, tenant_id, session_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval)`,
    [sha256(refresh), app.id, user.id, tenant.id, sessionId, scope, String(config.refreshTokenDays)]
  );
  return { access_token: accessToken, token_type: "Bearer", expires_in: config.accessTokenSeconds, id_token: idToken, refresh_token: refresh, scope };
}

oidc.post("/oauth/token", tokenLimiter, wrap(async (req, res) => {
  res.set("cache-control", "no-store");
  const fail = (error, description, status = 400) => res.status(status).json({ error, error_description: description });
  const { app, error } = await authenticateClient(req);
  if (error) return fail(error, "Client authentication failed.", 401);
  const grant = req.body.grant_type;

  if (grant === "authorization_code") {
    const code = String(req.body.code ?? "");
    const ac = code && (await one(`SELECT * FROM auth_codes WHERE code_hash = $1`, [sha256(code)]));
    if (!ac || ac.client_id !== app.id) return fail("invalid_grant", "Unknown code.");
    if (ac.used_at || new Date(ac.expires_at) < new Date()) {
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND client_id = $2`, [ac.session_id, app.id]);
      return fail("invalid_grant", "Code expired or already used.");
    }
    if (String(req.body.redirect_uri ?? "") !== ac.redirect_uri) return fail("invalid_grant", "redirect_uri mismatch.");
    if (ac.code_challenge) {
      const v = String(req.body.code_verifier ?? "");
      const ok = ac.code_challenge_method === "S256" ? createHash("sha256").update(v).digest("base64url") === ac.code_challenge : v === ac.code_challenge;
      if (!v || !ok) return fail("invalid_grant", "PKCE verification failed.");
    }
    await query(`UPDATE auth_codes SET used_at = now() WHERE code_hash = $1`, [ac.code_hash]);
    const user = await one(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [ac.user_id]);
    const tenant = await one(`SELECT * FROM tenants WHERE id = $1 AND status = 'active'`, [ac.tenant_id]);
    const membership = user && tenant && (await membershipFor(user.id, tenant.id));
    if (!user || !tenant || !membership) return fail("invalid_grant", "Account no longer active.");
    return res.json(await issueTokens({ app, user, tenant, membership, sessionId: ac.session_id, scope: ac.scope, nonce: ac.nonce }));
  }

  if (grant === "refresh_token") {
    const raw = String(req.body.refresh_token ?? "");
    const rt = raw && (await one(`SELECT * FROM refresh_tokens WHERE token_hash = $1`, [sha256(raw)]));
    if (!rt || rt.client_id !== app.id || rt.revoked_at || new Date(rt.expires_at) < new Date()) return fail("invalid_grant", "Refresh token invalid.");
    if (rt.session_id) {
      const s = await one(`SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`, [rt.session_id]);
      if (!s) { await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [rt.token_hash]); return fail("invalid_grant", "Session ended."); }
    }
    const user = await one(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [rt.user_id]);
    const tenant = await one(`SELECT * FROM tenants WHERE id = $1 AND status = 'active'`, [rt.tenant_id]);
    const membership = user && tenant && (await membershipFor(user.id, tenant.id));
    const ta = tenant && (await tenantApp(tenant.id, app.id));
    if (!user || !tenant || !membership || !canOpen(membership, ta)) return fail("invalid_grant", "Access has been removed.");
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [rt.token_hash]);
    return res.json(await issueTokens({ app, user, tenant, membership, sessionId: rt.session_id, scope: rt.scope }));
  }
  fail("unsupported_grant_type", "Use authorization_code or refresh_token.");
}));

// ---------- userinfo / introspect / revoke ----------
const bearer = (req) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || String(req.body?.access_token ?? "");

oidc.all("/oauth/userinfo", wrap(async (req, res) => {
  try {
    const p = await verifyJwt(bearer(req));
    if (p.token_use !== "access") throw new Error("not an access token");
    const { iss: _i, aud: _a, exp: _e, iat: _t, nbf: _n, scope: _s, client_id: _c, token_use: _u, ...claims } = p;
    res.json(claims);
  } catch {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"').status(401).json({ error: "invalid_token" });
  }
}));

oidc.post("/oauth/introspect", tokenLimiter, wrap(async (req, res) => {
  const { app, error } = await authenticateClient(req);
  if (error) return res.status(401).json({ error });
  const raw = String(req.body.token ?? "");
  try {
    const p = await verifyJwt(raw, { audience: app.id });
    if (p.sid) {
      const s = await one(`SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL`, [p.sid]);
      if (!s) return res.json({ active: false });
    }
    return res.json({ active: true, ...p });
  } catch {
    const rt = await one(`SELECT * FROM refresh_tokens WHERE token_hash = $1 AND client_id = $2`, [sha256(raw), app.id]);
    const active = !!rt && !rt.revoked_at && new Date(rt.expires_at) > new Date();
    return res.json(active ? { active, sub: rt.user_id, client_id: app.id, scope: rt.scope, exp: Math.floor(new Date(rt.expires_at) / 1000) } : { active: false });
  }
}));

oidc.post("/oauth/revoke", tokenLimiter, wrap(async (req, res) => {
  const { app, error } = await authenticateClient(req);
  if (error) return res.status(401).json({ error });
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND client_id = $2`, [sha256(String(req.body.token ?? "")), app.id]);
  res.sendStatus(200);
}));

// ---------- end session ----------
oidc.get("/oauth/logout", wrap(async (req, res) => {
  const post = String(req.query.post_logout_redirect_uri ?? "");
  let target = `${iss()}/login`;
  if (post) {
    const ok = await one(`SELECT 1 FROM apps WHERE $1 = ANY(post_logout_uris)`, [post]);
    if (ok) { const u = new URL(post); if (req.query.state) u.searchParams.set("state", String(req.query.state)); target = u.toString(); }
  }
  if (req.auth?.session) {
    await endSession(req.auth.session.id);
    audit({ tenantId: req.auth.session.tenant_id, userId: req.auth.user.id, event: "logout", ip: clientIp(req), detail: { via: "oidc" } });
  }
  clearSessionCookie(res);
  res.redirect(target);
}));

