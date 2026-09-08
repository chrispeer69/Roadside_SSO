import { useEffect, useMemo, useState } from "react";
import { get, post, patch, del } from "../api.js";
import { useMe } from "../App.jsx";
import { Btn, Badge, Field, Icon, Modal, Panel, Empty, Picker, ListInput, CopyBox, PageHead, ErrorBox, Chips, timeAgo, useToast, useConfirm } from "../components/ui.jsx";

export default function People() {
  const { me } = useMe();
  const [people, setPeople] = useState(null);
  const [info, setInfo] = useState(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [secret, setSecret] = useState(null); // { title, label, value, note }
  const [pwFor, setPwFor] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();

  const load = () => Promise.all([get("/api/tenant/people"), get("/api/tenant")]).then(([p, i]) => { setPeople(p); setInfo(i); });
  useEffect(() => { load().catch((e) => toast(e.message, "bad")); }, []);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (people ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.email.includes(s) || p.roles.join(" ").includes(s) || p.locations.join(" ").includes(s));
  }, [people, q]);

  const act = async (p, kind) => {
    try {
      if (kind === "temp") {
        if (!(await confirm({ title: `Issue a temporary password for ${p.name}?`, text: "Their current password stops working and every device is signed out. Give them the new password in person or by text.", label: "Issue password" }))) return;
        const r = await post(`/api/tenant/people/${p.id}/temp-password`);
        setSecret({ title: me.tenant?.pinMode ? "Temporary PIN" : "Temporary password", label: `${p.name} · one-time`, value: r.tempPassword, note: `They will be asked to choose a new ${me.tenant?.pinMode ? "PIN" : "password"} at sign-in.` });
      } else if (kind === "setpw") {
        setPwFor(p); return;
      } else if (kind === "link") {
        const r = await post(`/api/tenant/people/${p.id}/reset-link`);
        setSecret({ title: "Password reset link", label: `${p.name} · valid 24 hours`, value: r.url, note: "Send this link by text or email. It works once." });
      } else if (kind === "mfa") {
        if (!(await confirm({ title: `Reset two-step sign-in for ${p.name}?`, text: "Use this when they lost their phone. They can enroll again from their account page.", label: "Reset" }))) return;
        await post(`/api/tenant/people/${p.id}/mfa-reset`); toast("Two-step sign-in reset");
      } else if (kind === "remove") {
        if (!(await confirm({ title: `Remove ${p.name} from ${me.tenant.name}?`, text: "They lose access to every app on this dashboard immediately. Their sign-in still exists for other organizations they belong to.", label: "Remove", tone: "danger" }))) return;
        await del(`/api/tenant/people/${p.id}`); toast("Removed");
      } else if (kind === "toggle") {
        await patch(`/api/tenant/people/${p.id}`, { status: p.status === "active" ? "disabled" : "active" });
        toast(p.status === "active" ? "Access paused" : "Access restored");
      }
      await load();
    } catch (e) { toast(e.message, "bad"); }
  };

  return (
    <>
      <PageHead title="People" sub="Add someone once. They get every app their role allows, on desktop and mobile."
        actions={<Btn variant="key" icon="user-plus" onClick={() => setAdding(true)}>Add person</Btn>} />

      {info && (
        <div className="kpis mb">
          <div className="kpi"><div className="l">People</div><div className="v">{info.stats.people}</div><div className="s">active in {info.tenant.name}</div></div>
          <div className="kpi"><div className="l">Signed in today</div><div className="v">{info.stats.logins24h}</div><div className="s">last 24 hours</div></div>
          <div className="kpi"><div className="l">Without two-step</div><div className="v">{info.stats.nomfa}</div><div className="s">people not yet enrolled</div></div>
          <div className="kpi"><div className="l">Active sessions</div><div className="v">{info.stats.sessions}</div><div className="s">devices signed in</div></div>
        </div>
      )}

      <div className="row-flex mb"><label className="search"><Icon name="search" /><input placeholder="Search name, email, role, location" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>

      <Panel>
        {!people ? <div className="pb muted">Loading…</div> : !shown.length ? <Empty icon="users" title={q ? "No matches" : "No people yet"} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Person</th><th>Roles</th><th className="hide-mobile">Locations</th><th className="hide-mobile">Two-step</th><th className="hide-mobile">Last sign-in</th><th></th></tr></thead>
            <tbody>{shown.map((p) => (
              <tr key={p.id} style={{ opacity: p.status === "active" ? 1 : 0.6 }}>
                <td><div className="n">{p.name}{p.status !== "active" && <Badge tone="bad"> paused</Badge>}{p.must_change_password && <Badge tone="warn"> temp password</Badge>}</div><div className="e">{p.email}{p.title ? ` · ${p.title}` : ""}</div></td>
                <td><Chips items={p.roles} /></td>
                <td className="hide-mobile"><Chips items={p.locations} /></td>
                <td className="hide-mobile">{p.mfa_enabled ? <Badge tone="ok">On</Badge> : <Badge tone="warn">Off</Badge>}</td>
                <td className="hide-mobile mono tiny muted">{timeAgo(p.last_login_at)}</td>
                <td className="right"><RowMenu p={p} self={p.id === me.user.id} onEdit={() => setEditing(p)} onAct={(k) => act(p, k)} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>

      <section className="section">
        <div className="section-head"><h2>Role guide</h2></div>
        <Panel pad>
          <p className="small muted">Roles decide which tiles a person sees. <b>owner</b> and <b>admin</b> manage people, tiles and security. Set which roles can open each app under <b>Apps</b>. Per-person exceptions live in the person's settings.</p>
        </Panel>
      </section>

      {adding && <PersonForm roles={info?.roles ?? []} onClose={() => setAdding(false)} onDone={async (r) => { setAdding(false); await load(); if (r.tempPassword) setSecret({ title: "Temporary password", label: `${r.email} · one-time`, value: r.tempPassword, note: "Give this to them in person or by text. They will set their own password at first sign-in." }); else toast("Added existing sign-in to this organization"); }} />}
      {editing && <PersonForm person={editing} roles={info?.roles ?? []} apps={me.apps} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await load(); toast("Saved"); }} />}
      {pwFor && <SetPasswordModal person={pwFor} pin={!!me.tenant?.pinMode} onClose={() => setPwFor(null)} onDone={() => { setPwFor(null); toast(`Password set for ${pwFor.name}`); load(); }} />}
      {secret && (
        <Modal title={secret.title} onClose={() => setSecret(null)} footer={<Btn variant="key" onClick={() => setSecret(null)}>Done</Btn>}>
          <CopyBox label={secret.label} value={secret.value} />
          <p className="small muted">{secret.note} This is shown once.</p>
        </Modal>
      )}
    </>
  );
}

function RowMenu({ p, self, onEdit, onAct }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="usermenu" style={{ display: "inline-block" }}>
      <div className="actions" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
        <Btn sm variant="quiet" icon="pencil" onClick={onEdit}>Edit</Btn>
        <Btn sm variant="quiet" icon="dots" aria-label="More actions" onClick={() => setOpen((o) => !o)} />
      </div>
      {open && (
        <div className="menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => { setOpen(false); onAct("setpw"); }}><Icon name="password" />Set password</button>
          <button onClick={() => { setOpen(false); onAct("temp"); }}><Icon name="key" />Temporary password / PIN</button>
          <button onClick={() => { setOpen(false); onAct("link"); }}><Icon name="link" />Password reset link</button>
          <button onClick={() => { setOpen(false); onAct("mfa"); }} disabled={!p.mfa_enabled}><Icon name="shield-off" />Reset two-step</button>
          {!self && <button onClick={() => { setOpen(false); onAct("toggle"); }}><Icon name={p.status === "active" ? "player-pause" : "player-play"} />{p.status === "active" ? "Pause access" : "Restore access"}</button>}
          {!self && <button onClick={() => { setOpen(false); onAct("remove"); }} style={{ color: "var(--bad)" }}><Icon name="user-minus" />Remove from organization</button>}
        </div>
      )}
    </div>
  );
}

function PersonForm({ person, roles, apps = [], onClose, onDone }) {
  const editing = !!person;
  const [f, setF] = useState({
    email: person?.email ?? "", name: person?.name ?? "", phone: person?.phone ?? "", title: person?.title ?? "",
    roles: person?.roles ?? ["driver"], locations: person?.locations ?? [], appOverrides: person?.app_overrides ?? {},
  });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (editing) { await patch(`/api/tenant/people/${person.id}`, { name: f.name, email: f.email, phone: f.phone, title: f.title, roles: f.roles, locations: f.locations, appOverrides: f.appOverrides }); onDone({}); }
      else { const r = await post("/api/tenant/people", f); onDone(r); }
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  const setOv = (id, v) => { const o = { ...f.appOverrides }; if (v) o[id] = v; else delete o[id]; setF({ ...f, appOverrides: o }); };
  return (
    <Modal title={editing ? `Edit ${person.name}` : "Add a person"} onClose={onClose} wide
      footer={<><Btn variant="quiet" onClick={onClose}>Cancel</Btn><Btn variant="key" onClick={submit} disabled={busy}>{editing ? "Save" : "Add person"}</Btn></>}>
      <form onSubmit={submit} className="stack">
        <ErrorBox error={err} />
        <div className="grid2">
          <Field label="Full name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Work email" hint={editing ? "This is their sign-in. Changing it applies everywhere immediately." : "If this email already has a Roadside sign-in, it is added to this organization with the same password."}><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <div className="grid2">
          <Field label="Mobile phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="optional" /></Field>
          <Field label="Job title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="optional" /></Field>
        </div>
        <Field label="Roles" hint="Roles decide which tiles they see."><Picker options={roles} value={f.roles} onChange={(v) => setF({ ...f, roles: v })} /></Field>
        <Field label="Locations" hint="Comma separated, e.g. denver, aurora"><ListInput value={f.locations} onChange={(v) => setF({ ...f, locations: v })} placeholder="denver, aurora" /></Field>
        {editing && apps.length > 0 && (
          <Field label="App exceptions" hint="Override the role rule for this person only.">
            <div className="table-wrap"><table>
              <tbody>{apps.map((a) => (
                <tr key={a.id}><td><span className="n">{a.name}</span></td><td className="right">
                  <div className="filters">
                    {[["", "By role"], ["allow", "Always allow"], ["deny", "Block"]].map(([v, l]) => <button type="button" key={v} aria-pressed={(f.appOverrides[a.id] ?? "") === v} onClick={() => setOv(a.id, v)}>{l}</button>)}
                  </div>
                </td></tr>
              ))}</tbody>
            </table></div>
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function SetPasswordModal({ person, pin, onClose, onDone }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [mustChange, setMustChange] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr(null);
    if (pw !== pw2) return setErr("The passwords do not match.");
    setBusy(true);
    try { await post(`/api/tenant/people/${person.id}/password`, { password: pw, mustChange }); onDone(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={`Set ${pin ? "PIN" : "password"} for ${person.name}`} onClose={onClose} footer={<><Btn variant="quiet" onClick={onClose}>Cancel</Btn><Btn variant="key" onClick={save} disabled={busy || (pin ? pw.length !== 4 : pw.length < 10)}>Set {pin ? "PIN" : "password"}</Btn></>}>
      <ErrorBox error={err} />
      <p className="small muted">{pin ? "Exactly 4 digits. Avoid obvious ones like 1234 or 0000." : "At least 10 characters with letters and numbers."} Their other devices are signed out when it changes.</p>
      <div className="grid2">
        <Field label={pin ? "New PIN" : "New password"}><input type="password" inputMode={pin ? "numeric" : undefined} maxLength={pin ? 4 : undefined} autoComplete="new-password" value={pw} onChange={(e) => setPw(pin ? e.target.value.replace(/\D/g, "") : e.target.value)} autoFocus /></Field>
        <Field label="Confirm"><input type="password" inputMode={pin ? "numeric" : undefined} maxLength={pin ? 4 : undefined} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(pin ? e.target.value.replace(/\D/g, "") : e.target.value)} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />Ask them to choose their own {pin ? "PIN" : "password"} at next sign-in</label>
    </Modal>
  );
}
