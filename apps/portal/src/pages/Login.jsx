import { useState } from "react";
import { post } from "../api.js";
import { Btn, Field, ErrorBox, Icon } from "../components/ui.jsx";

const Side = () => (
  <div className="side">
    <div className="brandline">ROADSIDE SSO</div>
    <div>
      <h1>One sign-in for every application your team uses on the road and in the office.</h1>
      <p>Dispatch, stats, alliance, mail and more open from a single dashboard. Access is set by your organization, so every person sees exactly the tools their role needs.</p>
      <div className="stats"><div><b>1</b>password</div><div><b>24/7</b>desk and mobile</div><div><b>SSO</b>OpenID Connect</div></div>
    </div>
    <div className="foot">SECURE ACCESS · AUDITED · MULTI-ORGANIZATION</div>
  </div>
);

export default function Login({ mode, hint = "", token = "", user, onDone, onLogout }) {
  return (
    <div className="auth">
      <Side />
      <div className="form">
        {mode === "login" && <SignIn hint={hint} onDone={onDone} />}
        {mode === "mfa" && <Mfa user={user} onDone={onDone} onLogout={onLogout} />}
        {mode === "change" && <ChangePassword user={user} onDone={onDone} onLogout={onLogout} />}
        {mode === "reset" && <Reset token={token} />}
      </div>
    </div>
  );
}

function SignIn({ hint, onDone }) {
  const [email, setEmail] = useState(hint);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await post("/api/auth/login", { email, password }); await onDone(); }
    catch (e2) { setErr(e2.message); setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="only-mobile" style={{ fontSize: 12, letterSpacing: "0.16em", fontWeight: 600, color: "var(--navy)" }}>ROADSIDE SSO</div>
      <h2>Sign in</h2>
      <p className="sub">Use your work email and password.</p>
      <ErrorBox error={err} />
      <Field label="Email"><input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></Field>
      <Field label="Password or PIN"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Btn variant="key" type="submit" className="block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Btn>
      <div className="foot">Forgot your password? Ask your administrator for a reset link or a temporary password.</div>
    </form>
  );
}

function Mfa({ user, onDone, onLogout }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await post("/api/auth/mfa", { code }); await onDone(); }
    catch (e2) { setErr(e2.message); setBusy(false); setCode(""); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h2>Verification code</h2>
      <p className="sub">Signed in as {user.email}. Enter the 6-digit code from your authenticator app.</p>
      <ErrorBox error={err} />
      <Field><div className="codebox"><input inputMode="numeric" pattern="[0-9]*" maxLength={6} autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></div></Field>
      <Btn variant="key" type="submit" className="block" disabled={busy || code.length !== 6}>Verify</Btn>
      <Btn variant="quiet" className="block" onClick={onLogout} icon="arrow-left">Use a different account</Btn>
    </form>
  );
}

function ChangePassword({ user, onDone, onLogout }) {
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    if (pw !== pw2) return setErr("The new passwords do not match.");
    setBusy(true);
    try { await post("/api/auth/password", { currentPassword: cur, newPassword: pw }); await onDone(); }
    catch (e2) { setErr(e2.message); setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h2>Set your password</h2>
      <p className="sub">Welcome, {user.name}. Replace the temporary password or PIN before continuing. Passwords need 10+ characters with letters and numbers; PINs are exactly 4 digits.</p>
      <ErrorBox error={err} />
      <Field label="Temporary password or PIN"><input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
      <Field label="New password or PIN"><input type="password" autoComplete="new-password" required minLength={4} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Field label="Confirm new password"><input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
      <Btn variant="key" type="submit" className="block" disabled={busy}>Save and continue</Btn>
      <Btn variant="quiet" className="block" onClick={onLogout}>Cancel</Btn>
    </form>
  );
}

function Reset({ token }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    if (pw !== pw2) return setErr("The passwords do not match.");
    setBusy(true);
    try { await post("/api/auth/reset", { token, newPassword: pw }); setDone(true); }
    catch (e2) { setErr(e2.message); setBusy(false); }
  };
  if (done) return (
    <div className="card"><h2>Password updated</h2><p className="sub">You can sign in with your new password now.</p><a className="btn key block" href="/login"><Icon name="login" />Go to sign in</a></div>
  );
  return (
    <form className="card" onSubmit={submit}>
      <h2>Choose a new password</h2>
      <p className="sub">At least 10 characters with letters and numbers.</p>
      <ErrorBox error={err} />
      <Field label="New password or PIN"><input type="password" autoComplete="new-password" required minLength={4} autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Field label="Confirm"><input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
      <Btn variant="key" type="submit" className="block" disabled={busy || !token}>Save password</Btn>
      {!token && <div className="error">This link is missing its token. Ask your administrator for a new one.</div>}
    </form>
  );
}
