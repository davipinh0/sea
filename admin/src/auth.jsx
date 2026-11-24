import { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api.js';
import { friendlyError } from './utils/friendlyError.js';
import {
  ANOTHER_TAB_MESSAGE, DUPLICATE_MESSAGE, IDLE_MESSAGE, TAKEOVER_MESSAGE, announceLogout, announceTakeover,
  askOtherTabs, clearTabSession, hasTabSession,
  isDuplicateTab, listenOtherTabs, markTabSession, setLoginFlash, watchIdle,
} from './utils/sessionGuard.js';
import { isTerminalAccount } from './utils/permissions.js';

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
    // SEA (mig 093): the session belongs to the tab that signed in. The panel works in one tab at
    // a time: a tab duplicated by the browser, or a new tab opened with a copied link while the
    // panel is open in another tab, goes to the login without the session (and without the
    // processes released on the phone) and without ending the other tab. With no other panel tab
    // open, a reopened browser or a restored tab has its session ended here.
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/auth/me');
        if (cancelled || !res || !res.ok) return;
        const data = await res.json();
        if (hasTabSession()) {
          if (await isDuplicateTab()) {
            clearTabSession();
            setLoginFlash(DUPLICATE_MESSAGE);
            return;
          }
        } else if (await askOtherTabs()) {
          setLoginFlash(ANOTHER_TAB_MESSAGE);
          return;
        } else {
          await api.post('/auth/logout', {});
          return;
        }
        if (cancelled) return;
        markTabSession();
        setUser(data);
      } catch {
        // Falha de rede: fica na tela de login.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Página restaurada do cache do navegador mostra a tela antiga: recarrega para conferir a sessão
  // de novo.
  useEffect(() => {
    const onShow = (event) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const stopTabs = listenOtherTabs({
      onLogout: () => { clearTabSession(); setUser(null); },
      onTakeover: () => { clearTabSession(); setLoginFlash(TAKEOVER_MESSAGE); setUser(null); },
    });
    // O usuário do terminal não sai por inatividade, porque o terminal fica esperando o próximo
    // funcionário.
    const stopIdle = isTerminalAccount(user) ? () => {} : watchIdle({
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

  async function finishLogin(data) {
    // A resposta do login não traz as permissões; sem /auth/me o menu ficaria quase vazio até
    // recarregar.
    const me = await api.get('/auth/me');
    const full = me && me.ok ? await me.json() : data.user;
    markTabSession();
    announceTakeover();
    setUser(full);
    return full;
  }

  async function endSession() {
    clearTabSession();
    announceLogout();
    try {
      await api.post('/auth/logout', {});
    } catch {
      // Sem conexão: o servidor encerra a sessão sozinho quando ela fica inativa.
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
