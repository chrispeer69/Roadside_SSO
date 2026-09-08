// Shared UI kit for the portal.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export const Icon = ({ name, ...p }) => <i className={`ti ti-${name}`} aria-hidden="true" {...p}></i>;

export function Btn({ variant = "", sm, icon, children, className = "", ...p }) {
  return <button type="button" className={`btn ${variant} ${sm ? "sm" : ""} ${className}`} {...p}>{icon && <Icon name={icon} />}{children}</button>;
}

export const Badge = ({ tone = "neutral", children }) => <span className={`badge ${tone}`}>{children}</span>;

export const Field = ({ label, hint, children }) => (
  <div className="field">{label && <label>{label}</label>}{children}{hint && <div className="hint">{hint}</div>}</div>
);

export function Toggle({ on, onChange, label }) {
  return <button type="button" role="switch" aria-checked={!!on} aria-label={label} className="toggle" onClick={() => onChange(!on)} />;
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh"><h2>{title}</h2><button className="x" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="mb">{children}</div>
        {footer && <div className="mf">{footer}</div>}
      </div>
    </div>
  );
}

// ----- Toasts -----
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const toast = useCallback((text, tone = "") => {
    const id = Math.random();
    setItems((l) => [...l, { id, text, tone }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ----- Confirm dialog (replaces window.confirm) -----
const ConfirmCtx = createContext(async () => false);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const done = (v) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Modal title={state.title ?? "Are you sure?"} onClose={() => done(false)}
          footer={<><Btn variant="quiet" onClick={() => done(false)}>Cancel</Btn><Btn variant={state.tone === "danger" ? "danger" : "key"} onClick={() => done(true)}>{state.label ?? "Confirm"}</Btn></>}>
          <p>{state.text}</p>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

export function CopyBox({ value, label }) {
  const toast = useToast();
  const copy = async () => { try { await navigator.clipboard.writeText(value); toast("Copied"); } catch { toast("Copy failed. Select the text and copy it.", "bad"); } };
  return (
    <div className="field">
      {label && <span className="lbl">{label}</span>}
      <div className="copybox"><span className="v">{value}</span><Btn sm variant="quiet" icon="copy" onClick={copy}>Copy</Btn></div>
    </div>
  );
}

export const Empty = ({ icon = "inbox", title, text, children }) => (
  <div className="empty"><Icon name={icon} /><div className="t">{title}</div>{text && <div>{text}</div>}{children && <div className="mt">{children}</div>}</div>
);

export const PageHead = ({ title, sub, actions }) => (
  <div className="page-head"><div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>
);

export const Panel = ({ title, actions, children, pad, className = "", style }) => (
  <div className={`panel ${className}`} style={style}>
    {(title || actions) && <div className="ph"><span className="t">{title}</span>{actions}</div>}
    {pad ? <div className="pb">{children}</div> : children}
  </div>
);

export const Tabs = ({ tabs, active, onChange }) => (
  <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>
);

export const Spinner = () => <span className="spin" aria-label="Loading" />;
export const ErrorBox = ({ error }) => (error ? <div className="error" role="alert">{typeof error === "string" ? error : error.message}</div> : null);

// Multi-select chips (roles etc.)
export function Picker({ options, value = [], onChange }) {
  const toggle = (o) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  return <div className="chips">{options.map((o) => <span key={o} className={`chip pick ${value.includes(o) ? "on" : "off"}`} role="checkbox" aria-checked={value.includes(o)} tabIndex={0} onClick={() => toggle(o)} onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle(o))}>{o}</span>)}</div>;
}

// Comma separated text -> array
export function ListInput({ value = [], onChange, placeholder }) {
  const [text, setText] = useState(value.join(", "));
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setText(value.join(", ")); }, [value.join("|")]);
  return <input className="input" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))} />;
}

export const Chips = ({ items = [] }) => (items.length ? <div className="chips">{items.map((i) => <span className="chip" key={i}>{i}</span>)}</div> : <span className="faint">—</span>);

export const fmtDate = (v) => (v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const fmtDay = (v) => (v ? new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
export function timeAgo(v) {
  if (!v) return "—";
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const initials = (name = "") => name.split(/\s+/).map((s) => s[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "?";
export const uaShort = (ua = "") => {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return `${br} · ${os}`;
};
export const EVENT_LABEL = {
  "login.success": "Signed in", "login.failed": "Failed sign-in", logout: "Signed out", "mfa.passed": "Verified code", "mfa.failed": "Wrong code",
  "mfa.enabled": "Two-step enabled", "mfa.disabled": "Two-step disabled", "mfa.reset": "Two-step reset", "app.launched": "Opened app", "app.denied": "App access denied",
  "password.changed": "Password changed", "password.reset": "Password reset", "password.temp_issued": "Temporary password issued", "password.set_by_admin": "Password set by administrator", "password.reset_link": "Reset link created",
  "person.created": "Person added", "person.attached": "Person added", "person.updated": "Person updated", "person.removed": "Person removed", "person.email_changed": "Email changed",
  "app.connected": "App connected", "app.updated": "App settings changed", "app.disconnected": "App disconnected", "tenant.updated": "Organization settings changed",
  "tenant.created": "Organization created", "tenant.switched": "Switched organization", "session.revoked": "Session ended", "user.updated": "User updated",
  "catalog.app_created": "Catalog app created", "catalog.app_updated": "Catalog app updated", "catalog.app_deleted": "Catalog app deleted", "catalog.secret_rotated": "Client secret rotated",
};
export const eventLabel = (e) => EVENT_LABEL[e] ?? e;
