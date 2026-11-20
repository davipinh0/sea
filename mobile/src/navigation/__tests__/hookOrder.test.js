import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regressão: o AppNavigator retornava antes de alguns hooks. O React quebrava na renderização
// seguinte e o app instalado fechava logo ao abrir. Todo hook tem de vir antes do return.

const source = readFileSync(fileURLToPath(new URL('../AppNavigator.js', import.meta.url)), 'utf8');
const body = source.slice(source.indexOf('export default function AppNavigator'));

describe('AppNavigator', () => {
  it('calls every hook before its early return', () => {
    const earlyReturn = body.indexOf('if (isLoading)');
    expect(earlyReturn).toBeGreaterThan(-1);
    const hookCalls = [...body.matchAll(/\buse[A-Z]\w*\(/g)].map((m) => m.index);
    expect(hookCalls.length).toBeGreaterThan(2);
    expect(Math.max(...hookCalls)).toBeLessThan(earlyReturn);
  });
});
