// Central configuration. Values come from environment variables (Railway) or a local .env file.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(envFile); } catch { /* ignore */ }
}

const env = process.env;
const port = Number(env.PORT ?? 8787);
const isProd = env.NODE_ENV === "production";

export const config = {
  env: env.NODE_ENV ?? "development",
  isProd,
  port,
  databaseUrl: env.DATABASE_URL ?? "postgres://roadside:roadside@localhost:5436/roadside_sso",
  databaseSsl: env.DATABASE_SSL,
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
  portalDevUrl: env.PORTAL_DEV_URL ?? "http://localhost:5173",
  sessionSecret: env.SESSION_SECRET ?? "dev-insecure-session-secret-change-me",
  cookieName: "rsso_session",
  sessionHoursDefault: Number(env.SESSION_HOURS ?? 720),   // 30 days
  accessTokenSeconds: Number(env.ACCESS_TOKEN_SECONDS ?? 900),
  refreshTokenDays: Number(env.REFRESH_TOKEN_DAYS ?? 30),
  authCodeSeconds: 120,
  corsOrigins: (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  bootstrap: {
    adminEmail: env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@roadside.local",
    adminPassword: env.BOOTSTRAP_ADMIN_PASSWORD ?? "ChangeMe!2026",
    adminName: env.BOOTSTRAP_ADMIN_NAME ?? "Platform Admin",
    tenantName: env.BOOTSTRAP_TENANT_NAME ?? "Roadside Towing",
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG ?? "roadside",
  },
};

if (isProd && config.sessionSecret.startsWith("dev-insecure")) {
  console.warn("[config] SESSION_SECRET is not set. Set a long random value in Railway variables.");
}
