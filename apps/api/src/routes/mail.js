// Unified mail: personal and shared mailboxes per tenant.
import { Router } from "express";
import express from "express";
import { one, query, rows } from "../db.js";
import { encryptSecret } from "../lib/mailcrypto.js";
import { PRESETS, testConnection, syncAccount, fetchMessage, fetchAttachment, setFlags, moveMessage, sendMail } from "../lib/mail.js";
import { isTenantAdmin } from "../lib/access.js";
import { audit, clientIp } from "../lib/audit.js";
import { requireUser, requireTenant, wrap, bad, notFound, HttpError } from "../middleware/guards.js";

export const mail = Router();
mail.use(requireUser, requireTenant);

const isEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
// ImapFlow reports auth failures as "Command failed"; the server's own text is more useful.
const mailError = (e) => (e?.authenticationFailed ? `the mail server rejected the username or password${e.responseText ? ` (${e.responseText})` : ""}` : e?.responseText || e?.message || String(e));
const publicAccount = (a, me) => ({
  id: a.id, displayName: a.display_name, email: a.email_address, provider: a.provider, shared: a.shared, allowedRoles: a.allowed_roles, signature: a.signature,
  status: a.status, lastSyncAt: a.last_sync_at, lastError: a.last_error, mine: a.owner_user_id === me.id, canManage: a.owner_user_id === me.id || (a.shared && me.admin),
  unread: Number(a.unread ?? 0),
});

// Accounts the caller may read: their own, plus shared ones their role allows (admins see every shared inbox).
async function visibleAccounts(req) {
  const { user, tenant, membership } = req.auth;
  const admin = isTenantAdmin(user, membership);
  const roles = membership?.roles ?? [];
  return rows(
    `SELECT a.*, (SELECT count(*)::int FROM mail_messages m WHERE m.account_id = a.id AND m.folder = 'inbox' AND NOT m.seen) AS unread
     FROM mail_accounts a WHERE a.tenant_id = $1 AND (a.owner_user_id = $2 OR (a.shared AND ($3 OR a.allowed_roles = '{}' OR a.allowed_roles && $4::text[])))
     ORDER BY a.shared, a.display_name`,
    [tenant.id, user.id, admin, roles]
  );
}
async function accountFor(req, id) {
  const list = await visibleAccounts(req);
  const a = list.find((x) => x.id === id);
  if (!a) throw notFound("Mailbox not found.");
  return a;
}
const meCtx = (req) => ({ id: req.auth.user.id, admin: isTenantAdmin(req.auth.user, req.auth.membership) });

mail.get("/accounts", wrap(async (req, res) => {
  const me = meCtx(req);
  res.json({ accounts: (await visibleAccounts(req)).map((a) => publicAccount(a, me)), presets: Object.keys(PRESETS) });
}));

function accountInput(body, existing) {
  const provider = ["gmail", "outlook", "yahoo", "imap"].includes(body.provider) ? body.provider : existing?.provider ?? "gmail";
  const preset = PRESETS[provider] ?? {};
  const v = {
    display_name: String(body.displayName ?? existing?.display_name ?? "").trim().slice(0, 80),
    email_address: String(body.email ?? existing?.email_address ?? "").trim().toLowerCase(),
    provider,
    imap_host: String(body.imapHost || preset.imap_host || existing?.imap_host || "").trim(),
    imap_port: Number(body.imapPort || preset.imap_port || existing?.imap_port || 993),
    imap_secure: body.imapSecure !== undefined ? !!body.imapSecure : (preset.imap_secure ?? existing?.imap_secure ?? true),
    smtp_host: String(body.smtpHost || preset.smtp_host || existing?.smtp_host || "").trim(),
    smtp_port: Number(body.smtpPort || preset.smtp_port || existing?.smtp_port || 465),
    smtp_secure: body.smtpSecure !== undefined ? !!body.smtpSecure : (preset.smtp_secure ?? existing?.smtp_secure ?? true),
    username: String(body.username || body.email || existing?.username || "").trim(),
    signature: String(body.signature ?? existing?.signature ?? "").slice(0, 2000),
  };
  if (!v.display_name) throw bad("Give the mailbox a name.");
  if (!isEmail(v.email_address)) throw bad("A valid email address is required.");
  if (!v.imap_host || !v.smtp_host) throw bad("Incoming and outgoing mail servers are required.");
  return v;
}

mail.post("/accounts", wrap(async (req, res) => {
  const { user, tenant, membership } = req.auth;
  const admin = isTenantAdmin(user, membership);
  const shared = !!req.body.shared;
  if (shared && !admin) throw new HttpError(403, "forbidden", "Only an administrator can add a shared inbox.");
  const v = accountInput(req.body);
  const password = String(req.body.password ?? "");
  if (!password) throw bad("The app password is required.");
  const probe = { ...v, password_enc: encryptSecret(password) };
  let folders;
  try { folders = await testConnection(probe); }
  catch (e) { throw bad(`Could not sign in to the mailbox: ${mailError(e)}. For Gmail, use an App Password (Google Account → Security → 2-Step Verification → App passwords), and make sure IMAP is turned on in Gmail settings.`, "mail_auth"); }
  const allowedRoles = shared ? (Array.isArray(req.body.allowedRoles) ? req.body.allowedRoles.map((r) => String(r).toLowerCase()) : []) : [];
  const row = await one(
    `INSERT INTO mail_accounts (tenant_id, owner_user_id, shared, allowed_roles, display_name, email_address, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, signature, folders, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [tenant.id, shared ? null : user.id, shared, allowedRoles, v.display_name, v.email_address, v.provider, v.imap_host, v.imap_port, v.imap_secure, v.smtp_host, v.smtp_port, v.smtp_secure, v.username, probe.password_enc, v.signature, folders, user.id]
  );
  audit({ tenantId: tenant.id, userId: user.id, actorId: user.id, event: shared ? "mail.shared_added" : "mail.account_added", target: v.email_address, ip: clientIp(req) });
  syncAccount(row).catch((e) => query(`UPDATE mail_accounts SET status = 'error', last_error = $2 WHERE id = $1`, [row.id, String(e.message).slice(0, 500)]));
  res.status(201).json(publicAccount({ ...row, unread: 0 }, meCtx(req)));
}));

mail.patch("/accounts/:id", wrap(async (req, res) => {
  const a = await accountFor(req, req.params.id);
  const me = meCtx(req);
  if (!(a.owner_user_id === me.id || (a.shared && me.admin))) throw new HttpError(403, "forbidden", "You cannot change this mailbox.");
  const v = accountInput({ ...req.body, email: req.body.email ?? a.email_address }, a);
  let password_enc = a.password_enc, folders = a.folders;
  if (req.body.password) {
    password_enc = encryptSecret(String(req.body.password));
    try { folders = await testConnection({ ...v, password_enc }); } catch (e) { throw bad(`Could not sign in with the new password: ${e.message}`, "mail_auth"); }
  }
  const allowedRoles = a.shared && Array.isArray(req.body.allowedRoles) ? req.body.allowedRoles.map((r) => String(r).toLowerCase()) : a.allowed_roles;
  const status = req.body.enabled === false ? "disabled" : (req.body.enabled === true || req.body.password ? "active" : a.status);
  await query(
    `UPDATE mail_accounts SET display_name=$2, email_address=$3, provider=$4, imap_host=$5, imap_port=$6, imap_secure=$7, smtp_host=$8, smtp_port=$9, smtp_secure=$10, username=$11, password_enc=$12, signature=$13, allowed_roles=$14, status=$15, folders=$16, last_error = CASE WHEN $15 = 'active' THEN NULL ELSE last_error END WHERE id = $1`,
    [a.id, v.display_name, v.email_address, v.provider, v.imap_host, v.imap_port, v.imap_secure, v.smtp_host, v.smtp_port, v.smtp_secure, v.username, password_enc, v.signature, allowedRoles, status, folders]
  );
  res.json({ ok: true });
}));

mail.delete("/accounts/:id", wrap(async (req, res) => {
  const a = await accountFor(req, req.params.id);
  const me = meCtx(req);
  if (!(a.owner_user_id === me.id || (a.shared && me.admin))) throw new HttpError(403, "forbidden", "You cannot remove this mailbox.");
  await query(`DELETE FROM mail_accounts WHERE id = $1`, [a.id]);
  audit({ tenantId: req.auth.tenant.id, userId: req.auth.user.id, actorId: req.auth.user.id, event: "mail.account_removed", target: a.email_address, ip: clientIp(req) });
  res.json({ ok: true });
}));

mail.post("/accounts/:id/sync", wrap(async (req, res) => {
  const a = await accountFor(req, req.params.id);
  try { res.json(await syncAccount(a)); }
  catch (e) { await query(`UPDATE mail_accounts SET status = 'error', last_error = $2 WHERE id = $1`, [a.id, String(e.message).slice(0, 500)]); throw bad(`Sync failed: ${e.message}`, "mail_sync"); }
}));

// ----- messages (cached list) -----
mail.get("/messages", wrap(async (req, res) => {
  const accounts = await visibleAccounts(req);
  if (!accounts.length) return res.json({ messages: [], page: 1, hasMore: false });
  const folder = ["inbox", "sent", "archive", "trash", "starred"].includes(req.query.folder) ? req.query.folder : "inbox";
  const ids = req.query.accountId && accounts.some((a) => a.id === req.query.accountId) ? [req.query.accountId] : accounts.map((a) => a.id);
  const page = Math.max(1, Number(req.query.page) || 1), limit = 50;
  const q = String(req.query.q ?? "").trim();
  const conds = [`m.account_id = ANY($1::uuid[])`];
  const params = [ids];
  if (folder === "starred") conds.push(`m.flagged`); else conds.push(`m.folder = $${params.push(folder)}`);
  if (req.query.unread === "1") conds.push(`NOT m.seen`);
  if (q) { params.push(`%${q}%`); conds.push(`(m.subject ILIKE $${params.length} OR m.from_name ILIKE $${params.length} OR m.from_addr ILIKE $${params.length} OR m.to_addrs ILIKE $${params.length})`); }
  params.push(limit + 1, (page - 1) * limit);
  const list = await rows(
    `SELECT m.id, m.account_id, m.folder, m.uid, m.subject, m.from_name, m.from_addr, m.to_addrs, m.date, m.seen, m.flagged, m.answered, m.has_attachments, m.size,
            a.display_name AS account_name, a.email_address AS account_email
     FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id WHERE ${conds.join(" AND ")} ORDER BY m.date DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ messages: list.slice(0, limit), page, hasMore: list.length > limit });
}));

async function messageFor(req, id) {
  const m = await one(`SELECT * FROM mail_messages WHERE id = $1`, [id]);
  if (!m) throw notFound("Message not found.");
  const a = await accountFor(req, m.account_id);
  return { m, a };
}

mail.get("/messages/:id", wrap(async (req, res) => {
  const { m, a } = await messageFor(req, req.params.id);
  const full = await fetchMessage(a, m.folder, m.uid);
  if (!full) { await query(`DELETE FROM mail_messages WHERE id = $1`, [m.id]); throw notFound("That message is no longer in the mailbox."); }
  if (!m.seen) { query(`UPDATE mail_messages SET seen = true WHERE id = $1`, [m.id]).catch(() => {}); setFlags(a, m.folder, m.uid, { seen: true }).catch(() => {}); }
  res.json({ id: m.id, accountId: a.id, accountEmail: a.email_address, folder: m.folder, uid: m.uid, flagged: m.flagged, ...full });
}));

mail.get("/messages/:id/attachments/:index", wrap(async (req, res) => {
  const { m, a } = await messageFor(req, req.params.id);
  const att = await fetchAttachment(a, m.folder, m.uid, Number(req.params.index));
  if (!att) throw notFound("Attachment not found.");
  res.setHeader("content-type", att.contentType || "application/octet-stream");
  res.setHeader("content-disposition", `${req.query.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
  res.send(att.content);
}));

mail.post("/messages/:id/flags", wrap(async (req, res) => {
  const { m, a } = await messageFor(req, req.params.id);
  const flags = { seen: typeof req.body.seen === "boolean" ? req.body.seen : undefined, flagged: typeof req.body.flagged === "boolean" ? req.body.flagged : undefined };
  await setFlags(a, m.folder, m.uid, flags);
  await query(`UPDATE mail_messages SET seen = COALESCE($2, seen), flagged = COALESCE($3, flagged) WHERE id = $1`, [m.id, flags.seen ?? null, flags.flagged ?? null]);
  res.json({ ok: true });
}));

mail.post("/messages/:id/move", wrap(async (req, res) => {
  const { m, a } = await messageFor(req, req.params.id);
  const to = ["archive", "trash", "inbox"].includes(req.body.to) ? req.body.to : null;
  if (!to) throw bad("Choose archive, trash or inbox.");
  const moved = await moveMessage(a, m.folder, m.uid, to);
  if (moved) await query(`DELETE FROM mail_messages WHERE id = $1`, [m.id]);
  syncAccount(a).catch(() => {});
  res.json({ ok: true, moved });
}));

// ----- send -----
const sendJson = express.json({ limit: "30mb" });
mail.post("/send", sendJson, wrap(async (req, res) => {
  const a = await accountFor(req, String(req.body.accountId ?? ""));
  const to = String(req.body.to ?? "").trim(), cc = String(req.body.cc ?? "").trim(), bcc = String(req.body.bcc ?? "").trim();
  if (!to) throw bad("Add at least one recipient.");
  const subject = String(req.body.subject ?? "").slice(0, 500);
  const text = String(req.body.text ?? "");
  const html = req.body.html ? String(req.body.html) : undefined;
  let inReplyTo = null, references = [];
  if (req.body.replyToMessageId) {
    const { m, a: origA } = await messageFor(req, String(req.body.replyToMessageId));
    if (origA.id === a.id || true) {
      const orig = await fetchMessage(origA, m.folder, m.uid);
      if (orig?.messageId) { inReplyTo = orig.messageId; references = [...(orig.references || []), orig.messageId].slice(-20); }
    }
  }
  const attachments = (Array.isArray(req.body.attachments) ? req.body.attachments : []).slice(0, 20).map((x) => ({
    filename: String(x.filename || "attachment").slice(0, 200), contentType: String(x.contentType || "application/octet-stream"), content: Buffer.from(String(x.contentBase64 || ""), "base64"),
  }));
  const total = attachments.reduce((n, x) => n + x.content.length, 0);
  if (total > 25 * 1024 * 1024) throw bad("Attachments must total under 25 MB.");
  try {
    const messageId = await sendMail(a, { to, cc, bcc, subject, text, html, inReplyTo, references, attachments });
    if (req.body.replyToMessageId) query(`UPDATE mail_messages SET answered = true WHERE id = $1`, [req.body.replyToMessageId]).catch(() => {});
    audit({ tenantId: req.auth.tenant.id, userId: req.auth.user.id, actorId: req.auth.user.id, event: "mail.sent", target: a.email_address, detail: { to, subject: subject.slice(0, 120) }, ip: clientIp(req) });
    syncAccount(a).catch(() => {});
    res.json({ ok: true, messageId });
  } catch (e) {
    throw bad(`Could not send: ${e.message}`, "mail_send");
  }
}));

// ----- dashboard summary -----
mail.get("/summary", wrap(async (req, res) => {
  const accounts = await visibleAccounts(req);
  const me = meCtx(req);
  const latest = accounts.length ? await rows(
    `SELECT m.id, m.subject, m.from_name, m.from_addr, m.date, m.seen, a.display_name AS account_name
     FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id WHERE m.account_id = ANY($1::uuid[]) AND m.folder = 'inbox' AND NOT m.seen ORDER BY m.date DESC LIMIT 6`,
    [accounts.map((a) => a.id)]
  ) : [];
  res.json({ accounts: accounts.map((a) => publicAccount(a, me)), unread: accounts.reduce((n, a) => n + Number(a.unread ?? 0), 0), latest });
}));
