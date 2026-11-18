import { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api.js';
import { friendlyError } from './utils/friendlyError.js';
import {
  IDLE_MESSAGE, announceLogout, askOtherTabs, clearTabSession, hasTabSession,
  listenOtherTabs, markTabSession, setLoginFlash, watchIdle,
} from './utils/sessionGuard.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // V-045: session lives in an HttpOnly cookie; there is no token in
    // localStorage to read. Ask the API who we are. If the cookie is
    // missing or expired, /auth/me returns 401 and we stay unauthenticated.
    //
    // Page permissions (mig 061): USER role is now a first-class web-admin
    // identity (gated per page via user_page_permissions). The previous
    // role === 'ADMIN' guard would silently drop a valid USER session
    // and force them back to the login screen.
    //
    // SEA (mig 093): the session belongs to the tab that signed in. A new
    // tab, a reopened browser or a restored tab only keeps it when another
    // open panel tab vouches for it; otherwise it is ended here.
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/auth/me');
        if (cancelled || !res || !res.ok) return;
        const data = await res.json();
        if (!hasTabSession() && !(await askOtherTabs())) {
          await api.post('/auth/logout', {});
          return;
        }
        if (cancelled) return;
        markTabSession();
        setUser(data);
      } catch {
        // Network failure: stay on the login screen.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // A page restored from the browser's back/forward cache keeps the old
  // screen in memory: reload so the session is checked again.
  useEffect(() => {
    const onShow = (event) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  // While signed in: answer other tabs, follow their "Sair", and end the
  // session after IDLE_LIMIT_MS without use.
  useEffect(() => {
    if (!user) return undefined;
    const stopTabs = listenOtherTabs({
      onLogout: () => { clearTabSession(); setUser(null); },
    });
    const stopIdle = watchIdle({
      onIdle: async () => {
        setLoginFlash(IDLE_MESSAGE);
        await endSession();
        window.location.replace('/login');
      },
      onKeepAlive: () => { api.get('/auth/me').catch(() => {}); },
    });
    return () => { stopTabs(); stopIdle(); };
  }, [user]);

  // Re-fetch /auth/me. Used after change-password to pick up the cleared
  // must_change_password flag so the router guard lets the user out of
  // the forced-change screen.
  async function refreshUser() {
    const res = await api.get('/auth/me');
    if (res && res.ok) {
      const data = await res.json();
      setUser(data);
      return data;
    }
    return null;
  }

  async function login(username, password) {
    const res = await api.post('/auth/login', { username, password });
    // SEA (mig 092): the password is right but the login waits for the
    // confirmation in the app of the user's phone.
    if (res && res.status === 202) {
      return { approval: await res.json() };
    }
    if (!res || !res.ok) {
      const data = res ? await res.json().catch(() => ({})) : {};
      // V-021: never echo the raw backend error string to the user.
      throw new Error(friendlyError(data, 'Falha no login. Tente novamente.'));
    }
    return finishLogin(await res.json());
  }

  // Session open (cookies set by the API): load the full user.
  async function finishLogin(data) {
    // Page permissions (mig 061): USERs are allowed into the admin shell.
    // Per-page permissions decide what they can actually do; the
    // sidebar hides ungranted pages and the api gate returns 403 for
    // direct URL hits. Any user with valid credentials proceeds.
    //
    // The login response does not carry the page grants; /auth/me does.
    // Without them a USER would see an almost empty menu until the page
    // was reloaded.
    const me = await api.get('/auth/me');
    const full = me && me.ok ? await me.json() : data.user;
    markTabSession();
    setUser(full);
    return full;
  }

  // Ends the session on the server and in every open panel tab.
  async function endSession() {
    clearTabSession();
    announceLogout();
    try {
      await api.post('/auth/logout', {});
    } catch {
      // Offline: the server still ends the session when it goes idle.
    }
  }

  async function logout() {
    try {
      await endSession();
    } finally {
      setUser(null);
    }
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, finishLogin, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
