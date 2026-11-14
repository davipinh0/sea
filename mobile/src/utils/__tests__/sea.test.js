import { describe, it, expect } from 'vitest';
import {
  EXPEDICAO_CODE, apiError, formatQuantity, groupByLocation, parseQuantity, quantityProblem, visibleModules,
} from '../sea';

const keys = (me, code) => visibleModules(me, code).map((m) => m.key);

describe('visibleModules', () => {
  it('shows everything to an administrator at the Expedição location', () => {
    expect(keys({ role: 'ADMIN' }, EXPEDICAO_CODE)).toEqual(['receive', 'putaway', 'retirada', 'transfer']);
  });

  it('offers receiving and storage only at the Expedição location', () => {
    expect(keys({ role: 'ADMIN' }, 'SP12')).toEqual(['retirada', 'transfer']);
    expect(keys({ role: 'ADMIN' }, 'Solda')).toEqual(['retirada', 'transfer']);
  });

  it('follows the page permissions of the user', () => {
    const me = { role: 'USER', allowed_pages: ['retirada'], allowed_functions: [] };
    expect(keys(me, EXPEDICAO_CODE)).toEqual(['retirada']);
    expect(keys({ role: 'USER', allowed_pages: ['inventory'] }, 'SP12')).toEqual(['transfer']);
    expect(keys({ role: 'USER', allowed_pages: ['receiving', 'putaway'] }, EXPEDICAO_CODE)).toEqual(['receive', 'putaway', 'transfer']);
  });

  it('still honours the mobile functions granted to a user', () => {
    const me = { role: 'USER', allowed_pages: [], allowed_functions: ['receive'] };
    expect(keys(me, EXPEDICAO_CODE)).toEqual(['receive']);
    expect(keys(me, 'SP12')).toEqual([]);
  });

  it('shows nothing without a user', () => {
    expect(visibleModules(null, EXPEDICAO_CODE)).toEqual([]);
  });
});

describe('formatQuantity', () => {
  it('counts a KG material with a box weight in boxes', () => {
    expect(formatQuantity(36, 'KG', 18)).toBe('2 cx (36 KG)');
    expect(formatQuantity(40, 'KG', 18)).toBe('2,2 cx (40 KG)');
  });

  it('shows the unit for everything else', () => {
    expect(formatQuantity(3, 'PC', null)).toBe('3 PC');
    expect(formatQuantity(7, 'KG', null)).toBe('7 KG');
    expect(formatQuantity(5)).toBe('5');
    expect(formatQuantity(null)).toBe('-');
  });
});

describe('quantities typed by the operator', () => {
  it('accepts only whole numbers above zero', () => {
    expect(parseQuantity(' 12 ')).toBe(12);
    for (const bad of ['', '0', '-3', '1,5', '1.5', 'abc', null]) expect(parseQuantity(bad)).toBeNull();
  });

  it('explains why a quantity cannot be used', () => {
    expect(quantityProblem('5', { max: 8 })).toBeNull();
    expect(quantityProblem('', { max: 8 })).toMatch(/Informe a quantidade/);
    expect(quantityProblem('9', { max: 8 })).toMatch(/maior que o saldo \(8\)/);
    expect(quantityProblem('10', { max: 36, packWeightKg: 18 })).toMatch(/caixa de 18 KG/);
    expect(quantityProblem('18', { max: 36, packWeightKg: 18 })).toBeNull();
  });
});

describe('groupByLocation', () => {
  const bins = [
    { bin_id: 1, bin_code: 'A1', warehouse_code: 'SP12', warehouse_name: 'SP12' },
    { bin_id: 2, bin_code: 'B2', warehouse_code: 'SP12', warehouse_name: 'SP12' },
    { bin_id: 3, bin_code: 'SOLDA', warehouse_code: 'Solda', warehouse_name: 'Contêiner de Solda' },
  ];

  it('groups the addresses by location and leaves the origin out', () => {
    const groups = groupByLocation(bins, 1);
    expect(groups.map((g) => [g.code, g.bins.map((b) => b.bin_code)])).toEqual([['SP12', ['B2']], ['Solda', ['SOLDA']]]);
    expect(groupByLocation(null)).toEqual([]);
  });
});

describe('apiError', () => {
  it('shows the rule message written by the API', () => {
    const err = { response: { status: 409, data: { error: 'Capacidade excedida em B0', user_facing: true } } };
    expect(apiError(err, 'x')).toBe('Capacidade excedida em B0');
  });

  it('hides technical messages and explains network problems', () => {
    expect(apiError({ response: { status: 500, data: { error: 'psycopg2 ...' } } }, 'Falhou')).toBe('Falhou');
    expect(apiError({ response: { status: 403, data: { error: 'Permission denied' } } }, 'x')).toMatch(/não tem permissão/);
    expect(apiError({ isTimeout: true, response: null }, 'x')).toMatch(/demorou a responder/);
    expect(apiError(new Error('Network request failed'), 'x')).toMatch(/Sem conexão/);
  });
});
