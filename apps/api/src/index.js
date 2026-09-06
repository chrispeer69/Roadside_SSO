// Roadside SSO server: JSON API for the portal, OIDC provider for connected apps, static portal in production.
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";
import { initKeys } from "./lib/keys.js";
import { attachSession } from "./middleware/session.js";
import { csrfGuard, HttpError } from "./middleware/guards.js";
import { auth } from "./routes/auth.js";
import { me } from "./routes/me.js";
import { tenant } from "./routes/tenant.js";
import { platform } from "./routes/platform.js";
import { oidc } from "./routes/oidc.js";
import { launch } from "./routes/launch.js";
import { mail } from "./routes/mail.js";
import { startMailScheduler } from "./lib/mail.js";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const origins = new Set([config.publicUrl, config.portalDevUrl, ...config.corsOrigins]);
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.has(o)), credentials: true }));
app.use(cookieParser(config.sessionSecret));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));
app.use(attachSession);

app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "roadside-sso", env: config.env }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.use("/api", csrfGuard);
app.use("/api/auth", auth);
app.use("/api/me", me);
app.use("/api/tenant", tenant);
app.use("/api/platform", platform);
app.use("/api/mail", mail);
app.use(oidc);
app.use(launch);
app.all("/api/*", (req, res) => res.status(404).json({ error: "not_found" }));

// Portal: built files in production; redirect to the Vite dev server otherwise.
const dist = fileURLToPath(new URL("../../portal/dist/", import.meta.url));
if (existsSync(dist + "index.html")) {
  app.use(express.static(dist, { index: false, maxAge: "1h", setHeaders: (res, p) => { if (p.endsWith("sw.js")) res.setHeader("cache-control", "no-cache"); } }));
  app.get("*", (req, res) => res.set("cache-control", "no-cache").sendFile(dist + "index.html"));
} else {
  app.get("*", (req, res) => res.redirect(`${config.portalDevUrl}${req.originalUrl}`));
}

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "bad_json", message: "Malformed request body." });
  console.error("[error]", err);
  res.status(500).json({ error: "server_error", message: "Something went wrong." });
});

async function main() {
  await migrate();
  await initKeys();
  await seed();
  // Housekeeping every hour: expired codes/tokens/sessions.
  setInterval(() => {
    pool.query(`DELETE FROM auth_codes WHERE expires_at < now() - interval '1 hour'`).catch(() => {});
    pool.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`).catch(() => {});
    pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`).catch(() => {});
    pool.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`).catch(() => {});
  }, 3600e3).unref();
  startMailScheduler();
  app.listen(config.port, () => console.log(`[roadside-sso] ${config.env} on :${config.port}  issuer=${config.publicUrl}`));
}
main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
