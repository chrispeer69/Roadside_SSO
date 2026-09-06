// Ending a portal session: revoke it, revoke its refresh tokens, and tell connected apps (OIDC back-channel logout).
import { query, rows } from "../db.js";
import { signJwt } from "./keys.js";
import { randomToken } from "./crypto.js";

export async function endSession(sessionId, { reason = "logout" } = {}) {
  if (!sessionId) return;
  const s = (await rows(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id`, [sessionId]))[0];
  if (!s) return;
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId]);
  const clients = await rows(
    `SELECT DISTINCT a.id, a.backchannel_logout_uri FROM apps a
     WHERE a.backchannel_logout_uri IS NOT NULL AND a.id IN (
       SELECT client_id FROM refresh_tokens WHERE session_id = $1
       UNION SELECT client_id FROM auth_codes WHERE session_id = $1)`,
    [sessionId]
  );
  await Promise.allSettled(clients.map((c) => notifyBackchannel(c, sessionId, s.user_id)));
  return reason;
}

async function notifyBackchannel(client, sid, sub) {
  const logoutToken = await signJwt(
    { events: { "http://schemas.openid.net/event/backchannel-logout": {} }, sid, jti: randomToken(12) },
    { audience: client.id, subject: sub, expiresIn: "2m" }
  );
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    await fetch(client.backchannel_logout_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: logoutToken }),
      signal: ctrl.signal,
    });
  } catch (e) {
    console.warn(`[logout] back-channel to ${client.id} failed: ${e.message}`);
  } finally {
    clearTimeout(t);
  }
}

export async function endAllSessionsForUser(userId, { exceptSessionId = null } = {}) {
  const list = await rows(`SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [userId, exceptSessionId]);
  for (const s of list) await endSession(s.id, { reason: "revoked" });
}
