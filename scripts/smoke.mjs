// Dev-only end-to-end smoke test. Run against a FRESH local database (npm run db:reset) with the API on :8787.
// Exercises: login, tenant admin, platform catalog, OIDC code+PKCE, refresh, introspect, back-channel revocation, MFA.
import { createHash, randomBytes } from "node:crypto";
const B = "http://localhost:8787";
let jar = "";
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } else console.log("ok  ", m); };
async function call(path, { method = "GET", body, headers = {}, redirect = "manual", raw = false } = {}) {
  const r = await fetch(B + path, { method, redirect, headers: { cookie: jar, ...(body ? { "content-type": "application/json" } : { "x-requested-with": "XMLHttpRequest" }), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) jar = sc.split(";")[0];
  return raw ? r : { status: r.status, data: await r.json().catch(() => ({})), loc: r.headers.get("location") };
}

let r = await call("/api/auth/login", { method: "POST", body: { email: "admin@roadside.local", password: "wrong" } });
assert(r.status === 401, "bad password rejected");
r = await call("/api/auth/login", { method: "POST", body: { email: "admin@roadside.local", password: "ChangeMe!2026" } });
assert(r.status === 200 && r.data.ok, "login ok");
r = await call("/api/me");
assert(r.data.tenant?.slug === "roadside" && r.data.apps.length === 7, `me: tenant + ${r.data.apps.length} tiles`);
assert(r.data.membership.isAdmin && r.data.user.isPlatformAdmin, "admin flags");

// tenant admin
r = await call("/api/tenant"); assert(r.status === 200 && r.data.stats.people === 1, "tenant stats");
r = await call("/api/tenant/people", { method: "POST", body: { email: "driver@roadside.local", name: "Tori Banks", roles: ["driver"], locations: ["denver"] } });
assert(r.status === 201 && r.data.tempPassword, "person created with temp password " + r.data.tempPassword);
const driverId = r.data.id, driverTemp = r.data.tempPassword;
r = await call("/api/tenant/apps/ustowstats", { method: "PUT", body: { allowedRoles: ["owner", "bookkeeper"] } });
assert(r.status === 200 && r.data.allowed_roles.length === 2, "stats restricted to owner/bookkeeper");
r = await call("/api/tenant/people/" + driverId, { method: "PATCH", body: { appOverrides: { gmail: "deny" } } });
assert(r.status === 200, "driver denied gmail");
r = await call("/api/tenant/audit"); assert(r.data.length >= 3, "audit entries " + r.data.length);
r = await call("/api/tenant", { method: "PATCH", body: { settings: { quickLinks: [{ label: "Fuel card", url: "https://example.com" }], sessionHours: 48 } } });
assert(r.status === 200, "tenant settings saved");

// platform: register a confidential OIDC client
r = await call("/api/platform/apps", { method: "POST", body: { id: "testapp", name: "Test App", redirect_uris: "http://localhost:9999/cb", post_logout_uris: ["http://localhost:9999/"], base_url: "http://localhost:9999" } });
assert(r.status === 201 && r.data.clientSecret, "client created with secret");
const secret = r.data.clientSecret;
r = await call("/api/platform/overview"); assert(r.data.stats.tenants === 1, "platform overview");
r = await call("/api/platform/tenants", { method: "POST", body: { name: "Second Tow Co", ownerEmail: "owner2@example.com", ownerName: "Owner Two", appIds: ["ustowdispatch", "testapp"] } });
assert(r.status === 201 && r.data.owner.tempPassword, "second tenant created with owner");
const t2 = r.data.tenant.id;

// OIDC: admin tenant doesn't have testapp -> should switch to tenant 2? admin isn't member of t2 -> 403
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authz = `/oauth/authorize?client_id=testapp&redirect_uri=${encodeURIComponent("http://localhost:9999/cb")}&response_type=code&scope=openid&state=xyz&nonce=n1&code_challenge=${challenge}&code_challenge_method=S256`;
r = await call(authz, { raw: true }); assert(r.status === 403, "authorize denied when app not on any of my dashboards");
r = await call("/api/tenant/apps/testapp", { method: "PUT", body: {} }); assert(r.status === 200, "connect testapp to my tenant");
r = await call(authz, { raw: true }); const loc = r.headers.get("location");
assert(r.status === 302 && loc?.includes("code=") && loc.includes("state=xyz"), "authorize issued code");
const code = new URL(loc).searchParams.get("code");

// token exchange with client_secret_basic
let tr = await fetch(B + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from("testapp:" + secret).toString("base64") }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/cb", code_verifier: verifier }) });
let tok = await tr.json();
assert(tr.status === 200 && tok.access_token && tok.id_token && tok.refresh_token, "token exchange ok");
const at = JSON.parse(Buffer.from(tok.access_token.split(".")[1], "base64url"));
assert(at.aud === "testapp" && at.org_slug === "roadside" && at.roles.includes("owner") && at.apps.includes("testapp"), "access token claims " + JSON.stringify({ org: at.org_name, roles: at.roles, apps: at.apps.length }));
const idt = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url")); assert(idt.nonce === "n1", "id_token nonce");
let ui = await fetch(B + "/oauth/userinfo", { headers: { authorization: "Bearer " + tok.access_token } }); const uiJ = await ui.json();
assert(ui.status === 200 && uiJ.email === "admin@roadside.local", "userinfo");
tr = await fetch(B + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: "testapp", client_secret: secret }) });
const tok2 = await tr.json(); assert(tr.status === 200 && tok2.access_token, "refresh ok");
tr = await fetch(B + "/oauth/introspect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tok2.access_token, client_id: "testapp", client_secret: secret }) });
assert((await tr.json()).active === true, "introspect active");
tr = await fetch(B + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/cb", code_verifier: verifier, client_id: "testapp", client_secret: secret }) });
assert(tr.status === 400, "code reuse rejected");
tr = await fetch(B + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok2.refresh_token, client_id: "testapp", client_secret: secret }) });
assert(tr.status === 400, "refresh revoked after code replay");
// fresh code -> new tokens for the remaining checks
r = await call(authz, { raw: true }); const code2 = new URL(r.headers.get("location")).searchParams.get("code");
tr = await fetch(B + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: "http://localhost:9999/cb", code_verifier: verifier, client_id: "testapp", client_secret: secret }) });
tok2.refresh_token = (await tr.json()).refresh_token; assert(tr.status === 200 && tok2.refresh_token, "second code exchanged");

// launch route
r = await call("/launch/ustowdispatch", { raw: true }); assert(r.status === 302 && r.headers.get("location").startsWith("https://www.ustowdispatch.com"), "launch redirect");
// wrong secret
tr = await fetch(B + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok2.refresh_token, client_id: "testapp", client_secret: "nope" }) });
assert(tr.status === 401, "wrong client secret rejected");

// logout kills session + refresh tokens
r = await call("/api/auth/logout", { method: "POST" }); assert(r.data.ok, "logout");
tr = await fetch(B + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok2.refresh_token, client_id: "testapp", client_secret: secret }) });
assert(tr.status === 400, "refresh rejected after logout");
r = await call("/api/me"); assert(r.status === 401, "me unauthenticated after logout");

// driver: temp password forces change; then limited dashboard
jar = "";
r = await call("/api/auth/login", { method: "POST", body: { email: "driver@roadside.local", password: driverTemp } });
assert(r.status === 200 && r.data.user.mustChangePassword, "driver login, must change password");
r = await call("/api/tenant"); assert(r.status === 403, "driver blocked from admin API while password change pending");
r = await call("/api/auth/password", { method: "POST", body: { currentPassword: driverTemp, newPassword: "Driver-pass-2026" } }); assert(r.data.ok, "driver changed password");
r = await call("/api/me");
const ids = r.data.apps.map((a) => a.id);
assert(!ids.includes("ustowstats") && !ids.includes("gmail") && ids.includes("ustowdispatch"), "driver tiles: " + ids.join(","));
assert(!r.data.membership.isAdmin, "driver not admin");
r = await call("/api/tenant"); assert(r.status === 403, "driver blocked from admin API");
r = await call("/launch/ustowstats", { raw: true }); assert(r.status === 403, "driver launch of stats denied");

// MFA enrol
r = await call("/api/auth/mfa/setup", { method: "POST" }); assert(r.data.secret, "mfa setup");
const mfaSecret = r.data.secret;
const { TOTP, Secret } = await import("otpauth");
const gen = () => new TOTP({ secret: Secret.fromBase32(mfaSecret) }).generate();
r = await call("/api/auth/mfa/enable", { method: "POST", body: { code: gen() } }); assert(r.data.ok, "mfa enabled");
jar = "";
r = await call("/api/auth/login", { method: "POST", body: { email: "driver@roadside.local", password: "Driver-pass-2026" } });
assert(r.data.user.mfaRequired, "login now requires mfa");
r = await call("/api/me"); assert(r.data.user.mfaRequired && !r.data.apps, "me limited before mfa");
r = await call("/launch/ustowdispatch", { raw: true }); assert(r.status === 302 && r.headers.get("location").includes("/login?next="), "launch redirects to login before mfa");
r = await call("/api/auth/mfa", { method: "POST", body: { code: "000000" } }); assert(r.status === 401, "bad mfa code rejected");
r = await call("/api/auth/mfa", { method: "POST", body: { code: gen() } }); assert(r.data.ok, "mfa passed");
r = await call("/api/me"); assert(r.data.apps?.length > 0, "me full after mfa");
r = await call("/api/me/sessions"); assert(r.data.length >= 1 && r.data.some((s) => s.current), "my sessions");
console.log("ALL PASSED");
