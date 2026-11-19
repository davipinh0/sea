import { describe, it, expect } from 'vitest';
import { actionLabel, authText, canSeeHistory, describeMovement, orderText } from '../history';
import { IDENTITY_WINDOW_MS, identityHeaders, markIdentityConfirmed } from '../../auth/identityProof';
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
      .toBe('Material MAT-1 · quantidade 2 · destino A3');
  });

  it('names the order, never the OT', () => {
    expect(orderText({ orders: ['PM12 - 2002349234'], details: { ot: '1003307220' } })).toBe('Ordem PM12 - 2002349234');
    expect(orderText({ orders: ['PM11 - 1', 'PM12 - 2'] })).toBe('Ordens PM11 - 1, PM12 - 2');
    expect(orderText({ orders: [] })).toBeNull();
    expect(describeMovement({ details: { ot: '1003307220', employee_name: 'Davi' } })).not.toContain('1003307220');
  });

  it('translates every operation, with no English left', () => {
    expect(actionLabel('WITHDRAWAL_APPROVED')).toBe('Retirada aprovada');
    expect(actionLabel('PROCESS_APPROVED')).toBe('Processo liberado no celular');
    expect(actionLabel('WITHDRAWAL_SOMETHING_UPDATED')).toBe('Retirada something alterado');
  });

  it('says when the user was authenticated', () => {
    expect(authText({ details: { autenticacao: 'Digital/PIN no app' } })).toBe('Usuário autenticado (Digital/PIN no app)');
    expect(authText({ details: {} })).toBeNull();
  });

  it('tells the API about a recent fingerprint/PIN only', () => {
    markIdentityConfirmed(1000);
    expect(identityHeaders(1000 + IDENTITY_WINDOW_MS)).toEqual({ 'X-SEA-Identidade': 'digital-pin' });
    expect(identityHeaders(1001 + IDENTITY_WINDOW_MS)).toEqual({});
  });
});
