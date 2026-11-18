import { describe, it, expect } from 'vitest';
import { approvalEndMessage, approvalSummary } from '../loginApproval';

describe('approvalSummary', () => {
  const now = new Date(2026, 10, 18, 10, 30);

  it('says who tries to log in, when and how much time is left', () => {
    const info = approvalSummary({
      client: 'Chrome no Windows', client_ip: '200.1.2.3',
      created_at: new Date(2026, 10, 18, 10, 29).toISOString(), seconds_left: 95,
    }, now);
    expect(info).toEqual({ client: 'Chrome no Windows', ip: '200.1.2.3', when: 'Hoje às 10:29', timeLeft: '1 min 35 s' });
  });

  it('copes with missing data', () => {
    const info = approvalSummary({ seconds_left: -3 }, now);
    expect(info.client).toBe('Navegador');
    expect(info.timeLeft).toBe('0 s');
    expect(info.when).toBe('');
  });
});

describe('approvalEndMessage', () => {
  it('explains how a wait on the registered phone ended', () => {
    expect(approvalEndMessage(403)).toMatch(/negado/);
    expect(approvalEndMessage(410)).toMatch(/tempo/);
    expect(approvalEndMessage(404)).toMatch(/não encontrada/);
    expect(approvalEndMessage(500)).toMatch(/Tente de novo/);
  });
});
