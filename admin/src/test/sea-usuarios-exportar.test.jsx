/**
 * SEA: the "Exportar CSV" grant and the user form telling the operator
 * exactly what is missing or wrong.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
let currentUser = null;

vi.mock('../api.js', () => ({
  api: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
    put: (...a) => apiPut(...a),
    delete: vi.fn(),
  },
}));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: currentUser }) }));

import DataTable from '../components/DataTable.jsx';
import Users from '../pages/Users.jsx';
import { canExportCsv } from '../utils/permissions.js';
import Layout from '../components/Layout.jsx';
import TransferirEstoque from '../components/TransferirEstoque.jsx';

vi.mock('../components/TopBar.jsx', () => ({ default: () => null }));
vi.mock('../components/Sidebar.jsx', () => ({ default: () => null }));
vi.mock('../utils/newVersion.js', () => ({ reloadIfNewVersion: () => {} }));

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = (status, body) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });

function table() {
  return render(
    <DataTable
      columns={[{ key: 'sku', label: 'Código' }]} data={[{ sku: 'A' }]}
      pagination={{ page: 1, pages: 1, total: 1 }} onPageChange={() => {}}
    />,
  );
}

describe('Permissão Exportar CSV', () => {
  it('is held by administrators and by users with the grant only', () => {
    expect(canExportCsv({ role: 'ADMIN' })).toBe(true);
    expect(canExportCsv({ role: 'USER', allowed_overrides: ['export-csv'] })).toBe(true);
    expect(canExportCsv({ role: 'USER', allowed_overrides: [] })).toBe(false);
    expect(canExportCsv({ role: 'USER', allowed_pages: ['inventory'] })).toBe(false);
    expect(canExportCsv(null)).toBe(false);
  });

  it('hides the button of every list from a user without the grant', () => {
    currentUser = { role: 'USER', allowed_pages: ['inventory'], allowed_overrides: [] };
    table();
    expect(screen.queryByText('Exportar CSV')).toBeNull();
  });

  it('shows the button to a user with the grant', () => {
    currentUser = { role: 'USER', allowed_pages: ['inventory'], allowed_overrides: ['export-csv'] };
    table();
    expect(screen.getByText('Exportar CSV')).toBeInTheDocument();
  });
});

describe('Cadastro de usuário', () => {
  beforeEach(() => {
    currentUser = { user_id: 1, role: 'ADMIN' };
    apiGet.mockReset();
    apiPost.mockReset();
    apiPut.mockReset();
    apiGet.mockImplementation((path) => (path.startsWith('/admin/warehouses')
      ? ok({ warehouses: [{ warehouse_id: 7, warehouse_code: 'SP12', warehouse_name: 'Prateleiras' }] })
      : ok({ users: [] })));
    apiPut.mockImplementation(() => ok({}));
  });

  async function openForm() {
    render(<Users />);
    fireEvent.click(screen.getByText('Novo usuário'));
    await screen.findByText('SP12');
  }

  function fill({ username, name, password }) {
    if (username != null) fireEvent.change(screen.getByLabelText('Usuário *'), { target: { value: username } });
    if (name != null) fireEvent.change(screen.getByLabelText('Nome completo *'), { target: { value: name } });
    if (password != null) fireEvent.change(screen.getByLabelText('Senha *'), { target: { value: password } });
  }

  it('lists every missing field and sends nothing', async () => {
    await openForm();
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText('O usuário não foi salvo. Corrija:')).toBeInTheDocument();
    expect(screen.getByText('Informe o nome de usuário.')).toBeInTheDocument();
    expect(screen.getByText('Informe o nome completo.')).toBeInTheDocument();
    expect(screen.getAllByText(/Informe a senha\./).length).toBeGreaterThan(0);
    expect(screen.getByText('Selecione pelo menos um local.')).toBeInTheDocument();
    expect(screen.getAllByText(/Selecione pelo menos uma página do painel/).length).toBeGreaterThan(0);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it.each([
    ['abc1', /tem 4 caractere\(s\) e precisa de pelo menos 8/],
    ['12345678', /falta pelo menos uma letra/],
    ['abcdefgh', /falta pelo menos um número/],
    ['admin', /não pode ser 'admin'/],
  ])('says why the password %s is too weak', async (password, message) => {
    await openForm();
    fill({ username: 'novo', name: 'Novo Usuário', password });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('flags an invalid e-mail', async () => {
    await openForm();
    fill({ username: 'novo', name: 'Novo', password: 'Senha1234' });
    fireEvent.change(screen.getByLabelText('E-mail corporativo'), { target: { value: 'sem-arroba' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(screen.getAllByText(/E-mail inválido/).length).toBeGreaterThan(0));
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('saves a complete form, with the Exportar CSV grant', async () => {
    apiPost.mockImplementation(() => ok({ user_id: 9 }));
    await openForm();
    fill({ username: ' novo ', name: 'Novo Usuário', password: 'Senha1234' });
    fireEvent.click(screen.getByLabelText(/SP12/));
    fireEvent.click(screen.getByLabelText('Visão Geral'));
    fireEvent.click(screen.getByLabelText('Exportar CSV'));
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/admin/users', expect.objectContaining({ username: 'novo', warehouse_ids: [7] }));
    expect(apiPut).toHaveBeenCalledWith('/admin/users/9/permissions', { page_keys: ['inventory', 'export-csv'] });
  });

  it('explains a refusal from the API on the right field', async () => {
    apiPost.mockImplementation(() => fail(400, { error: 'Nome de usuário duplicado: novo' }));
    await openForm();
    fill({ username: 'novo', name: 'Novo Usuário', password: 'Senha1234' });
    fireEvent.click(screen.getByLabelText(/SP12/));
    fireEvent.click(screen.getByLabelText('Visão Geral'));
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(screen.getAllByText(/Já existe um usuário com esse nome/).length).toBeGreaterThan(0));
  });
});

describe('Erro de permissão', () => {
  function Where() {
    return <div data-testid="where">{useLocation().pathname}</div>;
  }

  async function denyAt(path) {
    currentUser = { role: 'USER', allowed_pages: ['inventory'] };
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route element={<Layout />}><Route path="*" element={<Where />} /></Route></Routes>
      </MemoryRouter>,
    );
    act(() => { window.dispatchEvent(new CustomEvent('sea:permission-denied', { detail: { page_key: 'zones' } })); });
    // The permission is named as the operator knows it, not by its key.
    expect(await screen.findByText(/Estoque > Endereços/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('OK'));
  }

  it('OK takes the user to the first option of the section they are in', async () => {
    await denyAt('/estoque/enderecos');
    expect(screen.getByTestId('where')).toHaveTextContent('/estoque');
    expect(screen.getByTestId('where')).not.toHaveTextContent('enderecos');
  });

  it('OK takes the user to the Painel outside the sections', async () => {
    await denyAt('/settings');
    expect(screen.getByTestId('where').textContent).toBe('/');
  });
});

describe('Transferência entre endereços (Estoque > Materiais)', () => {
  const STOCK = [
    { inventory_id: 31, bin_id: 4, bin_code: 'A1', warehouse_id: 7, warehouse_code: 'SP12', stored: true, ot: 'OT-1', quantity_on_hand: 10, quantity_allocated: 2, available: 8, uom: 'PC', pack_weight_kg: null },
    { inventory_id: 32, bin_id: 9, bin_code: 'SP12-RECEB', warehouse_id: 7, warehouse_code: 'SP12', stored: false, ot: 'OT-1', quantity_on_hand: 3, quantity_allocated: 0, available: 3, uom: 'PC', pack_weight_kg: null },
  ];
  const BINS = [
    { bin_id: 4, bin_code: 'A1', warehouse_id: 7, warehouse_code: 'SP12', warehouse_name: 'SP12' },
    { bin_id: 5, bin_code: 'B2', warehouse_id: 7, warehouse_code: 'SP12', warehouse_name: 'SP12' },
    { bin_id: 6, bin_code: 'SOLDA', warehouse_id: 8, warehouse_code: 'Solda', warehouse_name: 'Contêiner de Solda' },
  ];

  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiGet.mockImplementation((path) => (path.startsWith('/sea/armazenagem/destinos') ? ok({ bins: BINS }) : ok({ stock: STOCK })));
  });

  it('moves stored material to another shelf or another location', async () => {
    apiPost.mockImplementation(() => ok({ sku: 'MAT-1', quantity: 5, from: 'SP12 · A1', to: 'Solda · SOLDA' }));
    render(<TransferirEstoque itemId={21} />);
    // Material still in the receiving area is not transferred from here.
    fireEvent.click(await screen.findByLabelText('Transferir de SP12 · A1'));
    expect(screen.queryByLabelText('Transferir de SP12 · SP12-RECEB')).toBeNull();

    // Destinations of every location, without the address the stock is in.
    const options = Array.from(screen.getByLabelText('Destino').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Escolha o endereço', 'SP12 · B2', 'Solda · SOLDA']);
    expect(screen.getByText(/2 reservado\(s\) para retirada não podem ser movidos/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Confirmar transferência'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Escolha o endereço de destino.');
    fireEvent.change(screen.getByLabelText('Destino'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Quantidade (PC)'), { target: { value: '9' } });
    fireEvent.click(screen.getByText('Confirmar transferência'));
    expect(await screen.findByRole('alert')).toHaveTextContent('maior que o saldo livre (8)');
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Quantidade (PC)'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('Confirmar transferência'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/transferencias', { inventory_id: 31, to_bin_id: 6, quantity: 5 }));
    expect(await screen.findByRole('status')).toHaveTextContent('transferido(s) de SP12 · A1 para Solda · SOLDA');
  });

  it('shows the reason when the API refuses the move', async () => {
    apiPost.mockImplementation(() => fail(409, { error: 'O endereço A2 é reservado a materiais de tamanho GRANDE.', user_facing: true }));
    render(<TransferirEstoque itemId={21} />);
    fireEvent.click(await screen.findByLabelText('Transferir de SP12 · A1'));
    fireEvent.change(screen.getByLabelText('Destino'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('Confirmar transferência'));
    expect(await screen.findByRole('alert')).toHaveTextContent('reservado a materiais de tamanho GRANDE');
  });
});
