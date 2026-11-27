// Configurações > Local: a tela lia a resposta de GET /admin/warehouses/:id como se fosse o próprio
// local, mas a API responde { warehouse, zones }. Nome e código apareciam vazios, a edição começava
// em branco e, depois de recarregar, parecia que nada tinha sido salvo.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = (status, body) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });

const WAREHOUSE = {
  warehouse_id: 1, warehouse_code: 'SP12', warehouse_name: 'Almoxarifado Central',
  address: 'Galpão 1', is_active: true, created_at: null,
};

vi.mock('../api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../warehouse.jsx', () => ({
  useWarehouse: () => ({ warehouseId: 1, warehouse: { warehouse_id: 1 } }),
}));

import { api } from '../api.js';
import Settings from '../pages/Settings.jsx';

function mount() {
  return render(<MemoryRouter><Settings /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((path) => {
    if (path === '/admin/warehouses/1') return ok({ warehouse: WAREHOUSE, zones: [] });
    if (path.startsWith('/admin/bins')) return ok({ bins: [] });
    return ok({});
  });
});

describe('Configurações > Local', () => {
  it('shows the saved name, code and address from the API response', async () => {
    mount();
    expect(await screen.findByText('Almoxarifado Central')).toBeTruthy();
    expect(screen.getByText('SP12')).toBeTruthy();
    expect(screen.getByText('Galpão 1')).toBeTruthy();
  });

  it('starts editing with the current values and saves the change', async () => {
    api.put.mockImplementation(() => ok({ ...WAREHOUSE, address: 'Galpão 2' }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));

    const name = screen.getByLabelText('Nome');
    const address = screen.getByLabelText('Localização');
    expect(name.value).toBe('Almoxarifado Central');
    expect(address.value).toBe('Galpão 1');

    fireEvent.change(address, { target: { value: 'Galpão 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      '/admin/warehouses/1', { warehouse_name: 'Almoxarifado Central', address: 'Galpão 2' },
    ));
    expect(await screen.findByText('Galpão 2')).toBeTruthy();
    expect(screen.queryByLabelText('Localização')).toBeNull();
  });

  it('keeps the form open and shows the error when saving fails', async () => {
    api.put.mockImplementation(() => fail(428, { error: 'Informe o motivo da alteração' }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Localização'), { target: { value: 'Galpão 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Informe o motivo da alteração');
    expect(screen.getByLabelText('Localização').value).toBe('Galpão 3');
  });

  it('cancel discards the unsaved edit', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Localização'), { target: { value: 'Rascunho' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    expect(screen.getByLabelText('Localização').value).toBe('Galpão 1');
  });
});
