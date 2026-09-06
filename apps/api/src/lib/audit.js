import { query } from "../db.js";

// Fire-and-forget audit entry. Never throws.
export function audit({ tenantId = null, userId = null, actorId = null, event, target = null, detail = {}, ip = null }) {
  query(
    `INSERT INTO audit_log (tenant_id, user_id, actor_id, event, target, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, userId, actorId, event, target, detail, ip]
  ).catch((e) => console.error("[audit]", e.message));
}

export const clientIp = (req) => (req.headers["x-forwarded-for"]?.split(",")[0] ?? req.socket?.remoteAddress ?? "").trim() || null;
