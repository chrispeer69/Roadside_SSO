// Express integration for a website connected to Roadside SSO.
//
//   import express from "express";
//   import cookieParser from "cookie-parser";
//   import { createAuth } from "@roadside/auth/server";
//   const auth = createAuth({ issuer: "https://sso.example.com", clientId: "dispatch", clientSecret: process.env.SSO_SECRET, redirectUri: "https://dispatch.example.com/auth/callback" });
//   app.use(cookieParser());
//   app.get("/auth/login", auth.login);
//   app.get("/auth/callback", auth.callback);
//   app.get("/auth/logout", auth.logout);
//   app.post("/auth/backchannel-logout", express.urlencoded({ extended: false }), auth.backchannelLogout);
//   app.get("/", auth.requireAuth, (req, res) => res.send(`Hello ${req.user.name} from ${req.user.orgName}`));
//
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { parseClaims, hasRole, hasApp } from "./claims.js";

export function createAuth({ issuer, clientId, clientSecret, redirectUri, scope = "openid profile email roadside", cookie = "rsso", secure = true, afterLogin = "/", afterLogout = "/", revokedStore = new Map() }) {
  issuer = issuer.replace(/\/+$/, "");
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const b64 = (b) => b.toString("base64url");
  const cookieOpts = { httpOnly: true, sameSite: "lax", secure, path: "/" };

  async function verify(token) {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId });
    const user = parseClaims(payload);
    if (user.sid && revokedStore.get(user.sid)) throw new Error("session revoked");
    return user;
  }

  async function tokenRequest(params) {
    const r = await fetch(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), ...params }),
    });
    if (!r.ok) throw new Error(`token endpoint ${r.status}: ${await r.text()}`);
    return r.json();
  }

  const login = (req, res) => {
    const verifier = b64(randomBytes(32));
    const state = b64(randomBytes(16));
    const next = typeof req.query.next === "string" && req.query.next.startsWith("/") ? req.query.next : afterLogin;
    res.cookie(`${cookie}_pkce`, JSON.stringify({ verifier, state, next }), { ...cookieOpts, maxAge: 10 * 60e3 });
    const u = new URL(`${issuer}/oauth/authorize`);
    u.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope, state,
      code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
      ...(req.query.login_hint ? { login_hint: String(req.query.login_hint) } : {}),
    }).toString();
    res.redirect(u.toString());
  };

  const callback = async (req, res) => {
    try {
      const saved = JSON.parse(req.cookies?.[`${cookie}_pkce`] ?? "null");
      if (!saved || saved.state !== req.query.state) return res.status(400).send("Login state mismatch. Please try again.");
      if (req.query.error) return res.status(403).send(`Sign-in refused: ${req.query.error_description ?? req.query.error}`);
      const t = await tokenRequest({ grant_type: "authorization_code", code: String(req.query.code), redirect_uri: redirectUri, code_verifier: saved.verifier });
      res.clearCookie(`${cookie}_pkce`, { path: "/" });
      res.cookie(`${cookie}_at`, t.access_token, { ...cookieOpts, maxAge: t.expires_in * 1000 });
      if (t.refresh_token) res.cookie(`${cookie}_rt`, t.refresh_token, { ...cookieOpts, maxAge: 30 * 864e5 });
      res.redirect(saved.next ?? afterLogin);
    } catch (e) {
      res.status(500).send(`Sign-in failed: ${e.message}`);
    }
  };

  const requireAuth = async (req, res, next) => {
    const goLogin = () => (req.accepts("html") ? res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`) : res.status(401).json({ error: "unauthenticated" }));
    let raw = req.cookies?.[`${cookie}_at`] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
    try {
      if (raw) { req.user = await verify(raw); req.accessToken = raw; return next(); }
    } catch { /* expired or invalid: try refresh */ }
    const rt = req.cookies?.[`${cookie}_rt`];
    if (!rt) return goLogin();
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: rt });
      res.cookie(`${cookie}_at`, t.access_token, { ...cookieOpts, maxAge: t.expires_in * 1000 });
      if (t.refresh_token) res.cookie(`${cookie}_rt`, t.refresh_token, { ...cookieOpts, maxAge: 30 * 864e5 });
      req.user = await verify(t.access_token); req.accessToken = t.access_token;
      next();
    } catch {
      res.clearCookie(`${cookie}_rt`, { path: "/" });
      goLogin();
    }
  };

  const requireRole = (...roles) => (req, res, next) => (hasRole(req.user, ...roles) ? next() : res.status(403).send("Insufficient role"));
  const requireApp = (id = clientId) => (req, res, next) => (hasApp(req.user, id) ? next() : res.status(403).send("Not licensed for this app"));

  const logout = (req, res) => {
    res.clearCookie(`${cookie}_at`, { path: "/" });
    res.clearCookie(`${cookie}_rt`, { path: "/" });
    const u = new URL(`${issuer}/oauth/logout`);
    u.searchParams.set("post_logout_redirect_uri", new URL(afterLogout, redirectUri).toString());
    res.redirect(u.toString());
  };

  // POST /auth/backchannel-logout  (form field logout_token) - Roadside SSO calls this when the person signs out anywhere.
  const backchannelLogout = async (req, res) => {
    try {
      const { payload } = await jwtVerify(req.body.logout_token, jwks, { issuer, audience: clientId });
      if (!payload.events?.["http://schemas.openid.net/event/backchannel-logout"]) throw new Error("not a logout token");
      if (payload.sid) revokedStore.set(payload.sid, true);
      res.sendStatus(200);
    } catch {
      res.sendStatus(400);
    }
  };

  return { verify, login, callback, logout, requireAuth, requireRole, requireApp, backchannelLogout };
}
