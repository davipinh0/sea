/* Gerenciar Acessos no painel: dispositivos conectados, permissões e o nome do sistema. */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const apiGet = vi.fn();
const apiPost = vi.fn();
let currentUser;

vi.mock('../api.js', () => ({
  api: { get: (...a) => apiGet(...a), post: (...a) => apiPost(...a), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: currentUser, logout: vi.fn() }) }));

import MeusAcessos from '../pages/MeusAcessos.jsx';
import Login from '../pages/Login.jsx';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ok = (body) => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(body) });
const fail = (status, body) => Promise.resolve({ status, ok: false, json: () => Promise.resolve(body) });

const session = (id, device, extra = {}) => ({
  id, device, kind: device.startsWith('App') ? 'App' : 'Navegador', ip: '10.0.0.5',
  started_at: '2026-11-23T10:00:00Z', last_seen_at: '2026-11-23T11:00:00Z', current: false, ...extra,
});
const MINE = {
  all_locations: false, locations: [{ code: 'Expedição', name: 'Expedição' }],
  login_approval: true, devices: [{ device: 'SM-A155M', ending: 'aaa111', secure_lock: true, signed_in: true, updated_at: '2026-11-23T09:00:00Z' }],
  sessions: [
    session('aaaaaaaaaaaaaaaa', 'Chrome no Windows', { current: true }),
    session('bbbbbbbbbbbbbbbb', 'App SEA'),
    session('cccccccccccccccc', 'Firefox no Linux'),
  ],
};

beforeEach(() => {
  apiGet.mockReset().mockImplementation(() => ok(MINE));
  apiPost.mockReset();
  currentUser = { user_id: 5, username: 'fulano', role: 'USER', allowed_pages: ['inventory', 'retirada'], allowed_overrides: [], allowed_functions: ['receive'] };
});

describe('Gerenciar Acessos (painel)', () => {
  it('lists the connected devices and marks the one in use', async () => {
    render(<MemoryRouter><MeusAcessos /></MemoryRouter>);
    const row = (await screen.findByText('Chrome no Windows')).closest('tr');
    expect(within(row).getByText('Este aparelho')).toBeInTheDocument();
    expect(within(row).queryByText('Desconectar')).toBeNull();
    expect(screen.getByLabelText('Desconectar App SEA')).toBeInTheDocument();
    // Permissões e o celular que confirma login aparecem, mas só para leitura.
    expect(screen.getByText('Visão Geral')).toBeInTheDocument();
    expect(screen.getByText('Receber')).toBeInTheDocument();
    expect(screen.getByText(/SM-A155M \(…aaa111\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Remover/)).toBeNull();
  });

  it('asks before disconnecting one device and then reloads', async () => {
    apiPost.mockImplementation(() => ok({ ended: 1 }));
    render(<MemoryRouter><MeusAcessos /></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('Desconectar App SEA'));
    expect(apiPost).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Desconectar App SEA?');
    fireEvent.click(within(dialog).getByText('Desconectar'));
    await screen.findByText('1 aparelho desconectado.');
    expect(apiPost).toHaveBeenCalledWith('/sea/meus-acessos/sessoes/encerrar', { ids: ['bbbbbbbbbbbbbbbb'] });
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('disconnects every other device at once, never the current one', async () => {
    apiPost.mockImplementation(() => ok({ ended: 2 }));
    render(<MemoryRouter><MeusAcessos /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Desconectar todos os outros'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Desconectar'));
    await screen.findByText('2 aparelhos desconectados.');
    expect(apiPost).toHaveBeenCalledWith('/sea/meus-acessos/sessoes/encerrar', { ids: ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'] });
  });

  it('cancel keeps everything and an error is shown', async () => {
    apiPost.mockImplementation(() => fail(404, { error: 'Nenhuma das sessões escolhidas está conectada.', user_facing: true }));
    render(<MemoryRouter><MeusAcessos /></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('Desconectar Firefox no Linux'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancelar'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Desconectar Firefox no Linux'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Desconectar'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nenhuma das sessões escolhidas está conectada.');
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  it('is reached from the photo menu', () => {
    const topbar = readFileSync(resolve(SRC, 'components/TopBar.jsx'), 'utf8');
    expect(topbar).toMatch(/navigate\('\/acessos'\)/);
    expect(topbar).toMatch(/Gerenciar Acessos/);
  });
});

describe('Nome do sistema', () => {
  it('is SEA - Sistema de Entrada e Armazenamento', () => {
    const read = (p) => readFileSync(resolve(SRC, p), 'utf8');
    expect(read('../index.html')).toMatch(/<title>SEA - Sistema de Entrada e Armazenamento<\/title>/);
    expect(read('pages/Login.jsx')).toMatch(/Sistema de Entrada e Armazenamento/);
    for (const p of ['../index.html', 'pages/Login.jsx', 'pages/Settings.jsx']) {
      expect(read(p)).not.toMatch(/Expedição e Armazenamento/);
    }
  });

  it('login shows the app logo instead of the SEA text', () => {
    currentUser = null;
    render(<MemoryRouter><Login /></MemoryRouter>);
    const card = document.querySelector('.login-card');
    expect(within(card).getByRole('img', { name: 'SEA' })).toBeInTheDocument();
    expect(within(card).queryByText('SEA')).toBeNull();
    expect(within(card).getByText('Sistema de Entrada e Armazenamento')).toBeInTheDocument();
  });
});
