import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { get, post, patch, del } from "../api.js";
import { useMe } from "../App.jsx";
import { Btn, Badge, Field, Icon, Modal, Panel, Empty, CopyBox, PageHead, ErrorBox, fmtDate, timeAgo, uaShort, eventLabel, useToast, useConfirm } from "../components/ui.jsx";

export default function Account() {
  const { me, reload } = useMe();
  return (
    <>
      <PageHead title="My account" sub={me.user.email} />
      <div className="cols-eq">
        <div className="stack">
          <Profile />
          <Password />
        </div>
        <div className="stack">
          <TwoStep />
          <MySessions />
        </div>
      </div>
      <section className="section"><Activity /></section>
    </>
  );
}

function Profile() {
  const { me, reload } = useMe();
  const [name, setName] = useState(me.user.name);
  const [phone, setPhone] = useState(me.user.phone ?? "");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async () => { setBusy(true); try { await patch("/api/me", { name, phone }); toast("Profile saved"); await reload(); } catch (e) { toast(e.message, "bad"); } finally { setBusy(false); } };
  return (
    <Panel title="Profile" pad>
      <div className="stack">
        <div className="grid2">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Mobile phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="optional" /></Field>
        </div>
        <Field label="Email" hint="Ask an administrator to change your email."><input value={me.user.email} disabled /></Field>
        <div className="form-actions"><Btn onClick={save} disabled={busy}>Save</Btn></div>
      </div>
    </Panel>
  );
}

function Password() {
  const [f, setF] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async () => {
    setErr(null);
    if (f.newPassword !== f.confirm) return setErr("New passwords do not match.");
    setBusy(true);
    try { await post("/api/auth/password", f); toast("Password changed. Other devices were signed out."); setF({ currentPassword: "", newPassword: "", confirm: "" }); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Panel title="Password" pad>
      <div className="stack">
        <ErrorBox error={err} />
        <Field label="Current password"><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="New password" hint="10+ characters, letters and numbers"><input type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
          <Field label="Confirm"><input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
        </div>
        <div className="form-actions"><Btn onClick={save} disabled={busy || !f.currentPassword || !f.newPassword}>Change password</Btn></div>
      </div>
    </Panel>
  );
}

function TwoStep() {
  const { me, reload } = useMe();
  const [setup, setSetup] = useState(null); // { secret, otpauthUrl, qr }
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [err, setErr] = useState(null);
  const toast = useToast();
  const start = async () => {
    setErr(null);
    const r = await post("/api/auth/mfa/setup");
    const qr = await QRCode.toDataURL(r.otpauthUrl, { margin: 0, width: 320, color: { dark: "#0f2f5f", light: "#ffffff" } });
    setSetup({ ...r, qr });
  };
  const enable = async () => { setErr(null); try { await post("/api/auth/mfa/enable", { code }); toast("Two-step sign-in is on"); setSetup(null); setCode(""); await reload(); } catch (e) { setErr(e.message); } };
  const disable = async () => { setErr(null); try { await post("/api/auth/mfa/disable", { password: pw }); toast("Two-step sign-in turned off"); setDisabling(false); setPw(""); await reload(); } catch (e) { setErr(e.message); } };
  return (
    <Panel title="Two-step sign-in" actions={me.user.mfaEnabled ? <Badge tone="ok">On</Badge> : <Badge tone="warn">Off</Badge>} pad>
      <p className="small muted">A 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password) is required at sign-in. {me.mfaPolicy && <b style={{ color: "var(--warn)" }}>Your role requires this.</b>}</p>
      <div className="mt">
        {me.user.mfaEnabled
          ? <Btn variant="quiet" icon="shield-off" onClick={() => setDisabling(true)}>Turn off</Btn>
          : <Btn variant="key" icon="shield-lock" onClick={start}>Set up two-step sign-in</Btn>}
      </div>
      {setup && (
        <Modal title="Set up two-step sign-in" onClose={() => setSetup(null)} footer={<><Btn variant="quiet" onClick={() => setSetup(null)}>Cancel</Btn><Btn variant="key" onClick={enable} disabled={code.length !== 6}>Turn on</Btn></>}>
          <ErrorBox error={err} />
          <div className="row-flex" style={{ alignItems: "flex-start", gap: 16 }}>
            <img className="qr" src={setup.qr} alt="QR code for authenticator app" />
            <div className="stack small" style={{ gap: 8 }}>
              <div><b>1.</b> Open your authenticator app and scan this code.</div>
              <div><b>2.</b> Enter the 6-digit code it shows to confirm.</div>
              <div className="faint">Can't scan? Enter this key by hand:</div>
              <CopyBox value={setup.secret} />
            </div>
          </div>
          <Field label="Code from the app"><div className="codebox"><input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus /></div></Field>
        </Modal>
      )}
      {disabling && (
        <Modal title="Turn off two-step sign-in" onClose={() => setDisabling(false)} footer={<><Btn variant="quiet" onClick={() => setDisabling(false)}>Cancel</Btn><Btn variant="danger" onClick={disable} disabled={!pw}>Turn off</Btn></>}>
          <ErrorBox error={err} />
          <p className="small muted">Confirm with your password. If your role requires two-step sign-in you will be asked to enroll again.</p>
          <Field label="Password"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
        </Modal>
      )}
    </Panel>
  );
}

function MySessions() {
  const [list, setList] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => get("/api/me/sessions").then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const end = async (s) => {
    if (!(await confirm({ title: "Sign out that device?", text: uaShort(s.user_agent), label: "Sign out" }))) return;
    await del(`/api/me/sessions/${s.id}`); toast("Device signed out"); load();
  };
  return (
    <Panel title="My devices">
      {!list ? <div className="pb muted">Loading…</div> : list.map((s) => (
        <div className="row" key={s.id}>
          <Icon name={/iOS|Android/.test(uaShort(s.user_agent)) ? "device-mobile" : "device-desktop"} style={{ color: "var(--ink-3)" }} />
          <div className="grow"><div>{uaShort(s.user_agent)} {s.current && <Badge tone="blue">this device</Badge>}</div><div className="tiny faint">{s.ip ?? ""} · signed in {fmtDate(s.created_at)} · active {timeAgo(s.last_seen_at)}</div></div>
          {!s.current && <Btn sm variant="quiet" onClick={() => end(s)}>Sign out</Btn>}
        </div>
      ))}
    </Panel>
  );
}

function Activity() {
  const [list, setList] = useState(null);
  useEffect(() => { get("/api/me/activity").then(setList).catch(() => setList([])); }, []);
  return (
    <Panel title="My sign-in history">
      {!list ? <div className="pb muted">Loading…</div> : !list.length ? <Empty icon="history" title="No activity yet" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Event</th><th className="hide-mobile">Organization</th><th className="hide-mobile">Detail</th><th className="hide-mobile">Address</th></tr></thead>
          <tbody>{list.map((a, i) => (
            <tr key={i}><td className="mono tiny muted nowrap">{fmtDate(a.at)}</td><td>{eventLabel(a.event)}</td><td className="hide-mobile muted">{a.tenant_name ?? ""}</td><td className="hide-mobile tiny muted">{a.target ?? ""}</td><td className="hide-mobile mono tiny muted">{a.ip ?? ""}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </Panel>
  );
}
