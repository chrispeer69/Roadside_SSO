import { useEffect, useState } from "react";
import { get, patch, del } from "../api.js";
import { useMe } from "../App.jsx";
import { Btn, Badge, Field, Icon, Panel, Empty, Picker, ListInput, PageHead, Tabs, ErrorBox, fmtDate, timeAgo, uaShort, eventLabel, useToast, useConfirm } from "../components/ui.jsx";

export default function Security() {
  const [tab, setTab] = useState("policy");
  return (
    <>
      <PageHead title="Security" sub="These settings apply to every app on this organization's dashboard." />
      <Tabs tabs={[{ id: "policy", label: "Policy" }, { id: "sessions", label: "Active sessions" }, { id: "audit", label: "Audit log" }]} active={tab} onChange={setTab} />
      {tab === "policy" && <Policy />}
      {tab === "sessions" && <Sessions />}
      {tab === "audit" && <Audit />}
    </>
  );
}

function Policy() {
  const { me, reload } = useMe();
  const [info, setInfo] = useState(null);
  const [s, setS] = useState(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { get("/api/tenant").then((i) => { setInfo(i); setName(i.tenant.name); setS({ mfaRequiredRoles: [], sessionHours: 720, allowedEmailDomains: [], customRoles: [], quickLinks: [], welcome: "", supportPhone: "", supportEmail: "", ...i.tenant.settings }); }).catch(setErr); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!s) return <div className="muted">Loading…</div>;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await patch("/api/tenant", { name, settings: s }); toast("Settings saved"); await reload(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const setLink = (i, k, v) => setS({ ...s, quickLinks: s.quickLinks.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });

  return (
    <div className="cols-eq">
      <div className="stack">
        <Panel title="Sign-in policy" pad>
          <div className="stack">
            <ErrorBox error={err} />
            <Field label="Organization name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Two-step sign-in required for" hint="People with these roles must enroll an authenticator app. Others may enroll voluntarily.">
              <Picker options={info.roles} value={s.mfaRequiredRoles} onChange={(v) => setS({ ...s, mfaRequiredRoles: v })} />
            </Field>
            <Field label="Stay signed in for (hours)" hint="Sessions on trusted devices last this long. 720 = 30 days. Signing out ends every app at once.">
              <input type="number" min={1} max={2160} value={s.sessionHours} onChange={(e) => setS({ ...s, sessionHours: e.target.value })} />
            </Field>
            <Field label="Allowed email domains" hint="Optional. New people must have an email on one of these domains."><ListInput value={s.allowedEmailDomains} onChange={(v) => setS({ ...s, allowedEmailDomains: v })} placeholder="ustowalliance.com, roadsidetow.com" /></Field>
            <Field label="Extra roles" hint="Add roles beyond the standard set (owner, admin, manager, dispatcher, driver, technician, estimator, bookkeeper, sales, office)."><ListInput value={s.customRoles} onChange={(v) => setS({ ...s, customRoles: v })} placeholder="lot-attendant, night-dispatch" /></Field>
          </div>
        </Panel>
        <Panel title="Password rules" pad>
          <div className="sec-item" style={{ padding: 0 }}><Icon name="key" /><div><div className="n">Minimum 10 characters with letters and numbers</div><div className="d">Accounts lock for 15 minutes after 10 failed attempts. Administrators can issue a temporary password or reset link at any time.</div></div><div className="st"><Badge tone="ok">Enforced</Badge></div></div>
        </Panel>
      </div>
      <div className="stack">
        <Panel title="Dashboard extras" pad>
          <div className="stack">
            <Field label="Welcome message" hint="Shown at the top of everyone's dashboard."><input value={s.welcome} onChange={(e) => setS({ ...s, welcome: e.target.value })} placeholder="e.g. Safety meeting Friday 7am at the Denver yard" /></Field>
            <div className="grid2">
              <Field label="Support phone"><input value={s.supportPhone} onChange={(e) => setS({ ...s, supportPhone: e.target.value })} /></Field>
              <Field label="Support email"><input value={s.supportEmail} onChange={(e) => setS({ ...s, supportEmail: e.target.value })} /></Field>
            </div>
            <Field label="Quick links" hint="Plain links that appear beside the tiles (no sign-in needed).">
              <div className="stack" style={{ gap: 6 }}>
                {s.quickLinks.map((l, i) => (
                  <div className="row-flex" key={i}>
                    <input className="input" style={{ flex: 1 }} placeholder="Label" value={l.label} onChange={(e) => setLink(i, "label", e.target.value)} />
                    <input className="input" style={{ flex: 2 }} placeholder="https://" value={l.url} onChange={(e) => setLink(i, "url", e.target.value)} />
                    <Btn sm variant="quiet" icon="x" aria-label="Remove link" onClick={() => setS({ ...s, quickLinks: s.quickLinks.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                {s.quickLinks.length < 12 && <Btn sm variant="quiet" icon="plus" onClick={() => setS({ ...s, quickLinks: [...s.quickLinks, { label: "", url: "" }] })}>Add link</Btn>}
              </div>
            </Field>
          </div>
        </Panel>
        <div className="form-actions"><Btn variant="key" onClick={save} disabled={busy} icon="device-floppy">Save settings</Btn></div>
      </div>
    </div>
  );
}

function Sessions() {
  const [list, setList] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => get("/api/tenant/sessions").then(setList).catch((e) => toast(e.message, "bad"));
  useEffect(() => { load(); }, []);
  const end = async (s) => {
    if (!(await confirm({ title: `Sign out ${s.name} on ${uaShort(s.user_agent)}?`, text: "The device is signed out of the dashboard and every connected app.", label: "Sign out" }))) return;
    await del(`/api/tenant/sessions/${s.id}`); toast("Session ended"); load();
  };
  return (
    <Panel title="Devices signed in" actions={<span className="tiny faint">{list?.length ?? 0} sessions</span>}>
      {!list ? <div className="pb muted">Loading…</div> : !list.length ? <Empty icon="device-desktop" title="No active sessions" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Person</th><th>Device</th><th className="hide-mobile">Address</th><th className="hide-mobile">Signed in</th><th>Last seen</th><th></th></tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s.id}>
              <td><div className="n">{s.name}{s.current && <Badge tone="blue"> this device</Badge>}</div><div className="e">{s.email}</div></td>
              <td>{uaShort(s.user_agent)}{!s.mfa_passed && <Badge tone="warn"> awaiting code</Badge>}</td>
              <td className="hide-mobile mono tiny muted">{s.ip ?? "—"}</td>
              <td className="hide-mobile tiny muted">{fmtDate(s.created_at)}</td>
              <td className="tiny muted">{timeAgo(s.last_seen_at)}</td>
              <td className="right">{!s.current && <Btn sm variant="danger" onClick={() => end(s)}>Sign out</Btn>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Panel>
  );
}

function Audit() {
  const [list, setList] = useState(null);
  const [filter, setFilter] = useState("all");
  useEffect(() => { get("/api/tenant/audit?limit=300").then(setList).catch(() => setList([])); }, []);
  const groups = { all: () => true, signin: (e) => /^(login|logout|mfa)/.test(e), apps: (e) => /^app\./.test(e), admin: (e) => /^(person|tenant|session|password|user)\./.test(e) };
  const shown = (list ?? []).filter((a) => groups[filter](a.event));
  return (
    <>
      <div className="row-flex mb"><div className="filters">{[["all", "All"], ["signin", "Sign-ins"], ["apps", "App launches"], ["admin", "Admin changes"]].map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}</div><span className="tiny faint">{shown.length} events</span></div>
      <Panel>
        {!list ? <div className="pb muted">Loading…</div> : !shown.length ? <Empty icon="history" title="No events" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Event</th><th>Person</th><th className="hide-mobile">Detail</th><th className="hide-mobile">By</th><th className="hide-mobile">Address</th></tr></thead>
            <tbody>{shown.map((a) => (
              <tr key={a.id}>
                <td className="mono tiny muted nowrap">{fmtDate(a.at)}</td>
                <td><Badge tone={/failed|denied/.test(a.event) ? "bad" : /removed|revoked|disabled/.test(a.event) ? "warn" : "neutral"}>{eventLabel(a.event)}</Badge></td>
                <td>{a.user_name ?? a.target ?? "—"}</td>
                <td className="hide-mobile tiny muted">{a.target && a.user_name ? a.target : ""}{a.detail && Object.keys(a.detail).length ? " " + Object.entries(a.detail).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : v}`).join(" · ") : ""}</td>
                <td className="hide-mobile tiny muted">{a.actor_name ?? ""}</td>
                <td className="hide-mobile mono tiny muted">{a.ip ?? ""}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
