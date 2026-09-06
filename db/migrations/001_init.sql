-- Roadside SSO: initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Tenants = companies (organizations) that use the SSO.
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',          -- active | suspended
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,       -- mfaRequiredRoles[], sessionHours, quickLinks[], allowedEmailDomains[]
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- People. One identity across every tenant they belong to.
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                citext UNIQUE NOT NULL,
  name                 text NOT NULL,
  phone                text,
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  is_platform_admin    boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'active', -- active | disabled
  mfa_secret           text,
  mfa_enabled          boolean NOT NULL DEFAULT false,
  failed_logins        int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Membership of a user in a tenant, with tenant-scoped roles / locations.
CREATE TABLE memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roles         text[] NOT NULL DEFAULT '{}',
  locations     text[] NOT NULL DEFAULT '{}',
  app_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { "<app_id>": "allow" | "deny" }
  title         text,
  status        text NOT NULL DEFAULT 'active',         -- active | disabled
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

-- App catalog: every website / solution that can connect to a dashboard.
CREATE TABLE apps (
  id                     text PRIMARY KEY,               -- slug, doubles as OIDC client_id
  name                   text NOT NULL,
  category               text NOT NULL DEFAULT 'General',
  description            text NOT NULL DEFAULT '',
  icon                   text NOT NULL DEFAULT 'apps',   -- tabler icon name
  base_url               text NOT NULL DEFAULT '',
  launch_url             text NOT NULL DEFAULT '',
  initiate_login_uri     text,                           -- OIDC third-party initiated login (optional)
  redirect_uris          text[] NOT NULL DEFAULT '{}',
  post_logout_uris       text[] NOT NULL DEFAULT '{}',
  backchannel_logout_uri text,
  client_type            text NOT NULL DEFAULT 'confidential', -- confidential | public
  client_secret_hash     text,
  owner                  text NOT NULL DEFAULT 'internal',     -- internal | partner
  visibility             text NOT NULL DEFAULT 'catalog',      -- catalog (any tenant admin may connect) | private (platform assigns)
  mobile                 boolean NOT NULL DEFAULT true,        -- show on mobile dashboards
  status                 text NOT NULL DEFAULT 'active',       -- active | disabled
  sort                   int NOT NULL DEFAULT 100,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Which apps a tenant has connected, and how the tile looks for that tenant.
CREATE TABLE tenant_apps (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id        text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,
  allowed_roles text[] NOT NULL DEFAULT '{}',            -- empty = every active member
  label         text,                                    -- tile label override
  launch_url    text,                                    -- launch override (tenant specific subdomain etc.)
  pinned        boolean NOT NULL DEFAULT false,
  sort          int NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id)
);

-- Portal sessions (cookie based).
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  token_hash   text UNIQUE NOT NULL,
  mfa_passed   boolean NOT NULL DEFAULT false,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- OIDC authorization codes.
CREATE TABLE auth_codes (
  code_hash             text PRIMARY KEY,
  client_id             text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id            uuid REFERENCES sessions(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  scope                 text NOT NULL DEFAULT 'openid',
  nonce                 text,
  code_challenge        text,
  code_challenge_method text,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz
);

-- OIDC refresh tokens.
CREATE TABLE refresh_tokens (
  token_hash  text PRIMARY KEY,
  client_id   text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions(id) ON DELETE CASCADE,
  scope       text NOT NULL DEFAULT 'openid',
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

-- RS256 signing keys (shared by every instance).
CREATE TABLE signing_keys (
  kid         text PRIMARY KEY,
  private_jwk jsonb NOT NULL,
  public_jwk  jsonb NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Password reset / invite tokens.
CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- Audit trail: sign-ins, launches, admin changes.
CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid,
  user_id   uuid,
  actor_id  uuid,
  event     text NOT NULL,
  target    text,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip        text
);
CREATE INDEX audit_tenant_idx ON audit_log(tenant_id, at DESC);
CREATE INDEX audit_user_idx ON audit_log(user_id, at DESC);
