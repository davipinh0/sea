/*
 * Últimas movimentações no Painel: só para quem pode ver o histórico; "Ocultar" recolhe e "Limpar"
 * recomeça a lista do usuário.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../api.js', () => ({
  api: { get: (...a) => apiGet(...a), post: (...a) => apiPost(...a) },
}));
vi.mock('../warehouse.jsx', () => ({
  useWarehouse: () => ({ warehouseId: 7, warehouse: { warehouse_code: 'SP12', warehouse_name: 'Setor SP12' } }),
}));

const { default: Painel } = await import('../pages/Painel.jsx');

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const BASE = {
  ots: {}, withdrawals: {}, staging_units: 0, staging_ots: 0, stored_units: 0, occupied_bins: 0, storage_bins: 0,
};
const MOVE = { log_id: 1, action_type: 'SEA_RECEIVE', user: 'caique', details: { reason: 'teste' }, created_at: '2026-11-18T10:00:00Z' };

function renderPainel() {
  return render(<MemoryRouter><Painel /></MemoryRouter>);
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset().mockImplementation(() => ok({}));
  localStorage.clear();
});

describe('Últimas movimentações', () => {
  it('is not shown to a user without "Histórico"', async () => {
    apiGet.mockImplementation(() => ok({ ...BASE, recent: null }));
    renderPainel();
    await screen.findByText('Recebimento e armazenagem');
    expect(screen.queryByText('Últimas movimentações')).toBeNull();
  });

  it('folds with Ocultar and remembers it', async () => {
    apiGet.mockImplementation(() => ok({ ...BASE, recent: [MOVE] }));
    renderPainel();
    await screen.findByText('caique');
    fireEvent.click(screen.getByText('Ocultar'));
    expect(screen.queryByText('caique')).toBeNull();
    expect(localStorage.getItem('sea_painel_movimentacoes_ocultas')).toBe('1');
    fireEvent.click(screen.getByText('Mostrar'));
    expect(screen.getByText('caique')).toBeInTheDocument();
  });

  it('Limpar asks the API and offers to show everything again', async () => {
    let cleared = null;
    apiGet.mockImplementation(() => ok({ ...BASE, recent: cleared ? [] : [MOVE], recent_cleared_at: cleared }));
    apiPost.mockImplementation((path) => {
      if (path.endsWith('/limpar')) cleared = '2026-11-18T11:00:00Z';
      if (path.endsWith('/restaurar')) cleared = null;
      return ok({});
    });
    renderPainel();
    await screen.findByText('caique');
    fireEvent.click(screen.getByText('Limpar'));
    await screen.findByText(/Lista limpa em/);
    expect(apiPost).toHaveBeenCalledWith('/sea/painel/movimentacoes/limpar', {});
    expect(screen.queryByText('caique')).toBeNull();
    fireEvent.click(screen.getByText('Mostrar tudo de novo'));
    await waitFor(() => expect(screen.getByText('caique')).toBeInTheDocument());
  });
});
