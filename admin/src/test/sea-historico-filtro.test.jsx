/* Filtro do histórico (log de auditoria): cada nome aparece uma vez e filtra todas as ações dele. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

import { ACTION_OPTIONS } from '../pages/AuditLog.jsx';

describe('Filtro de ações do histórico', () => {
  it('shows each label once and filters every action behind it', () => {
    const labels = ACTION_OPTIONS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
    const transfer = ACTION_OPTIONS.find((o) => o.label === 'Transferência entre endereços');
    expect(transfer.value.split(',').sort()).toEqual(['STOCK_TRANSFERRED', 'TRANSFER']);
    expect(ACTION_OPTIONS[0]).toEqual({ value: '', label: 'Todas as ações' });
  });
});
