/*
 * A sessão do painel pertence à aba aberta.
 * Regressão: fechar a aba ou o navegador e abrir o painel de novo entrava direto, sem login.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from '../auth.jsx';
import {
  IDLE_MESSAGE, TAB_KEY, askOtherTabs, hasTabSession, listenOtherTabs, markTabSession, watchIdle,
} from '../utils/sessionGuard.js';

const ME = { user_id: 1, username: 'admin', full_name: 'Admin', role: 'ADMIN', allowed_pages: [] };

function response(status, body) {
  return Promise.resolve({
    status, ok: status >= 200 && status < 300,
    json: async () => body, clone() { return this; },
  });
}

function stubFetch(meStatus = 200) {
  const fetchSpy = vi.fn((url) => {
    if (url.endsWith('/auth/me')) return response(meStatus, meStatus === 200 ? ME : { error: 'Unauthorized' });
    return response(200, {});
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function Who() {
  const { user, loading } = useAuth();
  if (loading) return <p>carregando</p>;
  return <p>{user ? `logado:${user.username}` : 'deslogado'}</p>;
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <AuthProvider><Who /></AuthProvider>
    </MemoryRouter>,
  );
}

const calledLogout = (spy) => spy.mock.calls.some(([u, o]) => u.endsWith('/auth/logout') && o.method === 'POST');

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('opening the panel', () => {
  it('a new tab (or reopened browser) does not inherit the session', async () => {
    const fetchSpy = stubFetch(200);
    renderPanel();
    await waitFor(() => expect(screen.getByText('deslogado')).toBeInTheDocument());
    expect(calledLogout(fetchSpy)).toBe(true);
    expect(hasTabSession()).toBe(false);
  });

  it('the tab that signed in keeps its session on reload', async () => {
    markTabSession();
    const fetchSpy = stubFetch(200);
    renderPanel();
    await waitFor(() => expect(screen.getByText('logado:admin')).toBeInTheDocument());
    expect(calledLogout(fetchSpy)).toBe(false);
  });

  it('a new tab keeps the session when another panel tab is open', async () => {
    const other = new BroadcastChannel('sea-auth');
    other.onmessage = (event) => { if (event.data?.type === 'who') other.postMessage({ type: 'alive' }); };
    const fetchSpy = stubFetch(200);
    renderPanel();
    await waitFor(() => expect(screen.getByText('logado:admin')).toBeInTheDocument());
    expect(calledLogout(fetchSpy)).toBe(false);
    expect(sessionStorage.getItem(TAB_KEY)).toBe('1');
    other.close();
  });

  it('without a session cookie it simply shows the login', async () => {
    const fetchSpy = stubFetch(401);
    renderPanel();
    await waitFor(() => expect(screen.getByText('deslogado')).toBeInTheDocument());
    expect(calledLogout(fetchSpy)).toBe(false);
  });
});

describe('"Sair" in another tab', () => {
  it('signs this tab out too', async () => {
    markTabSession();
    stubFetch(200);
    renderPanel();
    await waitFor(() => expect(screen.getByText('logado:admin')).toBeInTheDocument());
    const other = new BroadcastChannel('sea-auth');
    other.postMessage({ type: 'logout' });
    await waitFor(() => expect(screen.getByText('deslogado')).toBeInTheDocument());
    expect(hasTabSession()).toBe(false);
    other.close();
  });
});

describe('askOtherTabs / listenOtherTabs', () => {
  it('only a tab holding the session answers', async () => {
    const stop = listenOtherTabs({ onLogout: () => {} });
    expect(await askOtherTabs(100)).toBe(false);
    markTabSession();
    expect(await askOtherTabs(300)).toBe(true);
    stop();
  });
});

describe('watchIdle', () => {
  it('ends the session after the limit without use and keeps it alive while used', () => {
    vi.useFakeTimers();
    let clock = 0;
    const onIdle = vi.fn();
    const onKeepAlive = vi.fn();
    watchIdle({ onIdle, onKeepAlive, limitMs: 3000, checkMs: 1000, now: () => clock });

    clock = 500;
    window.dispatchEvent(new Event('keydown'));
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(onKeepAlive).toHaveBeenCalledTimes(1);
    expect(onIdle).not.toHaveBeenCalled();

    clock = 2000;
    vi.advanceTimersByTime(1000);
    expect(onKeepAlive).toHaveBeenCalledTimes(1); // no new input, no new keep-alive

    clock = 3600;
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    clock = 9000;
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledTimes(1); // stopped after firing
  });
});

describe('server-side idle end', () => {
  it('the login screen explains why the session ended', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true, configurable: true });
    vi.stubGlobal('fetch', vi.fn(() => response(401, { error: 'Sessão encerrada por inatividade' })));
    const { api } = await import('../api.js');
    await api.get('/admin/dashboard');
    expect(window.location.href).toBe('/login');
    expect(sessionStorage.getItem('login_flash_message')).toBe(IDLE_MESSAGE);
    Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
  });
});

describe('withdrawal terminal', () => {
  it('ends its session on the server when the employee leaves', async () => {
    const fetchSpy = vi.fn(() => response(200, {}));
    vi.stubGlobal('fetch', fetchSpy);
    const { terminalLogout } = await import('../terminalApi.js');
    await act(() => terminalLogout('tk'));
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(opts.headers.Authorization).toBe('Bearer tk');
    expect(opts.credentials).toBe('omit');
  });
});
