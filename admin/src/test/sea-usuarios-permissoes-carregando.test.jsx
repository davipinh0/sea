// Auditoria de 27/11/2026: ao editar um usuário, as permissões chegam depois de a janela abrir. Antes,
// "Salvar" nesse intervalo regravava as permissões de quem tinha sido editado antes (ou nenhuma), e
// uma falha ao carregá-las deixava a lista vazia: salvar apagava todas.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
const apiPut = vi.fn();

vi.mock('../api.js', () => ({
  api: { get: (...a) => apiGet(...a), post: vi.fn(), put: (...a) => apiPut(...a), delete: vi.fn() },
}));
const ADMIN = { user_id: 1, username: 'admin', full_name: 'Administrador Fictício', role: 'ADMIN', is_active: true, warehouse_ids: [7] };
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: { ...ADMIN }, login: vi.fn() }) }));

import Users from '../pages/Users.jsx';

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
const ANA = { user_id: 21, username: 'ana', full_name: 'Ana Fictícia', role: 'USER', is_active: true, warehouse_ids: [7] };
const BRUNO = { user_id: 22, username: 'bruno', full_name: 'Bruno Fictício', role: 'USER', is_active: true, warehouse_ids: [7] };

let permissions;

beforeEach(() => {
  apiGet.mockReset();
  apiPut.mockReset();
  apiPut.mockImplementation(() => ok({}));
  permissions = {
    21: () => ok({ page_keys: ['settings', 'users'] }),
    22: () => ok({ page_keys: ['inventory'] }),
  };
  apiGet.mockImplementation((path) => {
    if (path.startsWith('/admin/warehouses')) return ok({ warehouses: [{ warehouse_id: 7, warehouse_code: 'SP12', warehouse_name: 'SP12' }] });
    const m = path.match(/^\/admin\/users\/(\d+)\/permissions/);
    if (m) return permissions[m[1]]();
    if (path.includes('/aparelhos')) return ok({ devices: [] });
    return ok({ users: [ADMIN, ANA, BRUNO] });
  });
});

function editButtonOf(name) {
  const row = screen.getByText(name).closest('tr');
  return row.querySelector('[aria-label="Editar"]');
}

describe('Editar usuário: permissões ainda carregando', () => {
  it('não salva antes de as permissões chegarem', async () => {
    let release;
    permissions[22] = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ page_keys: ['inventory'] }) }); });
    render(<Users />);
    await screen.findByText('Bruno Fictício');
    fireEvent.click(editButtonOf('Bruno Fictício'));
    const button = await screen.findByText('Carregando…');
    expect(button.closest('button')).toBeDisabled();
    fireEvent.click(button);
    expect(apiPut).not.toHaveBeenCalled();
    release();
    fireEvent.click(await screen.findByText('Salvar'));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/admin/users/22/permissions', { page_keys: ['inventory'] }));
  });

  it('não reaproveita as permissões de quem foi editado antes', async () => {
    let release;
    render(<Users />);
    await screen.findByText('Ana Fictícia');
    fireEvent.click(editButtonOf('Ana Fictícia'));
    await screen.findByText('Salvar'); // as permissões da Ana carregaram
    fireEvent.click(screen.getByText('Cancelar'));
    permissions[22] = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ page_keys: ['inventory'] }) }); });
    fireEvent.click(editButtonOf('Bruno Fictício'));
    // Clique logo depois de abrir, com as permissões do Bruno ainda a caminho.
    fireEvent.click(await screen.findByText(/^(Salvar|Carregando…)$/));
    await new Promise((r) => { setTimeout(r, 50); });
    const sentAna = apiPut.mock.calls.some(
      ([path, body]) => path === '/admin/users/22/permissions' && body.page_keys.includes('settings'),
    );
    expect(sentAna).toBe(false);
    release();
    fireEvent.click(await screen.findByText('Salvar'));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/admin/users/22/permissions', { page_keys: ['inventory'] }));
  });

  it('falha ao carregar as permissões: avisa e não salva', async () => {
    permissions[22] = fail;
    render(<Users />);
    await screen.findByText('Bruno Fictício');
    fireEvent.click(editButtonOf('Bruno Fictício'));
    expect(await screen.findByText(/Não foi possível carregar as permissões/)).toBeInTheDocument();
    expect(screen.getByText('Carregando…').closest('button')).toBeDisabled();
    expect(apiPut).not.toHaveBeenCalled();
  });
});
