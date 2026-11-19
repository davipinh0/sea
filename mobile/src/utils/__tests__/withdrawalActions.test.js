import { describe, it, expect } from 'vitest';
import { withdrawalActions } from '../sea';

const labels = (status, me) => withdrawalActions({ withdrawal_id: 7, status }, me).map((a) => a.label);
const user = (...pages) => ({ role: 'USER', allowed_pages: pages });

describe('withdrawalActions (mig 096)', () => {
  it('lets the evaluator approve or deny a new request', () => {
    expect(labels('REQUESTED', user('retirada-avaliar'))).toEqual(['APROVAR', 'NEGAR']);
    expect(labels('REQUESTED', user('retirada-fazer'))).toEqual([]);
  });

  it('lets who does withdrawals accept and finish an approved one', () => {
    expect(labels('APPROVED', user('retirada-fazer'))).toEqual(['ACEITAR E SEPARAR']);
    expect(labels('PICKING', user('retirada-fazer'))).toEqual(['PRONTA PARA ENTREGA']);
    expect(labels('APPROVED', user('retirada-avaliar'))).toEqual([]);
    expect(labels('APPROVED', user('retirada'))).toEqual([]);
  });

  it('gives an administrator every step', () => {
    expect(labels('REQUESTED', { role: 'ADMIN' })).toEqual(['APROVAR', 'NEGAR']);
    expect(labels('APPROVED', { role: 'ADMIN' })).toEqual(['ACEITAR E SEPARAR']);
  });

  it('once accepted, only who accepted carries it on (mig 098)', () => {
    const w = { withdrawal_id: 8, status: 'PICKING', picked_by: 'ana' };
    const doer = (username) => ({ username, role: 'USER', allowed_pages: ['retirada-fazer'] });
    expect(withdrawalActions(w, doer('ana')).map((a) => a.label)).toEqual(['PRONTA PARA ENTREGA']);
    expect(withdrawalActions(w, doer('bruno'))).toEqual([]);
  });

  it('sends the approval in the body', () => {
    const [approve] = withdrawalActions({ withdrawal_id: 7, status: 'REQUESTED' }, { role: 'ADMIN' });
    expect(approve).toMatchObject({ action: 'avaliar', body: { approve: true } });
  });
});
