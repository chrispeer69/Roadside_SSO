// React provider for a connected single-page app.
//   <AuthProvider issuer="https://sso.example.com" clientId="crew-app" redirectUri={location.origin + "/"}>
//     <App />
//   </AuthProvider>
//   const { user, ready, logout, getToken } = useAuth();
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createClient } from "./browser.js";

const Ctx = createContext(null);

export function AuthProvider({ issuer, clientId, redirectUri, scope, autoLogin = true, children }) {
  const client = useMemo(() => createClient({ issuer, clientId, redirectUri, scope }), [issuer, clientId, redirectUri, scope]);
  const [state, setState] = useState({ ready: false, user: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fromRedirect = await client.handleRedirect();
        const user = fromRedirect ?? (await client.getToken() ? client.getUser() : null);
        if (!user && autoLogin) return client.login();
        if (alive) setState({ ready: true, user, error: null });
      } catch (e) {
        if (alive) setState({ ready: true, user: null, error: e.message });
      }
    })();
    return () => { alive = false; };
  }, [client, autoLogin]);

  const value = useMemo(() => ({ ...state, login: client.login, logout: client.logout, getToken: client.getToken, fetch: client.fetch }), [state, client]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
