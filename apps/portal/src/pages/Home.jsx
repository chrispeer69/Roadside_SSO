import { useEffect, useState } from "react";
import { get } from "../api.js";
import { useMe } from "../App.jsx";
import { Link } from "../router.jsx";
import { Icon, Panel, Empty, Badge, Chips, timeAgo, eventLabel } from "../components/ui.jsx";

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

export default function Home() {
  const { me } = useMe();
  const [activity, setActivity] = useState([]);
  useEffect(() => { get("/api/me/activity").then(setActivity).catch(() => {}); }, []);
  const isAdmin = !!me.membership?.isAdmin || me.user.isPlatformAdmin;
  const pinned = me.apps.filter((a) => a.pinned);
  const rest = me.apps.filter((a) => !a.pinned);
  const t = me.tenant;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting()}, {me.user.name.split(" ")[0]}</h1>
          <p className="sub">{t ? t.name : "No organization yet"} · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
        </div>
        {isAdmin && <div className="actions"><Link className="btn" to="/apps"><Icon name="adjustments" />Manage tiles</Link><Link className="btn" to="/people"><Icon name="user-plus" />Add person</Link></div>}
      </div>

      {me.mfaPolicy && <div className="notice tan mb"><Icon name="shield-lock" /> Your role requires two-step sign-in. <Link to="/account">Set it up now</Link> to keep access to your apps.</div>}
      {t?.welcome && <div className="notice mb">{t.welcome}</div>}

      {!me.apps.length ? (
        <Panel><Empty icon="apps" title="No apps on your dashboard yet" text={isAdmin ? "Connect apps from the catalog to build this organization's dashboard." : "Your administrator has not given you access to any apps yet."}>{isAdmin && <Link className="btn key" to="/apps">Open the app catalog</Link>}</Empty></Panel>
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="section" style={{ marginTop: 0 }}>
              <div className="section-head"><h2>Pinned</h2></div>
              <div className="tiles">{pinned.map((a) => <Tile key={a.id} app={a} />)}</div>
            </section>
          )}
          <section className="section" style={{ marginTop: pinned.length ? 22 : 0 }}>
            <div className="section-head"><h2>Your apps</h2><span className="tiny faint">{me.apps.length} available · one sign-in</span></div>
            <div className="tiles">{rest.map((a) => <Tile key={a.id} app={a} />)}</div>
          </section>
        </>
      )}

      <section className="section cols">
        <Panel title="Recent activity" actions={<Badge tone="neutral">Your account</Badge>}>
          {activity.length ? activity.slice(0, 10).map((a, i) => (
            <div className="row" key={i}><span className="src">{a.event.split(".")[0]}</span><span>{eventLabel(a.event)}{a.target ? ` · ${a.target}` : ""}</span><span className="t">{timeAgo(a.at)}</span></div>
          )) : <div className="row faint">No activity yet.</div>}
        </Panel>
        <div className="stack">
          <Panel title="Your access" pad>
            <div className="stack" style={{ gap: 8 }}>
              <div><div className="upper">Organization</div><div className="strong">{t?.name ?? "—"}</div></div>
              <div><div className="upper">Roles</div><Chips items={me.membership?.roles ?? []} /></div>
              <div><div className="upper">Locations</div><Chips items={me.membership?.locations ?? []} /></div>
              <div><div className="upper">Two-step sign-in</div>{me.user.mfaEnabled ? <Badge tone="ok">On</Badge> : <Badge tone="warn">Off</Badge>} <Link to="/account" className="tiny" style={{ marginLeft: 6 }}>Manage</Link></div>
            </div>
          </Panel>
          {(t?.quickLinks?.length > 0) && (
            <Panel title="Quick links">
              {t.quickLinks.map((l, i) => <a className="row" key={i} href={l.url} target="_blank" rel="noreferrer"><Icon name="external-link" style={{ color: "var(--ink-3)" }} />{l.label}</a>)}
            </Panel>
          )}
          {(t?.supportPhone || t?.supportEmail) && (
            <Panel title="Need help" pad>
              {t.supportPhone && <div className="row-flex"><Icon name="phone" /><a href={`tel:${t.supportPhone}`}>{t.supportPhone}</a></div>}
              {t.supportEmail && <div className="row-flex" style={{ marginTop: 6 }}><Icon name="mail" /><a href={`mailto:${t.supportEmail}`}>{t.supportEmail}</a></div>}
            </Panel>
          )}
        </div>
      </section>
    </>
  );
}

function Tile({ app }) {
  return (
    <a className={`tile ${app.pinned ? "pinned" : ""}`} href={`/launch/${app.id}`} title={`Open ${app.name}`}>
      <span className="ic"><Icon name={app.icon || "apps"} /></span>
      <span className="grow">
        <span className="n">{app.name}</span>
        <span className="c">{app.category}</span>
        <span className="d">{app.description}</span>
      </span>
      <Icon name="arrow-up-right" className="ti ti-arrow-up-right go" />
    </a>
  );
}
