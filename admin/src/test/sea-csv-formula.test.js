// Auditoria de 27/11/2026: as exportações de Endereços e da OT não neutralizavam fórmulas. Um nome
// de material como =HYPERLINK(...) virava fórmula ao abrir o CSV na planilha.
import { describe, it, expect } from 'vitest';
import { csvCell } from '../utils/csv.js';

describe('csvCell', () => {
  it.each(['=1+1', '+SOMA(A1)', '-2+3', '@SUM(A1)', '\tx', '\rx', '=HYPERLINK("http://x","y")'])(
    'neutraliza fórmula: %s',
    (value) => {
      const cell = csvCell(value);
      expect(cell.startsWith(`"'`)).toBe(true);
      expect(cell.endsWith('"')).toBe(true);
    },
  );

  it('duplica aspas dentro da fórmula neutralizada', () => {
    expect(csvCell('=A"B')).toBe(`"'=A""B"`);
  });

  it('mantém texto comum e números como estão', () => {
    expect(csvCell('A0')).toBe('A0');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('põe entre aspas o texto com vírgula, aspas ou quebra de linha', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
});
