import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { get, post } from "./api.js";
import { useRoute, navigate, Link } from "./router.jsx";
import { Icon, ToastProvider, ConfirmProvider, initials, useToast } from "./components/ui.jsx";
import Login from "./pages/Login.jsx";
import Home from "./pages/Home.jsx";
import Apps from "./pages/Apps.jsx";
import People from "./pages/People.jsx";
import Security from "./pages/Security.jsx";
import Account from "./pages/Account.jsx";
import Platform from "./pages/Platform.jsx";
import Mail from "./pages/Mail.jsx";

const MeCtx = createContext(null);
export const useMe = () => useContext(MeCtx);

const PAGES = {
  "/": { el: Home, label: "Dashboard", icon: "layout-grid" },
  "/apps": { el: Apps, label: "Apps", icon: "apps" },
  "/mail": { el: Mail, label: "Mail", icon: "mail", wide: true },
  "/people": { el: People, label: "People", icon: "users", admin: true },
  "/security": { el: Security, label: "Security", icon: "shield-check", admin: true },
  "/account": { el: Account, label: "Account", icon: "user-circle" },
  "/platform": { el: Platform, label: "Platform", icon: "building-skyscraper", platform: true },
};

export default function App() {
  return (
    <ToastProvider><ConfirmProvider><Root /></ConfirmProvider></ToastProvider>
  );
}

function Root() {
  const { path, query } = useRoute();
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const toast = useToast();

  const reload = useCallback(async () => {
    try { setMe(await get("/api/me")); } catch (e) { setMe(e.status === 401 ? null : null); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const switchTenant = async (tenantId) => { await post("/api/me/tenant", { tenantId }); await reload(); };
  const logout = async () => { await post("/api/auth/logout"); setMe(null); navigate("/login"); toast("Signed out"); };

  if (me === undefined) return <div className="loading">Roadside SSO</div>;

  const next = query.get("next") ?? "";
  const publicPage = path === "/login" || path === "/reset";
  const complete = me && !me.user.mfaRequired && !me.user.mustChangePassword;

  if (path === "/reset") return <Login mode="reset" token={query.get("token") ?? ""} onDone={reload} />;
  if (!me) {
    if (!publicPage) { navigate(`/login?next=${encodeURIComponent(path + window.location.search)}`, { replace: true }); return null; }
    return <Login mode="login" hint={query.get("hint") ?? ""} onDone={reload} />;
  }
  if (me.user.mfaRequired) return <Login mode="mfa" user={me.user} onDone={reload} onLogout={logout} />;
  if (me.user.mustChangePassword) return <Login mode="change" user={me.user} onDone={reload} onLogout={logout} />;
  if (publicPage && complete) {
    const to = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    navigate(to, { replace: true });
    return null;
  }

  return (
    <MeCtx.Provider value={{ me, reload, switchTenant, logout }}>
      <Shell path={path} />
    </MeCtx.Provider>
  );
}

function Shell({ path }) {
  const { me, switchTenant, logout } = useMe();
  const [menu, setMenu] = useState(false);
  const isAdmin = !!me.membership?.isAdmin || me.user.isPlatformAdmin;
  const base = "/" + (path.split("/")[1] ?? "");
  const page = PAGES[base] ?? PAGES["/"];
  const allowed = (p) => (!p.admin || isAdmin) && (!p.platform || me.user.isPlatformAdmin);
  if (!allowed(page)) { navigate("/", { replace: true }); return null; }
  const Page = page.el;
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="shell">
      <aside className="rail" aria-label="Navigation">
        <Link to="/" className="brand"><span className="mark">RS</span><span className="name">ROADSIDE <span>SSO</span></span></Link>
        <nav>
          {Object.entries(PAGES).filter(([, p]) => allowed(p)).map(([to, p]) => (
            <Link key={to} to={to} aria-current={base === to ? "page" : undefined}><Icon name={p.icon} />{p.label}</Link>
          ))}
        </nav>
        <div className="spacer" />
        <div className="foot"><div className="status"><span className="dot" />Single sign-on active</div>{me.tenant?.name ?? "No organization"}</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="orgswitch" title="Active organization">
            <Icon name="building" />
            {me.tenants.length > 1 ? (
              <select value={me.tenant?.id ?? ""} onChange={(e) => switchTenant(e.target.value)} aria-label="Switch organization">
                {me.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : <span>{me.tenant?.name ?? "No organization"}</span>}
          </div>
          <div className="ticker">
            <span>{today}</span>
            <span><b>{me.apps.length}</b> apps on your dashboard</span>
            {me.membership?.roles?.length ? <span>Role <b>{me.membership.roles.join(", ")}</b></span> : null}
          </div>
          <div className="usermenu">
            <button onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}><span className="avatar">{initials(me.user.name)}</span><span className="hide-mobile">{me.user.name.split(" ")[0]}</span><Icon name="chevron-down" /></button>
            {menu && (
              <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <div className="who"><div className="n">{me.user.name}</div><div className="e">{me.user.email}</div></div>
                <Link to="/account" onClick={() => setMenu(false)}><Icon name="user-circle" />My account</Link>
                {me.user.isPlatformAdmin && <Link to="/platform" onClick={() => setMenu(false)}><Icon name="building-skyscraper" />Platform admin</Link>}
                <button onClick={logout}><Icon name="logout" />Sign out everywhere</button>
              </div>
            )}
          </div>
        </header>
        <main className={`page ${page.wide ? "page-wide" : ""}`}><Page /></main>
      </div>
    </div>
  );
}
