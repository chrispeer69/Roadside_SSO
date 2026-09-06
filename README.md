# ROADSIDE SSO

One sign-in for every application a towing company uses, on the desk and in the truck.
Multi-tenant: many companies (tenants) share one identity service, each with its own dashboard of tiles,
its own people, roles and security policy. A master (platform) admin runs the whole thing.

## What is in the box

| Path | What it is |
|---|---|
| `apps/api` | Node/Express service: portal API, **OpenID Connect provider** for connected websites, serves the built portal. |
| `apps/portal` | React (Vite) dashboard: sign-in, tiles, tenant admin, platform admin. Installable on phones (PWA manifest). |
| `packages/auth` | `@roadside/auth` SDK for the websites you connect: Express middleware, browser PKCE client, React provider. |
| `db/migrations` | Postgres schema. Applied automatically at boot. |
| `config/apps.json` | Seed app catalog (US Tow Dispatch, AI Connect, Alliance, Stats, Towbook, Gmail, GoHighLevel). |
| `scripts/smoke.mjs` | Dev-only end-to-end test of the API and the OIDC flow. |

## Two admin levels

* **Platform admin (master)** – `Platform` tab. Creates and suspends organizations, manages the app catalog
  (registers websites as OIDC clients, rotates client secrets), sees every sign-in, grants platform admin.
* **Tenant admin (owner / admin role)** – `People`, `Apps`, `Security` pages, scoped to their organization.
  Adds people (temporary password or reset link), sets roles and locations, chooses which catalog apps appear as tiles,
  which roles can open each tile, per-person allow/deny exceptions, two-step policy, session length, audit log.
* **Everyone else** – dashboard of tiles they are allowed to open, account page (password, two-step, devices).

Self-registration is off by design: people are provisioned by an administrator.

## Run locally

```bash
cp .env.example .env          # defaults work with the docker Postgres below
npm install
npm run db:up                 # Postgres 16 on localhost:5436
npm run build                 # build the portal once (or use npm run dev for hot reload)
npm start                     # http://localhost:8787
```

First boot migrates the database, generates the RS256 signing key, seeds the catalog and creates the bootstrap
platform admin from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (default `admin@roadside.local` / `ChangeMe!2026`)
inside the first tenant (`BOOTSTRAP_TENANT_NAME`). Change that password on the Account page.

Development with hot reload: `npm run dev` runs the API on 8787 and Vite on 5173 (proxied).
Dev-only checks: `npm run db:reset && npm start` then `npm run smoke` in another terminal.

## Deploy on Railway

1. Railway project → **New service → Database → PostgreSQL**. Railway exposes `DATABASE_URL` to services in the project.
2. **New service → GitHub repo** `chrispeer69/Roadside_SSO`. The `Dockerfile` and `railway.json` are picked up automatically
   (health check `/api/health`).
3. Variables on the web service:
   * `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference the Postgres service)
   * `PUBLIC_URL` = the public URL of the service, e.g. `https://roadside-sso.up.railway.app` or your custom domain (no trailing slash). This is the OIDC issuer; change it and every connected site must use the new value.
   * `SESSION_SECRET` = long random string (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`)
   * `NODE_ENV` = `production`
   * `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_TENANT_NAME`, `BOOTSTRAP_TENANT_SLUG` (used only on the very first boot; in production the admin must change the password at first sign-in)
4. Generate a domain (Settings → Networking) and put it in `PUBLIC_URL`. Redeploy.

## Connect one of your websites (single sign-on)

1. Platform → App catalog → the app (or **Register app**). Set **Redirect URIs** to the site's callback,
   e.g. `https://www.ustowdispatch.com/auth/callback`, and post-logout URI to the site root. Click **Secret** and copy the client secret.
2. In the website (Express):

```js
import express from "express";
import cookieParser from "cookie-parser";
import { createAuth } from "@roadside/auth/server";      // npm install github:chrispeer69/Roadside_SSO#main -w packages/auth, or copy packages/auth

const auth = createAuth({
  issuer: "https://sso.yourdomain.com",                  // PUBLIC_URL of Roadside SSO
  clientId: "ustowdispatch",
  clientSecret: process.env.SSO_SECRET,
  redirectUri: "https://www.ustowdispatch.com/auth/callback",
});
app.use(cookieParser());
app.get("/auth/login", auth.login);
app.get("/auth/callback", auth.callback);
app.get("/auth/logout", auth.logout);
app.post("/auth/backchannel-logout", express.urlencoded({ extended: false }), auth.backchannelLogout);

app.get("/dispatch", auth.requireAuth, auth.requireRole("dispatcher", "manager", "owner"), (req, res) => {
  // req.user = { sub, email, name, orgId, orgName, roles[], locations[], apps[], ... }
});
```

   Any OIDC library works too (discovery at `/.well-known/openid-configuration`). Browser-only sites use
   `@roadside/auth/browser` (`createClient`) or `@roadside/auth/react` (`AuthProvider`, `useAuth`) with a **public** client.
3. Optional: set the app's **Login-initiation URL** to `https://site/auth/login` so the tile starts SSO directly, and the
   **Back-channel logout URL** to `https://site/auth/backchannel-logout` so signing out of Roadside signs out of the site.

Outside sites that do not support SSO (Towbook, Gmail, GoHighLevel) are **link tiles**. Launch addresses accept
`{email}` and `{org}` placeholders; a tenant can also override the launch address per tile (e.g. a shared Gmail inbox).

## Token claims

`sub email email_verified name phone_number org_id org_slug org_name roles[] locations[] apps[] title platform_admin sid`
Access tokens (RS256, 15 min, `aud` = client id) and id tokens carry the same claims; refresh tokens last 30 days
and are revoked when the person signs out of Roadside, is removed from the organization, or loses the app.

## Data model (Postgres)

`tenants` → `memberships` (roles, locations, per-app overrides) ← `users`
`apps` (catalog / OIDC clients) → `tenant_apps` (tile config, allowed roles)
`sessions`, `auth_codes`, `refresh_tokens`, `signing_keys`, `password_resets`, `audit_log`
