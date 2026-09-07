// Unified mail: every connected mailbox (personal and shared) in one inbox, with reply, forward, attachments.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { get, post, patch, del } from "../api.js";
import { useMe } from "../App.jsx";
import { Btn, Badge, Field, Icon, Modal, Panel, Empty, Picker, ListInput, PageHead, ErrorBox, Spinner, fmtDate, timeAgo, useToast, useConfirm } from "../components/ui.jsx";

const FOLDERS = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "starred", label: "Starred", icon: "star" },
  { id: "sent", label: "Sent", icon: "send" },
  { id: "archive", label: "Archive", icon: "archive" },
  { id: "trash", label: "Trash", icon: "trash" },
];
const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const who = (m) => m.from_name || m.from_addr || "(unknown)";

export default function Mail() {
  const { me } = useMe();
  const toast = useToast();
  const [accounts, setAccounts] = useState(null);
  const [folder, setFolder] = useState("inbox");
  const [accountId, setAccountId] = useState("");
  const [q, setQ] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [list, setList] = useState({ messages: [], page: 1, hasMore: false });
  const [loadingList, setLoadingList] = useState(false);
  const [open, setOpen] = useState(null);      // message id
  const [compose, setCompose] = useState(null); // { mode, to, cc, subject, body, replyToMessageId, accountId, attachments }
  const [manage, setManage] = useState(false);
  const [adding, setAdding] = useState(null);   // account being edited or "new"

  const loadAccounts = useCallback(() => get("/api/mail/accounts").then((r) => setAccounts(r.accounts)).catch((e) => toast(e.message, "bad")), [toast]);
  const loadList = useCallback(async (page = 1) => {
    setLoadingList(true);
    try {
      const p = new URLSearchParams({ folder, page: String(page) });
      if (accountId) p.set("accountId", accountId);
      if (q.trim()) p.set("q", q.trim());
      if (unreadOnly) p.set("unread", "1");
      const r = await get(`/api/mail/messages?${p}`);
      setList((prev) => (page > 1 ? { ...r, messages: [...prev.messages, ...r.messages] } : r));
    } catch (e) { toast(e.message, "bad"); }
    finally { setLoadingList(false); }
  }, [folder, accountId, q, unreadOnly, toast]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { const t = setTimeout(() => loadList(1), q ? 300 : 0); return () => clearTimeout(t); }, [loadList, q]);
  useEffect(() => { const t = setInterval(() => { loadAccounts(); if (!open) loadList(1); }, 90e3); return () => clearInterval(t); }, [loadAccounts, loadList, open]);

  const refresh = async () => {
    for (const a of accounts ?? []) post(`/api/mail/accounts/${a.id}/sync`).catch(() => {});
    setTimeout(() => { loadAccounts(); loadList(1); }, 2500);
    toast("Checking for new mail…");
  };
  const patchLocal = (id, fields) => setList((l) => ({ ...l, messages: l.messages.map((m) => (m.id === id ? { ...m, ...fields } : m)) }));
  const removeLocal = (id) => setList((l) => ({ ...l, messages: l.messages.filter((m) => m.id !== id) }));

  const act = async (m, kind) => {
    try {
      if (kind === "star") { await post(`/api/mail/messages/${m.id}/flags`, { flagged: !m.flagged }); patchLocal(m.id, { flagged: !m.flagged }); }
      if (kind === "unread") { await post(`/api/mail/messages/${m.id}/flags`, { seen: false }); patchLocal(m.id, { seen: false }); if (open === m.id) setOpen(null); }
      if (kind === "archive" || kind === "trash" || kind === "inbox") { await post(`/api/mail/messages/${m.id}/move`, { to: kind }); removeLocal(m.id); if (open === m.id) setOpen(null); toast(kind === "trash" ? "Moved to trash" : kind === "inbox" ? "Moved to inbox" : "Archived"); }
      loadAccounts();
    } catch (e) { toast(e.message, "bad"); }
  };

  const startCompose = (mode, full) => {
    const acct = full ? full.accountId : (accountId || accounts?.[0]?.id || "");
    const quote = full ? `\n\n\nOn ${fmtDate(full.date)}, ${full.from} wrote:\n${(full.text || "").split("\n").map((l) => `> ${l}`).join("\n")}` : "";
    const base = { mode, accountId: acct, to: "", cc: "", bcc: "", subject: "", body: "", replyToMessageId: null, attachments: [], forwardFrom: null };
    if (mode === "reply" || mode === "replyAll") {
      base.to = full.replyTo || full.from;
      if (mode === "replyAll") base.cc = [full.to, full.cc].filter(Boolean).join(", ");
      base.subject = /^re:/i.test(full.subject) ? full.subject : `Re: ${full.subject}`;
      base.body = quote; base.replyToMessageId = full.id;
    } else if (mode === "forward") {
      base.subject = /^fwd?:/i.test(full.subject) ? full.subject : `Fwd: ${full.subject}`;
      base.body = `\n\n---------- Forwarded message ----------\nFrom: ${full.from}\nDate: ${fmtDate(full.date)}\nSubject: ${full.subject}\nTo: ${full.to}\n\n${full.text || ""}`;
      base.forwardFrom = full;
    }
    setCompose(base);
  };

  const totalUnread = (accounts ?? []).reduce((n, a) => n + a.unread, 0);
  const noAccounts = accounts && accounts.length === 0;

  return (
    <div className="mail">
      <aside className="mail-side">
        <div className="mail-side-head">
          <Btn variant="key" icon="pencil" onClick={() => startCompose("new")} disabled={noAccounts}>Compose</Btn>
        </div>
        <nav className="mail-folders">
          {FOLDERS.map((f) => (
            <button key={f.id} aria-current={folder === f.id ? "page" : undefined} onClick={() => { setFolder(f.id); setOpen(null); }}>
              <Icon name={f.icon} />{f.label}{f.id === "inbox" && totalUnread > 0 && <span className="cnt">{totalUnread}</span>}
            </button>
          ))}
        </nav>
        <div className="mail-side-title">Mailboxes <button className="x" onClick={() => setManage(true)} title="Manage mailboxes"><Icon name="settings" /></button></div>
        <nav className="mail-accounts">
          <button aria-current={!accountId ? "page" : undefined} onClick={() => setAccountId("")}><Icon name="mailbox" />All mailboxes</button>
          {(accounts ?? []).map((a) => (
            <button key={a.id} aria-current={accountId === a.id ? "page" : undefined} onClick={() => setAccountId(a.id)} title={a.email}>
              <Icon name={a.shared ? "users" : "mail"} /><span className="grow">{a.displayName}</span>
              {a.status === "error" && <Icon name="alert-circle" style={{ color: "var(--bad)" }} title={a.lastError} />}
              {a.unread > 0 && <span className="cnt">{a.unread}</span>}
            </button>
          ))}
          <button onClick={() => setAdding("new")} className="add"><Icon name="plus" />Add mailbox</button>
        </nav>
      </aside>

      <section className={`mail-list ${open ? "has-open" : ""}`}>
        <div className="mail-toolbar">
          <label className="search"><Icon name="search" /><input placeholder="Search mail" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <button className={`btn sm quiet ${unreadOnly ? "on" : ""}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly((u) => !u)}>Unread</button>
          <Btn sm variant="quiet" icon="refresh" onClick={refresh} aria-label="Check mail" />
        </div>
        {noAccounts ? (
          <Empty icon="mail" title="No mailboxes yet" text="Connect your Gmail or Workspace accounts and they all show up here as one inbox.">
            <Btn variant="key" icon="plus" onClick={() => setAdding("new")}>Add a mailbox</Btn>
          </Empty>
        ) : !accounts || (loadingList && !list.messages.length) ? <div className="pb muted"><Spinner /> Loading…</div> : !list.messages.length ? (
          <Empty icon="inbox" title={q ? "No matches" : "Nothing here"} text={folder === "inbox" && (accounts ?? []).some((a) => !a.lastSyncAt) ? "First sync is running. Give it a moment." : undefined} />
        ) : (
          <div className="mail-rows">
            {list.messages.map((m) => (
              <div key={m.id} className={`mail-row ${m.seen ? "" : "unread"} ${open === m.id ? "active" : ""}`} onClick={() => { setOpen(m.id); if (!m.seen) patchLocal(m.id, { seen: true }); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(m.id)}>
                <button className={`star ${m.flagged ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); act(m, "star"); }} aria-label="Star"><Icon name={m.flagged ? "star-filled" : "star"} /></button>
                <div className="grow">
                  <div className="l1"><span className="who">{folder === "sent" ? `To: ${m.to_addrs.split(",")[0]}` : who(m)}</span><span className="t">{timeAgo(m.date)}</span></div>
                  <div className="l2"><span className="subj">{m.subject || "(no subject)"}</span>{m.has_attachments && <Icon name="paperclip" />}{m.answered && <Icon name="corner-up-left" />}</div>
                  {!accountId && (accounts ?? []).length > 1 && <div className="l3">{m.account_name}</div>}
                </div>
              </div>
            ))}
            {list.hasMore && <div className="center pb"><Btn sm variant="quiet" onClick={() => loadList(list.page + 1)} disabled={loadingList}>Load more</Btn></div>}
          </div>
        )}
      </section>

      <section className={`mail-read ${open ? "open" : ""}`}>
        {open ? <Reader id={open} onClose={() => setOpen(null)} onAct={act} onCompose={startCompose} listItem={list.messages.find((m) => m.id === open)} />
          : <div className="mail-read-empty"><Icon name="mail-opened" /><div>Select a message</div></div>}
      </section>

      {compose && <Compose draft={compose} accounts={accounts ?? []} onClose={() => setCompose(null)} onSent={() => { setCompose(null); toast("Sent"); if (folder === "sent") loadList(1); }} />}
      {manage && <ManageAccounts accounts={accounts ?? []} isAdmin={!!me.membership?.isAdmin || me.user.isPlatformAdmin} onClose={() => setManage(false)} onEdit={(a) => { setManage(false); setAdding(a); }} onChanged={loadAccounts} />}
      {adding && <AccountForm account={adding === "new" ? null : adding} isAdmin={!!me.membership?.isAdmin || me.user.isPlatformAdmin} onClose={() => setAdding(null)} onDone={() => { setAdding(null); loadAccounts(); setTimeout(() => loadList(1), 3000); }} />}
    </div>
  );
}

function Reader({ id, onClose, onAct, onCompose, listItem }) {
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [showHtml, setShowHtml] = useState(true);
  useEffect(() => { setMsg(null); setErr(null); get(`/api/mail/messages/${id}`).then(setMsg).catch((e) => setErr(e.message)); }, [id]);
  const safeHtml = useMemo(() => (msg?.html ? DOMPurify.sanitize(msg.html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"], ADD_ATTR: ["target"] }) : ""), [msg]);
  if (err) return <div className="pb"><ErrorBox error={err} /><Btn sm variant="quiet" onClick={onClose}>Back</Btn></div>;
  if (!msg) return <div className="pb muted"><Spinner /> Opening…</div>;
  const m = listItem ?? { id, flagged: msg.flagged, folder: msg.folder };
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:"IBM Plex Sans",Segoe UI,Arial,sans-serif;font-size:14px;color:#1c2b45;margin:0;padding:4px;word-break:break-word}img{max-width:100%;height:auto}pre{white-space:pre-wrap}blockquote{border-left:3px solid #dde3ec;margin:8px 0;padding-left:10px;color:#4a5b78}a{color:#16417c}</style></head><body>${safeHtml}</body></html>`;
  return (
    <>
      <div className="mail-read-head">
        <button className="btn sm quiet only-mobile" onClick={onClose}><Icon name="arrow-left" />Back</button>
        <div className="actions">
          <Btn sm variant="quiet" icon="corner-up-left" onClick={() => onCompose("reply", msg)}>Reply</Btn>
          <Btn sm variant="quiet" icon="corner-up-left-double" onClick={() => onCompose("replyAll", msg)} className="hide-mobile">Reply all</Btn>
          <Btn sm variant="quiet" icon="corner-up-right" onClick={() => onCompose("forward", msg)}>Forward</Btn>
          <span className="grow" />
          {m.folder !== "archive" && m.folder !== "sent" && <Btn sm variant="quiet" icon="archive" onClick={() => onAct(m, "archive")} aria-label="Archive" title="Archive" />}
          {m.folder !== "inbox" && <Btn sm variant="quiet" icon="inbox" onClick={() => onAct(m, "inbox")} aria-label="Move to inbox" title="Move to inbox" />}
          {m.folder !== "trash" && <Btn sm variant="quiet" icon="trash" onClick={() => onAct(m, "trash")} aria-label="Delete" title="Move to trash" />}
          <Btn sm variant="quiet" icon="mail" onClick={() => onAct(m, "unread")} aria-label="Mark unread" title="Mark unread" />
          <Btn sm variant="quiet" icon={m.flagged ? "star-filled" : "star"} onClick={() => onAct(m, "star")} aria-label="Star" title="Star" />
        </div>
      </div>
      <div className="mail-read-body">
        <h2 className="subject">{msg.subject || "(no subject)"}</h2>
        <div className="meta">
          <div><b>{msg.from}</b></div>
          <div className="tiny muted">to {msg.to}{msg.cc ? ` · cc ${msg.cc}` : ""} · via {msg.accountEmail} · {fmtDate(msg.date)}</div>
        </div>
        {msg.attachments.length > 0 && (
          <div className="attachments">
            {msg.attachments.map((a) => (
              <a key={a.index} className="att" href={`/api/mail/messages/${id}/attachments/${a.index}`} target="_blank" rel="noopener"><Icon name="paperclip" />{a.filename}<span className="tiny faint">{fmtSize(a.size)}</span></a>
            ))}
          </div>
        )}
        {msg.html && msg.text && <div className="row-flex tiny faint mb"><button className="x" style={{ fontSize: 11 }} onClick={() => setShowHtml((v) => !v)}>{showHtml ? "Show plain text" : "Show formatted"}</button></div>}
        {msg.html && showHtml ? <iframe className="mail-frame" title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcdoc} onLoad={(e) => { try { e.target.style.height = `${Math.max(200, e.target.contentDocument.documentElement.scrollHeight + 20)}px`; } catch { /* sandboxed */ } }} />
          : <pre className="mail-text">{msg.text || "(empty message)"}</pre>}
      </div>
    </>
  );
}

function Compose({ draft, accounts, onClose, onSent }) {
  const [f, setF] = useState(draft);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showCc, setShowCc] = useState(!!draft.cc || !!draft.bcc);
  const fileRef = useRef(null);
  const account = accounts.find((a) => a.id === f.accountId);
  const addFiles = async (files) => {
    const list = [];
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) { setErr(`${file.name} is over 20 MB.`); continue; }
      const buf = await file.arrayBuffer();
      let bin = ""; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      list.push({ filename: file.name, contentType: file.type || "application/octet-stream", contentBase64: btoa(bin), size: file.size });
    }
    setF((d) => ({ ...d, attachments: [...d.attachments, ...list] }));
  };
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const sig = account?.signature ? `\n\n-- \n${account.signature}` : "";
      await post("/api/mail/send", { accountId: f.accountId, to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, text: f.body + sig, replyToMessageId: f.replyToMessageId, attachments: f.attachments.map(({ size, ...a }) => a) });
      onSent();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={f.mode === "new" ? "New message" : f.mode === "forward" ? "Forward" : "Reply"} onClose={onClose} wide
      footer={<><span className="tiny faint grow">{f.attachments.length ? `${f.attachments.length} attachment(s) · ${fmtSize(f.attachments.reduce((n, a) => n + a.size, 0))}` : ""}</span><Btn variant="quiet" onClick={onClose}>Discard</Btn><Btn variant="key" icon="send" onClick={send} disabled={busy || !f.to || !f.accountId}>{busy ? "Sending…" : "Send"}</Btn></>}>
      <ErrorBox error={err} />
      <div className="grid2">
        <Field label="From"><select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName} · {a.email}</option>)}</select></Field>
        <Field label="Subject"><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
      </div>
      <Field label="To" hint={!showCc ? <button className="x" style={{ fontSize: 11 }} onClick={() => setShowCc(true)}>Add Cc / Bcc</button> : undefined}><input value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="name@company.com, other@company.com" autoFocus={f.mode === "new"} /></Field>
      {showCc && <div className="grid2"><Field label="Cc"><input value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /></Field><Field label="Bcc"><input value={f.bcc} onChange={(e) => setF({ ...f, bcc: e.target.value })} /></Field></div>}
      <Field label="Message"><textarea style={{ minHeight: 220, fontFamily: "var(--sans)", fontSize: 13.5 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} autoFocus={f.mode !== "new"} /></Field>
      <div className="row-flex wrap">
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles([...e.target.files]); e.target.value = ""; }} />
        <Btn sm variant="quiet" icon="paperclip" onClick={() => fileRef.current?.click()}>Attach files</Btn>
        {f.attachments.map((a, i) => <span key={i} className="chip">{a.filename} <button className="x" style={{ fontSize: 12 }} onClick={() => setF({ ...f, attachments: f.attachments.filter((_, j) => j !== i) })} aria-label="Remove">×</button></span>)}
      </div>
      {account?.signature ? <div className="tiny faint">Signature for {account.displayName} is added automatically.</div> : null}
    </Modal>
  );
}

function ManageAccounts({ accounts, isAdmin, onClose, onEdit, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const remove = async (a) => {
    if (!(await confirm({ title: `Remove ${a.displayName}?`, text: "Roadside forgets the mailbox and its cached messages. Nothing is deleted from the mail server.", label: "Remove", tone: "danger" }))) return;
    try { await del(`/api/mail/accounts/${a.id}`); toast("Removed"); onChanged(); } catch (e) { toast(e.message, "bad"); }
  };
  return (
    <Modal title="Mailboxes" onClose={onClose} wide footer={<Btn variant="key" onClick={onClose}>Done</Btn>}>
      {accounts.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Mailbox</th><th className="hide-mobile">Type</th><th>Status</th><th className="hide-mobile">Last checked</th><th></th></tr></thead>
          <tbody>{accounts.map((a) => (
            <tr key={a.id}>
              <td><div className="n">{a.displayName}</div><div className="e">{a.email}</div></td>
              <td className="hide-mobile">{a.shared ? <Badge tone="tan">Shared{a.allowedRoles.length ? ` · ${a.allowedRoles.join(", ")}` : ""}</Badge> : <Badge tone="blue">Personal</Badge>}</td>
              <td>{a.status === "active" ? <Badge tone="ok">OK</Badge> : a.status === "error" ? <Badge tone="bad" title={a.lastError}>Error</Badge> : <Badge tone="neutral">Paused</Badge>}{a.status === "error" && <div className="tiny muted" style={{ maxWidth: 260 }}>{a.lastError}</div>}</td>
              <td className="hide-mobile tiny muted">{a.lastSyncAt ? timeAgo(a.lastSyncAt) : "never"}</td>
              <td className="right"><div className="actions" style={{ justifyContent: "flex-end" }}>{a.canManage && <><Btn sm variant="quiet" icon="pencil" onClick={() => onEdit(a)}>Edit</Btn><Btn sm variant="danger" icon="trash" aria-label="Remove" onClick={() => remove(a)} /></>}</div></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty icon="mail" title="No mailboxes connected" />}
      <p className="tiny faint">Personal mailboxes are visible only to you. {isAdmin ? "Shared inboxes are visible to the roles you choose." : "Ask an administrator to add a shared team inbox."}</p>
    </Modal>
  );
}

function AccountForm({ account, isAdmin, onClose, onDone }) {
  const editing = !!account;
  const [f, setF] = useState({
    displayName: account?.displayName ?? "", email: account?.email ?? "", username: "", password: "", provider: account?.provider ?? "gmail",
    imapHost: "", imapPort: "", imapSecure: true, smtpHost: "", smtpPort: "", smtpSecure: true,
    shared: account?.shared ?? false, allowedRoles: account?.allowedRoles ?? [], signature: account?.signature ?? "", enabled: account ? account.status !== "disabled" : true,
  });
  const [roles, setRoles] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (isAdmin) get("/api/tenant").then((t) => setRoles(t.roles)).catch(() => {}); }, [isAdmin]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { ...f, imapPort: f.imapPort || undefined, smtpPort: f.smtpPort || undefined, imapHost: f.imapHost || undefined, smtpHost: f.smtpHost || undefined, username: f.username || undefined, password: f.password || undefined };
      if (editing) await patch(`/api/mail/accounts/${account.id}`, body); else await post("/api/mail/accounts", body);
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const gmailish = f.provider === "gmail";
  return (
    <Modal title={editing ? `Edit ${account.displayName}` : "Add a mailbox"} onClose={onClose} wide footer={<><Btn variant="quiet" onClick={onClose}>Cancel</Btn><Btn variant="key" onClick={submit} disabled={busy || !f.displayName || !f.email || (!editing && !f.password)}>{busy ? "Checking sign-in…" : editing ? "Save" : "Connect"}</Btn></>}>
      <ErrorBox error={err} />
      <div className="grid3">
        <Field label="Name" hint="How it appears in the list"><input value={f.displayName} onChange={set("displayName")} placeholder="Dispatch inbox" autoFocus /></Field>
        <Field label="Email address"><input type="email" value={f.email} onChange={set("email")} placeholder="dispatch@ustowalliance.com" /></Field>
        <Field label="Provider"><select value={f.provider} onChange={set("provider")}><option value="gmail">Gmail / Google Workspace</option><option value="yahoo">Yahoo Mail</option><option value="outlook">Outlook / Microsoft 365</option><option value="imap">Other (IMAP)</option></select></Field>
      </div>
      <Field label={editing ? "New app password (leave blank to keep)" : "App password"} hint={gmailish ? <>Not your normal password. In the Google account: Security → 2-Step Verification → App passwords → create one for "Roadside". Paste the 16 characters here.</> : f.provider === "yahoo" ? <>Not your normal password. Yahoo: Account Info → Security → Generate app password → name it "Roadside". Paste it here.</> : "Use an app password if your provider offers one."}>
        <input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" placeholder={editing ? "••••••••••••••••" : "xxxx xxxx xxxx xxxx"} />
      </Field>
      {f.provider === "imap" && (
        <>
          <div className="grid3">
            <Field label="IMAP server"><input value={f.imapHost} onChange={set("imapHost")} placeholder="imap.example.com" /></Field>
            <Field label="IMAP port"><input value={f.imapPort} onChange={set("imapPort")} placeholder="993" /></Field>
            <Field label="Username"><input value={f.username} onChange={set("username")} placeholder="defaults to the email" /></Field>
          </div>
          <div className="grid3">
            <Field label="SMTP server"><input value={f.smtpHost} onChange={set("smtpHost")} placeholder="smtp.example.com" /></Field>
            <Field label="SMTP port"><input value={f.smtpPort} onChange={set("smtpPort")} placeholder="465" /></Field>
            <Field label="SMTP TLS"><label className="check" style={{ height: 34 }}><input type="checkbox" checked={f.smtpSecure} onChange={set("smtpSecure")} />Implicit TLS (port 465)</label></Field>
          </div>
        </>
      )}
      <Field label="Signature" hint="Added to the end of messages sent from this mailbox."><textarea style={{ minHeight: 60 }} value={f.signature} onChange={set("signature")} placeholder={"Chris Peer\nRoadside Towing · 740-812-9489"} /></Field>
      {isAdmin && (
        <>
          <label className="check"><input type="checkbox" checked={f.shared} disabled={editing} onChange={set("shared")} />Shared team inbox (visible to other people in this organization)</label>
          {f.shared && <Field label="Who can see it" hint="Leave empty for everyone in the organization."><Picker options={roles} value={f.allowedRoles} onChange={(v) => setF({ ...f, allowedRoles: v })} /></Field>}
        </>
      )}
      {editing && <label className="check"><input type="checkbox" checked={f.enabled} onChange={set("enabled")} />Keep this mailbox syncing</label>}
    </Modal>
  );
}
