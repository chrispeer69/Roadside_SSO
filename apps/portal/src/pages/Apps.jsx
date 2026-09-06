import { useEffect, useState } from "react";
import { get, put, del } from "../api.js";
import { useMe } from "../App.jsx";
import { Btn, Badge, Field, Icon, Modal, Panel, Empty, Picker, Toggle, PageHead, ErrorBox, useToast, useConfirm } from "../components/ui.jsx";

export default function Apps() {
  const { me, reload } = useMe();
  const isAdmin = !!me.membership?.isAdmin || me.user.isPlatformAdmin;
  return isAdmin ? <AdminApps onChanged={reload} /> : <MyApps apps={me.apps} />;
}

function MyApps({ apps }) {
  return (
    <>
      <PageHead title="Apps" sub="Everything you can open with your Roadside sign-in." />
      <Panel>
        {apps.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>App</th><th className="hide-mobile">Category</th><th className="hide-mobile">About</th><th></th></tr></thead>
            <tbody>{apps.map((a) => (
              <tr key={a.id}>
                <td><div className="row-flex"><Icon name={a.icon || "apps"} style={{ color: "var(--blue)", fontSize: 16 }} /><span className="n">{a.name}</span></div></td>
                <td className="hide-mobile muted">{a.category}</td>
                <td className="hide-mobile muted">{a.description}</td>
                <td className="right"><a className="btn sm" href={`/launch/${a.id}`}>Open<Icon name="arrow-up-right" /></a></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="apps" title="No apps yet" text="Your administrator has not added any apps to your dashboard." />}
      </Panel>
    </>
  );
}

function AdminApps({ onChanged }) {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  const [tenantInfo, setTenantInfo] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => Promise.all([get("/api/tenant/apps"), get("/api/tenant")]).then(([d, t]) => { setData(d); setTenantInfo(t); }).catch(setErr);
  useEffect(() => { load(); }, []);

  const connect = async (app) => {
    try { await put(`/api/tenant/apps/${app.id}`, {}); toast(`${app.name} added to the dashboard`); await load(); onChanged(); } catch (e) { toast(e.message, "bad"); }
  };
  const toggle = async (a, enabled) => {
    try { await put(`/api/tenant/apps/${a.id}`, { enabled }); await load(); onChanged(); } catch (e) { toast(e.message, "bad"); }
  };
  const disconnect = async (a) => {
    if (!(await confirm({ title: `Remove ${a.name}?`, text: "The tile disappears from every dashboard in this organization and open app sessions for it are revoked.", label: "Remove", tone: "danger" }))) return;
    try { await del(`/api/tenant/apps/${a.id}`); toast("Removed"); await load(); onChanged(); } catch (e) { toast(e.message, "bad"); }
  };

  if (err) return <ErrorBox error={err} />;
  if (!data) return <div className="muted">Loading…</div>;
  const roles = tenantInfo?.roles ?? [];

  return (
    <>
      <PageHead title="Apps and tiles" sub="Choose which apps appear on this organization's dashboard and which roles can open each one." />
      <section className="section" style={{ marginTop: 0 }}>
        <div className="section-head"><h2>On the dashboard</h2><span className="tiny faint">{data.connected.length} connected</span></div>
        <Panel>
          {data.connected.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Tile</th><th className="hide-mobile">Who can open it</th><th className="hide-mobile">Sign-in</th><th>Shown</th><th></th></tr></thead>
              <tbody>{data.connected.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="row-flex"><Icon name={a.icon || "apps"} style={{ color: "var(--blue)", fontSize: 16 }} /><div><div className="n">{a.name}{a.pinned && <Badge tone="tan"> pinned</Badge>}</div><div className="e">{a.label && a.label !== a.appName ? `${a.appName} · ` : ""}{a.category}</div></div></div>
                  </td>
                  <td className="hide-mobile">{a.allowedRoles.length ? <div className="chips">{a.allowedRoles.map((r) => <span className="chip" key={r}>{r}</span>)}</div> : <span className="muted">Everyone</span>}</td>
                  <td className="hide-mobile">{a.owner === "internal" ? <Badge tone="blue">Single sign-on</Badge> : <Badge tone="neutral">Link</Badge>}{a.appStatus !== "active" && <Badge tone="bad"> disabled by platform</Badge>}</td>
                  <td><Toggle on={a.enabled} onChange={(v) => toggle(a, v)} label={`Show ${a.name}`} /></td>
                  <td className="right"><div className="actions" style={{ justifyContent: "flex-end" }}><Btn sm variant="quiet" icon="settings" onClick={() => setEdit(a)}>Settings</Btn><Btn sm variant="danger" icon="trash" onClick={() => disconnect(a)} aria-label={`Remove ${a.name}`} /></div></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty icon="layout-grid" title="Nothing on the dashboard yet" text="Add apps from the catalog below." />}
        </Panel>
      </section>

      <section className="section">
        <div className="section-head"><h2>Catalog · available to add</h2></div>
        <Panel>
          {data.available.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>App</th><th className="hide-mobile">Category</th><th className="hide-mobile">About</th><th></th></tr></thead>
              <tbody>{data.available.map((a) => (
                <tr key={a.id}>
                  <td><div className="row-flex"><Icon name={a.icon || "apps"} style={{ color: "var(--ink-3)", fontSize: 16 }} /><span className="n">{a.name}</span></div></td>
                  <td className="hide-mobile muted">{a.category}</td>
                  <td className="hide-mobile muted">{a.description}</td>
                  <td className="right"><Btn sm variant="key" icon="plus" onClick={() => connect(a)}>Add to dashboard</Btn></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty icon="check" title="Every catalog app is connected" />}
        </Panel>
        <p className="tiny faint mt">Apps marked "Single sign-on" open with your Roadside session automatically. "Link" tiles open the site; the person signs in there once and the site keeps them signed in.</p>
      </section>

      {edit && <TileSettings app={edit} roles={roles} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await load(); onChanged(); }} />}
    </>
  );
}

function TileSettings({ app, roles, onClose, onSaved }) {
  const [f, setF] = useState({ label: app.label ?? "", launchUrl: app.launchUrlOverride ?? "", allowedRoles: app.allowedRoles, pinned: app.pinned, sort: app.sort ?? 100 });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async () => {
    setBusy(true); setErr(null);
    try { await put(`/api/tenant/apps/${app.id}`, f); toast("Tile updated"); onSaved(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={`${app.appName} · tile settings`} onClose={onClose} footer={<><Btn variant="quiet" onClick={onClose}>Cancel</Btn><Btn variant="key" onClick={save} disabled={busy}>Save</Btn></>}>
      <ErrorBox error={err} />
      <Field label="Who can open it" hint="Leave empty to allow every active person in the organization. Per-person allow or deny overrides are set on the People page.">
        <Picker options={roles} value={f.allowedRoles} onChange={(v) => setF({ ...f, allowedRoles: v })} />
      </Field>
      <div className="grid2">
        <Field label="Tile label" hint="Optional. Shown instead of the app name."><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={app.appName} /></Field>
        <Field label="Order" hint="Lower numbers appear first."><input type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></Field>
      </div>
      <Field label="Launch address override" hint="Optional. Use for an organization-specific address or shared account. Placeholders: {email}, {org}."><input value={f.launchUrl} onChange={(e) => setF({ ...f, launchUrl: e.target.value })} placeholder={app.launchUrl} /></Field>
      <label className="check"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />Pin to the top of the dashboard</label>
    </Modal>
  );
}
