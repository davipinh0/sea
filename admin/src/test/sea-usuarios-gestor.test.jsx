/*
 * Quem só tem a permissão "Usuários" não vê a opção de administrador, não age sobre
 * administradores e não mexe nas próprias permissões. Login acessível (rótulos ligados aos campos).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiGet = vi.fn();
const apiPut = vi.fn();
let currentUser = null;

vi.mock('../api.js', () => ({
  api: { get: (...a) => apiGet(...a), post: vi.fn(), put: (...a) => apiPut(...a), delete: vi.fn() },
}));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: currentUser, login: vi.fn() }) }));

import Users from '../pages/Users.jsx';
import Login from '../pages/Login.jsx';

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const ADMIN = { user_id: 1, username: 'admin', full_name: 'Administrador Fictício', role: 'ADMIN', is_active: true, warehouse_ids: [7] };
const GESTOR = { user_id: 5, username: 'gestor', full_name: 'Gestor Fictício', role: 'USER', is_active: true, warehouse_ids: [7] };
const COMUM = { user_id: 9, username: 'comum', full_name: 'Comum Fictício', role: 'USER', is_active: true, warehouse_ids: [7] };

beforeEach(() => {
  apiGet.mockReset();
  apiPut.mockReset();
  apiPut.mockImplementation(() => ok({}));
  apiGet.mockImplementation((path) => {
    if (path.startsWith('/admin/warehouses')) return ok({ warehouses: [{ warehouse_id: 7, warehouse_code: 'SP12', warehouse_name: 'SP12' }] });
    if (path.includes('/permissions')) return ok({ page_keys: ['users'] });
    if (path.includes('/aparelhos')) return ok({ devices: [] });
    return ok({ users: [ADMIN, GESTOR, COMUM] });
  });
});

describe('Usuários para quem não é administrador', () => {
  beforeEach(() => { currentUser = { ...GESTOR, allowed_pages: ['users'] }; });

  it('não mostra editar nem excluir num administrador', async () => {
    render(<Users />);
    await screen.findByText('Administrador Fictício');
    expect(screen.getAllByLabelText('Editar')).toHaveLength(2); // gestor e comum
    expect(screen.getAllByLabelText('Excluir')).toHaveLength(1); // só o comum
  });

  it('não oferece a função ADMIN', async () => {
    render(<Users />);
    fireEvent.click(await screen.findByText('Novo usuário'));
    await screen.findByLabelText('Usuário *');
    expect(screen.queryByLabelText('Função')).toBeNull();
    expect(screen.queryByRole('option', { name: 'ADMIN' })).toBeNull();
  });

  it('não mexe nas próprias permissões ao salvar o próprio cadastro', async () => {
    render(<Users />);
    await screen.findByText('Gestor Fictício');
    fireEvent.click(screen.getAllByLabelText('Editar')[0]);
    expect(await screen.findByText(/próprias permissões só podem ser mudadas por um administrador/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/admin/users/5', expect.objectContaining({ role: 'USER' })));
    expect(apiPut.mock.calls.some(([path]) => path.endsWith('/permissions'))).toBe(false);
  });
});

describe('Usuários para o administrador', () => {
  beforeEach(() => { currentUser = { ...ADMIN }; });

  it('continua escolhendo a função', async () => {
    render(<Users />);
    fireEvent.click(await screen.findByText('Novo usuário'));
    await screen.findByLabelText('Usuário *');
    expect(screen.getByLabelText('Função')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'ADMIN' })).toBeInTheDocument();
  });
});

describe('Login acessível', () => {
  it('os rótulos apontam para os campos', () => {
    currentUser = null;
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.getByLabelText('Usuário')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password');
  });
});
