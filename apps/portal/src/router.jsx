// Tiny history-based router. Server routes (/oauth/*, /launch/*) are full navigations, everything else is client side.
import { useEffect, useReducer } from "react";

const listeners = new Set();
const notify = () => listeners.forEach((l) => l());

export function navigate(to, { replace = false } = {}) {
  if (/^https?:\/\//.test(to) || to.startsWith("/oauth/") || to.startsWith("/launch/")) { window.location.assign(to); return; }
  window.history[replace ? "replaceState" : "pushState"]({}, "", to);
  notify();
}

export function useRoute() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const l = () => force();
    listeners.add(l);
    window.addEventListener("popstate", l);
    return () => { listeners.delete(l); window.removeEventListener("popstate", l); };
  }, []);
  return { path: window.location.pathname, query: new URLSearchParams(window.location.search) };
}

export function Link({ to, children, ...props }) {
  const onClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick} {...props}>{children}</a>;
}
