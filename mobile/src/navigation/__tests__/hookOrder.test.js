import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression: AppNavigator returned early (while the session loads) BEFORE
// some of its hooks. React then fails on the next render ("rendered more
// hooks than during the previous render"), which in an installed build
// closes the app right at start. Every hook must come before the return.

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
