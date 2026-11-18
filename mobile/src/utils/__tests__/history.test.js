import { describe, it, expect } from 'vitest';
import { actionLabel, canSeeHistory, describeMovement } from '../history';
import { visibleModules } from '../sea';

describe('Histórico in the app', () => {
  it('is for administrators and users granted "Histórico"', () => {
    expect(canSeeHistory({ role: 'ADMIN' })).toBe(true);
    expect(canSeeHistory({ role: 'USER', allowed_pages: ['audit-log'] })).toBe(true);
    expect(canSeeHistory({ role: 'USER', allowed_pages: ['retirada'] })).toBe(false);
    expect(canSeeHistory(null)).toBe(false);
  });

  it('shows the HISTÓRICO module only to them', () => {
    const keys = (me) => visibleModules(me, 'SP12').map((m) => m.key);
    expect(keys({ role: 'USER', allowed_pages: ['audit-log'] })).toContain('historico');
    expect(keys({ role: 'USER', allowed_pages: ['retirada'] })).not.toContain('historico');
  });

  it('reads movements in the operator words', () => {
    expect(actionLabel('PUTAWAY')).toBe('Armazenagem');
    expect(actionLabel('ALGO_NOVO')).toBe('Algo novo');
    expect(describeMovement({ details: { ot: 'OT-1', sku: 'MAT-1', quantity: 2, to_bin_code: 'A3' } }))
      .toBe('OT-1 · MAT-1 · 2 un. · → A3');
  });
});
