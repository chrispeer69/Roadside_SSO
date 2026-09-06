// Browser (SPA / static site) client for Roadside SSO using the OIDC code flow with PKCE.
//
//   <script type="module">
//     import { createClient } from "https://your-sso/sdk/browser.js";   // or bundle from @roadside/auth/browser
//     const sso = createClient({ issuer: "https://sso.example.com", clientId: "crew-app", redirectUri: location.origin + "/callback.html" });
//     const user = await sso.handleRedirect() ?? sso.getUser();
//     if (!user) sso.login(); else console.log(user.name, user.roles);
//   </script>
import { parseClaims } from "./claims.js";

const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = () => enc(crypto.getRandomValues(new Uint8Array(32)));
const sha = async (s) => enc(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const decodeJwt = (t) => JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

export function createClient({ issuer, clientId, redirectUri, scope = "openid profile email roadside", storage = sessionStorage, key = "rsso" }) {
  issuer = issuer.replace(/\/+$/, "");
  const load = () => JSON.parse(storage.getItem(key) ?? "null");
  const save = (v) => (v ? storage.setItem(key, JSON.stringify(v)) : storage.removeItem(key));

  async function login({ next = location.pathname + location.search, loginHint } = {}) {
    const verifier = rand(), state = rand(), nonce = rand();
    storage.setItem(`${key}_pkce`, JSON.stringify({ verifier, state, nonce, next }));
    const u = new URL(`${issuer}/oauth/authorize`);
    u.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope, state, nonce, code_challenge: await sha(verifier), code_challenge_method: "S256", ...(loginHint ? { login_hint: loginHint } : {}) }).toString();
    location.assign(u.toString());
  }

  async function token(params) {
    const r = await fetch(`${issuer}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, ...params }) });
    if (!r.ok) throw new Error(`token ${r.status}`);
    const t = await r.json();
    const s = { access: t.access_token, refresh: t.refresh_token, id: t.id_token, exp: Date.now() + t.expires_in * 1000 };
    save(s);
    return s;
  }

  // Call on the redirect page. Returns the user when a code was exchanged, otherwise null.
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.get("code") && !p.get("error")) return null;
    const saved = JSON.parse(storage.getItem(`${key}_pkce`) ?? "null");
    storage.removeItem(`${key}_pkce`);
    if (!saved || saved.state !== p.get("state")) throw new Error("state mismatch");
    if (p.get("error")) throw new Error(p.get("error_description") ?? p.get("error"));
    const s = await token({ grant_type: "authorization_code", code: p.get("code"), redirect_uri: redirectUri, code_verifier: saved.verifier });
    if (decodeJwt(s.id).nonce !== saved.nonce) { save(null); throw new Error("nonce mismatch"); }
    history.replaceState({}, "", saved.next && saved.next.startsWith("/") ? saved.next : "/");
    return parseClaims(decodeJwt(s.access));
  }

  async function getToken() {
    const s = load();
    if (!s) return null;
    if (Date.now() < s.exp - 30e3) return s.access;
    if (!s.refresh) return null;
    try { return (await token({ grant_type: "refresh_token", refresh_token: s.refresh })).access; } catch { save(null); return null; }
  }

  const getUser = () => { const s = load(); return s ? parseClaims(decodeJwt(s.access)) : null; };

  function logout({ next = location.origin } = {}) {
    const s = load();
    save(null);
    const u = new URL(`${issuer}/oauth/logout`);
    u.searchParams.set("post_logout_redirect_uri", next);
    if (s?.id) u.searchParams.set("id_token_hint", s.id);
    location.assign(u.toString());
  }

  const fetchWithAuth = async (url, init = {}) => {
    const t = await getToken();
    if (!t) throw new Error("not signed in");
    return fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}` } });
  };

  return { login, handleRedirect, getToken, getUser, logout, fetch: fetchWithAuth };
}
