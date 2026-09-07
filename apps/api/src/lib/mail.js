// Mail engine: IMAP sync into a cached unified inbox, live message fetch, flags/moves, SMTP send.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { one, query, rows } from "../db.js";
import { decryptSecret } from "./mailcrypto.js";

export const PRESETS = {
  gmail: { imap_host: "imap.gmail.com", imap_port: 993, imap_secure: true, smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_secure: true },
  outlook: { imap_host: "outlook.office365.com", imap_port: 993, imap_secure: true, smtp_host: "smtp.office365.com", smtp_port: 587, smtp_secure: false },
  yahoo: { imap_host: "imap.mail.yahoo.com", imap_port: 993, imap_secure: true, smtp_host: "smtp.mail.yahoo.com", smtp_port: 465, smtp_secure: true },
};
const INITIAL_PER_FOLDER = 150;   // first sync depth
const FLAG_REFRESH_DEPTH = 300;   // cached rows re-checked for read/star/removal on each sync
const FOLDER_KEYS = ["inbox", "sent"];

const creds = (a) => ({ user: a.username, pass: decryptSecret(a.password_enc) });

async function withClient(a, fn) {
  const client = new ImapFlow({
    host: a.imap_host, port: a.imap_port, secure: a.imap_secure, auth: creds(a),
    logger: false, emitLogs: false, socketTimeout: 60e3, greetingTimeout: 20e3, connectionTimeout: 20e3,
  });
  await client.connect();
  try { return await fn(client); }
  finally { try { await client.logout(); } catch { /* ignore */ } }
}

// Resolve special folders once (Gmail: [Gmail]/Sent Mail etc; others by SPECIAL-USE or common names).
async function resolveFolders(client) {
  const boxes = await client.list();
  const bySpecial = (flag) => boxes.find((b) => b.specialUse === flag)?.path;
  const byName = (...names) => boxes.find((b) => names.some((n) => b.path.toLowerCase() === n.toLowerCase() || b.name?.toLowerCase() === n.toLowerCase()))?.path;
  const all = bySpecial("\\All");
  return {
    inbox: "INBOX",
    sent: bySpecial("\\Sent") || byName("Sent", "Sent Items", "Sent Messages") || "Sent",
    trash: bySpecial("\\Trash") || byName("Trash", "Deleted Items", "Deleted") || "Trash",
    drafts: bySpecial("\\Drafts") || byName("Drafts") || "Drafts",
    archive: all || bySpecial("\\Archive") || byName("Archive") || "Archive",
    gmail: !!all,
  };
}

export async function testConnection(a) {
  const folders = await withClient(a, resolveFolders);
  const transport = nodemailer.createTransport({ host: a.smtp_host, port: a.smtp_port, secure: a.smtp_secure, auth: creds(a) });
  await transport.verify();
  return folders;
}

const addrList = (list = []) => list.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address || "")).filter(Boolean).join(", ");
function structureHasAttachment(node) {
  if (!node) return false;
  if (node.disposition === "attachment" || (node.dispositionParameters?.filename && node.type !== "text/plain")) return true;
  return (node.childNodes || []).some(structureHasAttachment);
}

async function ensureFolders(a) {
  if (a.folders?.inbox) return a.folders;
  const folders = await withClient(a, resolveFolders);
  await query(`UPDATE mail_accounts SET folders = $2 WHERE id = $1`, [a.id, folders]);
  return folders;
}

// Sync inbox + sent for one account into mail_messages. Returns counts.
export async function syncAccount(a) {
  const folders = await ensureFolders(a);
  const stats = { added: 0, updated: 0, removed: 0 };
  await withClient(a, async (client) => {
    for (const key of FOLDER_KEYS) {
      const path = folders[key];
      let lock;
      try { lock = await client.getMailboxLock(path); } catch { continue; }
      try {
        const last = await one(`SELECT max(uid)::bigint AS max_uid, count(*)::int AS n FROM mail_messages WHERE account_id = $1 AND folder = $2`, [a.id, key]);
        const uidNext = client.mailbox.uidNext || 1;
        const from = last?.max_uid ? Number(last.max_uid) + 1 : Math.max(1, uidNext - INITIAL_PER_FOLDER);
        if (from < uidNext) {
          for await (const m of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, bodyStructure: true, size: true }, { uid: true })) {
            if (m.uid < from) continue;
            const env = m.envelope || {};
            const f = env.from?.[0] || {};
            await query(
              `INSERT INTO mail_messages (account_id, folder, uid, message_id, thread_key, subject, from_name, from_addr, to_addrs, cc_addrs, date, seen, flagged, answered, has_attachments, size)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
               ON CONFLICT (account_id, folder, uid) DO UPDATE SET seen = EXCLUDED.seen, flagged = EXCLUDED.flagged, answered = EXCLUDED.answered, synced_at = now()`,
              [a.id, key, m.uid, env.messageId || null, env.inReplyTo || env.messageId || null, (env.subject || "").slice(0, 500), (f.name || "").slice(0, 200), (f.address || "").slice(0, 320),
               addrList(env.to).slice(0, 2000), addrList(env.cc).slice(0, 2000), env.date ? new Date(env.date) : new Date(), m.flags?.has("\\Seen") ?? false, m.flags?.has("\\Flagged") ?? false,
               m.flags?.has("\\Answered") ?? false, structureHasAttachment(m.bodyStructure), m.size || 0]
            );
            stats.added++;
          }
        }
        // Refresh flags and detect messages moved out of this folder.
        const cached = await rows(`SELECT id, uid, seen, flagged FROM mail_messages WHERE account_id = $1 AND folder = $2 ORDER BY uid DESC LIMIT $3`, [a.id, key, FLAG_REFRESH_DEPTH]);
        if (cached.length) {
          const present = new Map();
          for await (const m of client.fetch(cached.map((c) => c.uid).join(","), { uid: true, flags: true }, { uid: true })) present.set(Number(m.uid), m.flags);
          for (const c of cached) {
            const flags = present.get(Number(c.uid));
            if (!flags) { await query(`DELETE FROM mail_messages WHERE id = $1`, [c.id]); stats.removed++; continue; }
            const seen = flags.has("\\Seen"), flagged = flags.has("\\Flagged");
            if (seen !== c.seen || flagged !== c.flagged) { await query(`UPDATE mail_messages SET seen = $2, flagged = $3 WHERE id = $1`, [c.id, seen, flagged]); stats.updated++; }
          }
        }
      } finally { lock.release(); }
    }
  });
  await query(`UPDATE mail_accounts SET last_sync_at = now(), last_error = NULL, status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END WHERE id = $1`, [a.id]);
  return stats;
}

const folderPath = (a, folder) => a.folders?.[folder] || (folder === "inbox" ? "INBOX" : null);

export async function fetchMessage(a, folder, uid) {
  const folders = await ensureFolders({ ...a });
  const path = folders[folder];
  return withClient(a, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const m = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!m?.source) return null;
      const parsed = await simpleParser(m.source, { skipImageLinks: false });
      const attachments = (parsed.attachments || []).map((att, index) => ({ index, filename: att.filename || `attachment-${index + 1}`, contentType: att.contentType, size: att.size, cid: att.cid || null, inline: att.contentDisposition === "inline" && !!att.cid }));
      let html = parsed.html || "";
      // Inline images: swap cid: references for data URIs so they render without a network call.
      for (const att of parsed.attachments || []) {
        if (att.cid && html.includes(`cid:${att.cid}`) && att.size < 2_000_000) {
          html = html.split(`cid:${att.cid}`).join(`data:${att.contentType};base64,${att.content.toString("base64")}`);
        }
      }
      return {
        subject: parsed.subject || "", from: addrList(parsed.from?.value), to: addrList(parsed.to?.value), cc: addrList(parsed.cc?.value),
        replyTo: addrList(parsed.replyTo?.value), date: parsed.date, messageId: parsed.messageId || null, references: parsed.references || [], inReplyTo: parsed.inReplyTo || null,
        text: parsed.text || "", html, attachments: attachments.filter((x) => !x.inline),
      };
    } finally { lock.release(); }
  });
}

export async function fetchAttachment(a, folder, uid, index) {
  const folders = await ensureFolders({ ...a });
  return withClient(a, async (client) => {
    const lock = await client.getMailboxLock(folders[folder]);
    try {
      const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m?.source) return null;
      const parsed = await simpleParser(m.source);
      const att = (parsed.attachments || [])[index];
      return att ? { filename: att.filename || `attachment-${index + 1}`, contentType: att.contentType, content: att.content } : null;
    } finally { lock.release(); }
  });
}

export async function setFlags(a, folder, uid, { seen, flagged }) {
  const folders = await ensureFolders({ ...a });
  await withClient(a, async (client) => {
    const lock = await client.getMailboxLock(folders[folder]);
    try {
      if (seen === true) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      if (seen === false) await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      if (flagged === true) await client.messageFlagsAdd(String(uid), ["\\Flagged"], { uid: true });
      if (flagged === false) await client.messageFlagsRemove(String(uid), ["\\Flagged"], { uid: true });
    } finally { lock.release(); }
  });
}

// Move between logical folders. Gmail archive = move to All Mail. Returns true when moved.
export async function moveMessage(a, folder, uid, target) {
  const folders = await ensureFolders({ ...a });
  const dest = folders[target];
  if (!dest || dest === folders[folder]) return false;
  return withClient(a, async (client) => {
    if (target === "archive" && !folders.gmail) { try { await client.mailboxCreate(dest); } catch { /* exists */ } }
    const lock = await client.getMailboxLock(folders[folder]);
    try { await client.messageMove(String(uid), dest, { uid: true }); return true; }
    finally { lock.release(); }
  });
}

export async function sendMail(a, { to, cc, bcc, subject, text, html, inReplyTo, references, attachments = [] }) {
  const folders = await ensureFolders({ ...a });
  const mail = {
    from: { name: a.display_name, address: a.email_address }, to, cc: cc || undefined, bcc: bcc || undefined, subject, text, html: html || undefined,
    inReplyTo: inReplyTo || undefined, references: references?.length ? references.join(" ") : undefined,
    attachments: attachments.map((x) => ({ filename: x.filename, contentType: x.contentType, content: x.content })),
  };
  const raw = await new MailComposer(mail).compile().build();
  const transport = nodemailer.createTransport({ host: a.smtp_host, port: a.smtp_port, secure: a.smtp_secure, auth: creds(a) });
  const info = await transport.sendMail({ envelope: { from: a.email_address, to: [to, cc, bcc].filter(Boolean).join(",") }, raw });
  if (!folders.gmail) {
    // Gmail files sent mail itself; other servers need the copy appended.
    try { await withClient(a, (client) => client.append(folders.sent, raw, ["\\Seen"])); } catch { /* best effort */ }
  }
  return info.messageId;
}

// ----- scheduler -----
let running = false;
export async function syncAll() {
  if (running) return;
  running = true;
  try {
    const list = await rows(`SELECT * FROM mail_accounts WHERE status <> 'disabled' ORDER BY last_sync_at NULLS FIRST LIMIT 50`);
    for (const a of list) {
      try { await syncAccount(a); }
      catch (e) { await query(`UPDATE mail_accounts SET status = 'error', last_error = $2, last_sync_at = now() WHERE id = $1`, [a.id, String(e.message || e).slice(0, 500)]); }
    }
  } finally { running = false; }
}
export function startMailScheduler(intervalMs = Number(process.env.MAIL_SYNC_SECONDS || 180) * 1000) {
  setTimeout(() => syncAll().catch(() => {}), 15e3).unref();
  setInterval(() => syncAll().catch(() => {}), intervalMs).unref();
}
