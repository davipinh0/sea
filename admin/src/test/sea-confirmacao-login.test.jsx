/**
 * SEA (mig 092): the web login waits for the confirmation on the phone.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
const login = vi.fn();
const finishLogin = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
    put: vi.fn(),
    delete: (...a) => apiDelete(...a),
  },
}));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: null, login, finishLogin }) }));

import { LoginApprovalCancelled, waitForApproval } from '../utils/loginApproval.js';
import Login from '../pages/Login.jsx';
import LoginApprovalField from '../components/LoginApprovalField.jsx';

const response = (status, body) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });
const CHALLENGE = { approval_required: true, challenge_id: 'c-1', poll_token: 'segredo', expires_in: 120 };

describe('waitForApproval', () => {
  it('asks until the phone confirms and returns the session', async () => {
    const post = vi.fn()
      .mockReturnValueOnce(response(202, { status: 'PENDING', expires_in: 100 }))
      .mockReturnValueOnce(response(200, { token: 't', user: { user_id: 1 } }));
    const ticks = [];
    const session = await waitForApproval(post, CHALLENGE, { intervalMs: 1, onTick: (s) => ticks.push(s) });
    expect(session.token).toBe('t');
    expect(ticks).toEqual([100]);
    expect(post).toHaveBeenCalledWith('/auth/login/aprovacao', { challenge_id: 'c-1', poll_token: 'segredo' });
  });

  it.each([
    [403, 'negado no celular'],
    [410, 'tempo para confirmar acabou'],
    [404, 'não encontrada'],
  ])('explains the end of the wait (%s)', async (status, message) => {
    const post = () => response(status, {});
    await expect(waitForApproval(post, CHALLENGE, { intervalMs: 1 })).rejects.toThrow(message);
  });

  it('stops when the user cancels', async () => {
    const post = vi.fn(() => response(202, { expires_in: 90 }));
    let cancel = false;
    const waiting = waitForApproval(post, CHALLENGE, { intervalMs: 1, onTick: () => { cancel = true; }, isCancelled: () => cancel });
    await expect(waiting).rejects.toBeInstanceOf(LoginApprovalCancelled);
  });
});

describe('Login do painel com confirmação no celular', () => {
  beforeEach(() => {
    login.mockReset(); finishLogin.mockReset(); apiPost.mockReset();
  });

  function submit() {
    render(<MemoryRouter><Login /></MemoryRouter>);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'caique' } });
    fireEvent.change(document.querySelector('input[type=password]'), { target: { value: 'Senha123' } });
    fireEvent.click(screen.getByText('Entrar'));
  }

  it('shows the waiting screen and enters after the phone confirms', async () => {
    login.mockResolvedValue({ approval: CHALLENGE });
    let release;
    apiPost.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    finishLogin.mockResolvedValue({ user_id: 1, role: 'ADMIN' });
    submit();
    expect(await screen.findByText('Confirme no seu celular')).toBeInTheDocument();
    expect(screen.getByText('Tempo restante: 2:00')).toBeInTheDocument();
    release({ status: 200, ok: true, json: () => Promise.resolve({ token: 't', user: { user_id: 1 } }) });
    await waitFor(() => expect(finishLogin).toHaveBeenCalledWith({ token: 't', user: { user_id: 1 } }));
  });

  it('shows why the login did not go through when the phone denies', async () => {
    login.mockResolvedValue({ approval: CHALLENGE });
    apiPost.mockImplementation(() => response(403, { status: 'DENIED' }));
    submit();
    expect(await screen.findByText('O acesso foi negado no celular.')).toBeInTheDocument();
    expect(finishLogin).not.toHaveBeenCalled();
  });
});

describe('Sistema > Usuários: confirmar login no celular', () => {
  beforeEach(() => { apiGet.mockReset(); apiDelete.mockReset(); });

  it('lists the phones without showing their token and removes them', async () => {
    apiGet.mockImplementation(() => response(200, { devices: [
      { device: 'SM-S711B', ending: 'abc123', secure_lock: true, signed_in: true, updated_at: '2026-11-18T10:00:00Z' },
    ] }));
    apiDelete.mockImplementation(() => response(200, { removed: 1 }));
    const onToggle = vi.fn();
    render(<LoginApprovalField userId={3} enabled onToggle={onToggle} />);
    expect(await screen.findByText(/SM-S711B \(…abc123\)/)).toBeInTheDocument();
    expect(screen.getByText('bloqueio ativo: confirma logins')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Confirmar login no celular'));
    expect(onToggle).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('Remover celulares (perdido ou trocado)'));
    fireEvent.click(screen.getByText('Remover'));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/admin/users/3/aparelhos'));
    expect(await screen.findByText(/Aparelhos removidos/)).toBeInTheDocument();
  });

  it('warns when the user has no phone yet', async () => {
    apiGet.mockImplementation(() => response(200, { devices: [] }));
    render(<LoginApprovalField userId={3} enabled onToggle={() => {}} />);
    expect(await screen.findByText(/por enquanto o login segue só com a senha/)).toBeInTheDocument();
  });
});

describe('Terminal de retirada com confirmação no celular', () => {
  it('waits for the phone and then opens the session', async () => {
    vi.resetModules();
    const calls = [];
    globalThis.fetch = vi.fn((url, opts) => {
      calls.push([url, opts?.method || 'GET']);
      if (url.endsWith('/auth/login')) return response(202, CHALLENGE);
      if (url.endsWith('/auth/login/aprovacao')) {
        return calls.filter(([u]) => u.endsWith('/aprovacao')).length === 1
          ? response(202, { status: 'PENDING', expires_in: 110 })
          : response(200, { token: 'tk', user: { user_id: 9 } });
      }
      if (url.endsWith('/auth/me')) return response(200, { user_id: 9, role: 'USER', allowed_pages: ['retirada'] });
      return response(404, {});
    });
    const { terminalLogin } = await import('../terminalApi.js');
    const waits = [];
    const session = await terminalLogin('caique', 'Senha123', { onWaiting: (s) => waits.push(s) });
    expect(session.token).toBe('tk');
    expect(waits[0]).toBe(120);
    expect(waits).toContain(110);
    // The terminal never stores cookies, also while waiting.
    expect(globalThis.fetch.mock.calls.every(([, opts]) => opts.credentials === 'omit')).toBe(true);
  }, 10000);
});
