/* O log mostra a autenticação, a ordem (PM12 - número) e nenhuma operação em inglês. */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { actionLabel } from '../utils/sea.js';

const apiGet = vi.fn();
vi.mock('../api.js', () => ({ api: { get: (...a) => apiGet(...a), post: vi.fn() } }));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: { role: 'ADMIN' } }) }));
vi.mock('../warehouse.jsx', () => ({ useWarehouse: () => ({ warehouseId: 1, warehouses: [] }) }));

const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });

describe('Log do painel', () => {
  it('translates every operation', () => {
    expect(actionLabel('WITHDRAWAL_APPROVED')).toBe('Retirada aprovada');
    expect(actionLabel('PO_LINE_ADDED')).toBe('Material adicionado à ordem');
    expect(actionLabel('WITHDRAWAL_SOMETHING_UPDATED')).not.toMatch(/withdrawal/i);
  });

  it('marks the authenticated operations and names the order', async () => {
    apiGet.mockImplementation(() => ok({
      entries: [
        { log_id: 1, action_type: 'RECEIVE', entity_type: 'PO', username: 'davi', created_at: '2026-11-19T10:00:00Z',
          orders: ['PM12 - 2002349234'], details: { quantity: 2, autenticacao: 'Digital/PIN no app' } },
        { log_id: 2, action_type: 'WITHDRAWAL_REQUESTED', entity_type: 'WITHDRAWAL', username: 'ana', created_at: '2026-11-19T10:01:00Z',
          orders: [], details: { ot: '1003307220' } },
      ],
      total: 2, page: 1, per_page: 50, pages: 1,
    }));
    const { default: AuditLog } = await import('../pages/AuditLog.jsx');
    render(<MemoryRouter><AuditLog /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Log de auditoria' }));
    expect(await screen.findByText('Usuário autenticado (Digital/PIN no app)')).toBeInTheDocument();
    expect(screen.getByText('Ordem PM12 - 2002349234')).toBeInTheDocument();
    expect(screen.getAllByText(/Usuário autenticado/)).toHaveLength(1);
  });
});
