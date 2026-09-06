// Platform administration: every organization, the app catalog (OIDC clients), and every sign-in.
import { useEffect, useState } from "react";
import { get, post, patch, del } from "../api.js";
import { useMe } from "../App.jsx";
import { navigate } from "../router.jsx";
import { Btn, Badge, Field, Icon, Modal, Panel, Empty, CopyBox, PageHead, Tabs, ErrorBox, fmtDate, fmtDay, timeAgo, eventLabel, useToast, useConfirm } from "../components/ui.jsx";

export default function Platform() {
  const [tab, setTab] = useState("overview");
  return (
    <>
      <PageHead title="Platform" sub="Roadside SSO across every organization you host." />
      <Tabs tabs={[{ id: "overview", label: "Overview" }, { id: "tenants", label: "Organizations" }, { id: "catalog", label: "App catalog" }, { id: "users", label: "All sign-ins" }]} active={tab} onChange={setTab} />
      {tab === "overview" && <Overview />}
      {tab === "tenants" && <Tenants />}
      {tab === "catalog" && <Catalog />}
      {tab === "users" && <Users />}
    </>
  );
}

function Overview() {
  const [d, setD] = useState(null);
  useEffect(() => { get("/api/platform/overview").then(setD).catch(() => {}); }, []);
  if (!d) return <div className="muted">Loading…</div>;
  const s = d.stats;
  return (
    <>
      <div className="kpis mb">
        <div className="kpi"><div className="l">Organizations</div><div className="v">{s.tenants}</div><div className="s">active tenants</div></div>
        <div className="kpi"><div className="l">People</div><div className="v">{s.users}</div><div className="s">{s.sessions} devices signed in</div></div>
        <div className="kpi"><div className="l">Sign-ins · 24h</div><div className="v">{s.logins24h}</div><div className="s">{s.failed24h} failed</div></div>
        <div className="kpi"><div className="l">App launches · 24h</div><div className="v">{s.launches24h}</div><div className="s">{s.apps} apps in catalog</div></div>
      </div>
      <Panel title="Latest events">
        {d.recent.map((a, i) => (
          <div className="row" key={i}><span className="src">{a.event.split(".")[0]}</span><span>{eventLabel(a.event)}{a.user_name ? ` · ${a.user_name}` : a.target ? ` · ${a.target}` : ""}</span><span className="muted tiny">{a.tenant_name ?? ""}</span><span className="t">{timeAgo(a.at)}</span></div>
        ))}
      </Panel>
    </>
  );
}

function Tenants() {
  const { switchTenant } = useMe();
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => get("/api/platform/tenants").then(setList).catch((e) => toast(e.message, "bad"));
  useEffect(() => { load(); }, []);
  const open = async (t, to) => { await switchTenant(t.id); navigate(to); };
  const suspend = async (t) => {
    const susp = t.status === "active";
    if (susp && !(await confirm({ title: `Suspend ${t.name}?`, text: "Everyone in the organization is signed out and cannot sign in until it is restored.", label: "Suspend", tone: "danger" }))) return;
    await patch(`/api/platform/tenants/${t.id}`, { status: susp ? "suspended" : "active" }); toast(susp ? "Suspended" : "Restored"); load();
  };
  return (
    <>
      <div className="section-head"><h2>Organizations</h2><Btn variant="key" icon="plus" onClick={() => setCreating(true)}>New organization</Btn></div>
      <Panel>
        {!list ? <div className="pb muted">Loading…</div> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Organization</th><th>People</th><th>Apps</th><th className="hide-mobile">Created</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((t) => (
              <tr key={t.id}>
                <td><div className="n">{t.name}</div><div className="e mono">{t.slug}</div></td>
                <td className="mono">{t.people}</td><td className="mono">{t.apps}</td>
                <td className="hide-mobile tiny muted">{fmtDay(t.created_at)}</td>
                <td>{t.status === "active" ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Suspended</Badge>}</td>
                <td className="right"><div className="actions" style={{ justifyContent: "flex-end" }}>
                  <Btn sm variant="quiet" icon="users" onClick={() => open(t, "/people")}>People</Btn>
                  <Btn sm variant="quiet" icon="apps" onClick={() => open(t, "/apps")}>Tiles</Btn>
                  <Btn sm variant="quiet" icon="shield-check" onClick={() => open(t, "/security")}>Security</Btn>
                  <Btn sm variant={t.status === "active" ? "danger" : "quiet"} onClick={() => suspend(t)}>{t.status === "active" ? "Suspend" : "Restore"}</Btn>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
      <p className="tiny faint mt">Opening People, Tiles or Security switches your active organization to that tenant. Switch back with the organization menu at the top.</p>
      {creating && <NewTenant onClose={() => setCreating(false)} onDone={(r) => { setCreating(false); setResult(r); load(); }} />}
      {result && (
        <Modal title={`${result.tenant.name} created`} onClose={() => setResult(null)} footer={<Btn variant="key" onClick={() => setResult(null)}>Done</Btn>}>
          {result.owner?.tempPassword ? <><CopyBox label={`Owner ${result.owner.email} · temporary password`} value={result.owner.tempPassword} /><p className="small muted">Shown once. They set their own password at first sign-in.</p></> : <p className="small muted">{result.owner ? "The owner already had a Roadside sign-in and was added." : "No owner added yet. Open People to add one."}</p>}
        </Modal>
      )}
    </>
  );
}

function NewTenant({ onClose, onDone }) {
  const [apps, setApps] = useState([]);
  const [f, setF] = useState({ name: "", slug: "", ownerEmail: "", ownerName: "", appIds: [] });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get("/api/platform/apps").then((l) => { setApps(l.filter((a) => a.status === "active")); }); }, []);
  const submit = async () => { setBusy(true); setErr(null); try { onDone(await post("/api/platform/tenants", f)); } catch (e) { setErr(e.message); setBusy(false); } };
  const toggleApp = (id) => setF({ ...f, appIds: f.appIds.includes(id) ? f.appIds.filter((x) => x !== id) : [...f.appIds, id] });
  return (
    <Modal title="New organization" onClose={onClose} footer={<><Btn variant="quiet" onClick={onClose}>Cancel</Btn><Btn variant="key" onClick={submit} disabled={busy || !f.name}>Create</Btn></>}>
      <ErrorBox error={err} />
      <div className="grid2">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || "" })} placeholder="Ridgeline Towing" autoFocus /></Field>
        <Field label="Slug" hint="Short id, letters and dashes"><input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} placeholder="ridgeline" /></Field>
      </div>
      <div className="grid2">
        <Field label="Owner email" hint="Optional. Gets a temporary password."><input type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
        <Field label="Owner name"><input value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
      </div>
      <Field label="Apps on their dashboard">
        <div className="chips">{apps.map((a) => <span key={a.id} className={`chip pick ${f.appIds.includes(a.id) ? "on" : "off"}`} onClick={() => toggleApp(a.id)}>{a.name}</span>)}</div>
      </Field>
    </Modal>
  );
}

// ---------- Catalog ----------
const EMPTY_APP = { id: "", name: "", category: "Operations", description: "", icon: "apps", base_url: "", launch_url: "", initiate_login_uri: "", redirect_uris: "", post_logout_uris: "", backchannel_logout_uri: "", client_type: "confidential", owner: "internal", visibility: "catalog", mobile: true, status: "active", sort: 100 };

function Catalog() {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const [secret, setSecret] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => get("/api/platform/apps").then(setList).catch((e) => toast(e.message, "bad"));
  useEffect(() => { load(); }, []);
  const issuer = window.location.origin;
  const rotate = async (a) => {
    if (!(await confirm({ title: `New client secret for ${a.name}?`, text: "The old secret stops working immediately. Update the website's configuration with the new one.", label: "Rotate secret" }))) return;
    const r = await post(`/api/platform/apps/${a.id}/secret`); setSecret({ app: a, secret: r.clientSecret });
  };
  const remove = async (a) => {
    if (!(await confirm({ title: `Delete ${a.name} from the catalog?`, text: `It is removed from ${a.tenants} organization dashboard(s). This cannot be undone.`, label: "Delete", tone: "danger" }))) return;
    await del(`/api/platform/apps/${a.id}`); toast("Deleted"); load();
  };
  return (
    <>
      <div className="section-head"><h2>App catalog</h2><Btn variant="key" icon="plus" onClick={() => setEdit({ ...EMPTY_APP })}>Register app</Btn></div>
      <Panel>
        {!list ? <div className="pb muted">Loading…</div> : (
          <div className="table-wrap"><table>
            <thead><tr><th>App</th><th className="hide-mobile">Sign-in</th><th className="hide-mobile">Visibility</th><th>Orgs</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((a) => (
              <tr key={a.id}>
                <td><div className="row-flex"><Icon name={a.icon || "apps"} style={{ color: "var(--blue)", fontSize: 16 }} /><div><div className="n">{a.name}</div><div className="e mono">{a.id} · {a.base_url || "no address"}</div></div></div></td>
                <td className="hide-mobile">{a.owner === "internal" ? <>{a.client_type === "public" ? <Badge tone="blue">OIDC public</Badge> : <Badge tone="blue">OIDC {a.has_secret ? "secret set" : "no secret yet"}</Badge>}</> : <Badge tone="neutral">Link tile</Badge>}</td>
                <td className="hide-mobile">{a.visibility === "catalog" ? "Any organization" : <Badge tone="tan">Assigned only</Badge>}</td>
                <td className="mono">{a.tenants}</td>
                <td>{a.status === "active" ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Disabled</Badge>}</td>
                <td className="right"><div className="actions" style={{ justifyContent: "flex-end" }}>
                  <Btn sm variant="quiet" icon="settings" onClick={() => setEdit({ ...a, redirect_uris: a.redirect_uris.join("\n"), post_logout_uris: a.post_logout_uris.join("\n"), initiate_login_uri: a.initiate_login_uri ?? "", backchannel_logout_uri: a.backchannel_logout_uri ?? "" })}>Edit</Btn>
                  {a.owner === "internal" && <Btn sm variant="quiet" icon="key" onClick={() => rotate(a)}>Secret</Btn>}
                  <Btn sm variant="danger" icon="trash" aria-label="Delete" onClick={() => remove(a)} />
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
      <Panel title="Connecting one of your websites" pad className="mt">
        <p className="small muted">Register the site here with its callback address, rotate a client secret, then add the SDK to the site. Issuer for every app: <span className="mono strong">{issuer}</span>. Discovery: <a href="/.well-known/openid-configuration" target="_blank" rel="noreferrer" className="mono">/.well-known/openid-configuration</a></p>
        <pre className="code mt">{`import { createAuth } from "@roadside/auth/server";
const auth = createAuth({ issuer: "${issuer}", clientId: "<app id>", clientSecret: process.env.SSO_SECRET, redirectUri: "https://<your site>/auth/callback" });
app.get("/auth/login", auth.login);   app.get("/auth/callback", auth.callback);   app.get("/auth/logout", auth.logout);
app.post("/auth/backchannel-logout", express.urlencoded({ extended: false }), auth.backchannelLogout);
app.get("/dispatch", auth.requireAuth, auth.requireRole("dispatcher", "manager", "owner"), handler);`}</pre>
      </Panel>
      {edit && <AppForm app={edit} onClose={() => setEdit(null)} onDone={(r) => { setEdit(null); load(); if (r?.clientSecret) setSecret({ app: { name: r.id, id: r.id }, secret: r.clientSecret }); else toast("Saved"); }} />}
      {secret && (
        <Modal title={`Client secret · ${secret.app.name}`} onClose={() => setSecret(null)} footer={<Btn variant="key" onClick={() => setSecret(null)}>Done</Btn>}>
          <CopyBox label="Client ID" value={secret.app.id} />
          <CopyBox label="Client secret (shown once)" value={secret.secret} />
          <CopyBox label="Issuer" value={issuer} />
          <p className="small muted">Store the secret in the website's environment variables. It is not recoverable; rotate it if lost.</p>
        </Modal>
      )}
    </>
  );
}

function AppForm({ app, onClose, onDone }) {
  const isNew = !app.created_at;
  const [f, setF] = useState(app);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const submit = async () => {
    setBusy(true); setErr(null);
    try { onDone(isNew ? await post("/api/platform/apps", f) : (await patch(`/api/platform/apps/${app.id}`, f), null)); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={isNew ? "Register an app" : `Edit ${app.name}`} onClose={onClose} wide footer={<><Btn variant="quiet" onClick={onClose}>Cancel</Btn><Btn variant="key" onClick={submit} disabled={busy || !f.name}>{isNew ? "Register" : "Save"}</Btn></>}>
      <ErrorBox error={err} />
      <div className="grid3">
        <Field label="Name"><input value={f.name} onChange={set("name")} autoFocus /></Field>
        <Field label="App id / client_id" hint="Letters, numbers, dashes"><input value={f.id} onChange={set("id")} disabled={!isNew} placeholder="auto from name" /></Field>
        <Field label="Category"><input value={f.category} onChange={set("category")} /></Field>
      </div>
      <Field label="Description"><input value={f.description} onChange={set("description")} /></Field>
      <div className="grid3">
        <Field label="Tile icon" hint={<a href="https://tabler.io/icons" target="_blank" rel="noreferrer">Tabler icon name</a>}><input value={f.icon} onChange={set("icon")} /></Field>
        <Field label="Kind"><select value={f.owner} onChange={set("owner")}><option value="internal">Our website (single sign-on)</option><option value="partner">Outside site (link tile)</option></select></Field>
        <Field label="Visibility"><select value={f.visibility} onChange={set("visibility")}><option value="catalog">Any organization may add</option><option value="private">Assigned by platform only</option></select></Field>
      </div>
      <div className="grid2">
        <Field label="Website address"><input value={f.base_url} onChange={set("base_url")} placeholder="https://www.ustowdispatch.com" /></Field>
        <Field label="Launch address" hint="Where the tile opens. Placeholders: {email} {org}"><input value={f.launch_url} onChange={set("launch_url")} placeholder="https://www.ustowdispatch.com" /></Field>
      </div>
      {f.owner === "internal" && (
        <>
          <div className="grid2">
            <Field label="Redirect URIs (callback)" hint="One per line. Exact match required."><textarea value={f.redirect_uris} onChange={set("redirect_uris")} placeholder="https://www.ustowdispatch.com/auth/callback" /></Field>
            <Field label="Post-logout redirect URIs" hint="One per line."><textarea value={f.post_logout_uris} onChange={set("post_logout_uris")} placeholder="https://www.ustowdispatch.com/" /></Field>
          </div>
          <div className="grid3">
            <Field label="Client type"><select value={f.client_type} onChange={set("client_type")}><option value="confidential">Confidential (server, secret)</option><option value="public">Public (browser app, PKCE)</option></select></Field>
            <Field label="Login-initiation URL" hint="Optional. Tile sends the person here to start SSO."><input value={f.initiate_login_uri} onChange={set("initiate_login_uri")} placeholder="https://site/auth/login" /></Field>
            <Field label="Back-channel logout URL" hint="Optional. Called when a person signs out."><input value={f.backchannel_logout_uri} onChange={set("backchannel_logout_uri")} placeholder="https://site/auth/backchannel-logout" /></Field>
          </div>
        </>
      )}
      <div className="grid3">
        <Field label="Sort"><input type="number" value={f.sort} onChange={set("sort")} /></Field>
        <Field label="Status"><select value={f.status} onChange={set("status")}><option value="active">Active</option><option value="disabled">Disabled everywhere</option></select></Field>
        <Field label="Mobile"><label className="check" style={{ height: 34 }}><input type="checkbox" checked={!!f.mobile} onChange={set("mobile")} />Show on phones</label></Field>
      </div>
    </Modal>
  );
}

// ---------- Users ----------
function Users() {
  const [q, setQ] = useState("");
  const [list, setList] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => get(`/api/platform/users?q=${encodeURIComponent(q)}`).then(setList).catch((e) => toast(e.message, "bad"));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q]);
  const setAdmin = async (u, v) => {
    if (v && !(await confirm({ title: `Make ${u.name} a platform administrator?`, text: "They can manage every organization and the app catalog.", label: "Grant" }))) return;
    try { await patch(`/api/platform/users/${u.id}`, { isPlatformAdmin: v }); load(); } catch (e) { toast(e.message, "bad"); }
  };
  const setStatus = async (u) => {
    const dis = u.status === "active";
    if (dis && !(await confirm({ title: `Disable ${u.name}'s sign-in?`, text: "They are signed out everywhere and cannot sign in to any organization.", label: "Disable", tone: "danger" }))) return;
    try { await patch(`/api/platform/users/${u.id}`, { status: dis ? "disabled" : "active" }); load(); } catch (e) { toast(e.message, "bad"); }
  };
  return (
    <>
      <div className="row-flex mb"><label className="search"><Icon name="search" /><input placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} /></label><span className="tiny faint">{list?.length ?? 0} people</span></div>
      <Panel>
        {!list ? <div className="pb muted">Loading…</div> : !list.length ? <Empty icon="users" title="No people found" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Person</th><th>Organizations</th><th className="hide-mobile">Two-step</th><th className="hide-mobile">Last sign-in</th><th>Platform admin</th><th></th></tr></thead>
            <tbody>{list.map((u) => (
              <tr key={u.id} style={{ opacity: u.status === "active" ? 1 : 0.6 }}>
                <td><div className="n">{u.name}{u.status !== "active" && <Badge tone="bad"> disabled</Badge>}</div><div className="e">{u.email}</div></td>
                <td><div className="chips">{u.tenants.map((t) => <span className="chip" key={t.id} title={t.roles.join(", ")}>{t.name}</span>)}</div></td>
                <td className="hide-mobile">{u.mfa_enabled ? <Badge tone="ok">On</Badge> : <Badge tone="warn">Off</Badge>}</td>
                <td className="hide-mobile tiny muted">{u.last_login_at ? fmtDate(u.last_login_at) : "never"}</td>
                <td><label className="check"><input type="checkbox" checked={u.is_platform_admin} onChange={(e) => setAdmin(u, e.target.checked)} />{u.is_platform_admin ? "Yes" : "No"}</label></td>
                <td className="right"><Btn sm variant={u.status === "active" ? "danger" : "quiet"} onClick={() => setStatus(u)}>{u.status === "active" ? "Disable" : "Enable"}</Btn></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
