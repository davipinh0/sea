import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accessGroups, accessSummary, appModules } from '../acessos';
import { CELEBRATIONS, celebration, totalDuration, withdrawalCelebration } from '../celebrate';

const user = (extra) => ({ role: 'USER', allowed_pages: [], allowed_overrides: [], allowed_functions: [], ...extra });
const granted = (groups) => groups.flatMap((g) => g.items.filter((i) => i.granted).map((i) => i.key));

describe('Gerenciar Acessos', () => {
  it('shows only what the user was given', () => {
    const me = user({ allowed_pages: ['retirada', 'retirada-avaliar', 'inventory'] });
    expect(granted(accessGroups(me))).toEqual(['inventory', 'retirada', 'retirada-avaliar']);
    const retirada = accessGroups(me).find((g) => g.label === 'Retirada');
    expect([retirada.granted, retirada.items.length]).toEqual([2, 3]);
    expect(accessSummary(me)).toBe('3 permissões liberadas.');
  });

  it('counts the phone functions and the extra grants', () => {
    const me = user({ allowed_functions: ['receive'], allowed_overrides: ['export-csv'] });
    expect(granted(accessGroups(me))).toEqual(['receiving', 'export-csv']);
    // Uma página com o mesmo nome de um extra não libera o extra.
    expect(granted(accessGroups(user({ allowed_pages: ['export-csv'] })))).toEqual([]);
  });

  it('says when nothing or everything is granted', () => {
    expect(accessSummary(user())).toBe('Nenhuma permissão liberada ainda.');
    expect(accessSummary(user({ allowed_pages: ['users'] }))).toBe('1 permissão liberada.');
    const admin = { role: 'ADMIN' };
    expect(accessSummary(admin)).toMatch(/acesso a tudo/);
    expect(accessGroups(admin).every((g) => g.granted === g.items.length)).toBe(true);
  });

  it('lists the app screens with where each one works', () => {
    const modules = appModules(user({ allowed_functions: ['receive'], allowed_pages: ['retirada-fazer'] }));
    const on = modules.filter((m) => m.granted).map((m) => m.label);
    // Mesma regra da tela inicial (visibleModules): ORDENS pede uma página, não a função.
    expect(on).toEqual(['RECEBER', 'RETIRADA']);
    expect(modules.find((m) => m.label === 'RECEBER').sub).toMatch(/só no local Expedição/);
    expect(appModules(null)).toEqual([]);
  });

  it('is reachable from the photo menu and only disconnects devices', () => {
    const home = readFileSync(fileURLToPath(new URL('../../screens/HomeScreen.js', import.meta.url)), 'utf8');
    expect(home).toMatch(/navigation\.navigate\('Acessos'\)/);
    expect(home).toMatch(/>Gerenciar Acessos</);
    const screen = readFileSync(fileURLToPath(new URL('../../screens/AcessosScreen.js', import.meta.url)), 'utf8');
    // A única escrita é desconectar as próprias sessões; permissões e celulares seguem com o admin.
    const writes = [...screen.matchAll(/client\.(post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(writes).toEqual(['post /api/sea/meus-acessos/sessoes/encerrar']);
    expect(screen).toMatch(/DISPOSITIVOS CONECTADOS/);
    // Pergunta antes de desconectar.
    expect(screen).toMatch(/Alert\.alert\(title, text/);
  });

  it('shows the new system name on the login screen', () => {
    const login = readFileSync(fileURLToPath(new URL('../../screens/LoginScreen.js', import.meta.url)), 'utf8');
    expect(login).toMatch(/Sistema de Entrada e Armazenamento/);
    expect(login).not.toMatch(/Expedição e Armazenamento/);
  });

  it('shows the app logo instead of the SEA text on the login and the lock screen', () => {
    const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
    const logo = read('../../components/AppLogo.js');
    expect(logo).toMatch(/require\('\.\.\/\.\.\/assets\/icon\.png'\)/);
    expect(logo).toMatch(/accessibilityLabel="SEA"/);
    for (const file of ['../../screens/LoginScreen.js', '../../components/AppLock.js']) {
      const src = read(file);
      expect(src, file).toMatch(/<AppLogo \/>/);
      expect(src, file).not.toMatch(/>SEA<\/Text>/);
    }
  });
});

describe('Animações de sucesso', () => {
  it('celebrates receiving, storing and each step of a withdrawal', () => {
    expect(celebration('receber', 'OT 123').title).toBe('Recebido!');
    expect(celebration('armazenar').title).toBe('Armazenado!');
    expect(withdrawalCelebration('avaliar', { approve: true })).toBe('aprovada');
    expect(withdrawalCelebration('separar')).toBe('aceita');
    expect(withdrawalCelebration('pronta')).toBe('pronta');
  });

  it('does not celebrate a denial, a cancellation or an unknown event', () => {
    expect(withdrawalCelebration('avaliar', { approve: false, note: 'x' })).toBeNull();
    expect(withdrawalCelebration('cancelar', { reason: 'x' })).toBeNull();
    expect(celebration('inexistente')).toBeNull();
  });

  it('gives each event a new id so the same one can play twice in a row', () => {
    const a = celebration('receber');
    const b = celebration('receber');
    expect(a.id).not.toBe(b.id);
    expect(Object.keys(CELEBRATIONS).every((k) => CELEBRATIONS[k].icon && CELEBRATIONS[k].from)).toBe(true);
  });

  it('is short and shorter still with reduced motion', () => {
    expect(totalDuration(false)).toBeLessThanOrEqual(2500);
    expect(totalDuration(true)).toBeLessThan(totalDuration(false));
  });

  it('is wired into the three screens and the navigator animates transitions', () => {
    const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
    for (const [file, kind] of [['ReceberScreen', "'receber'"], ['ArmazenarScreen', "'armazenar'"], ['RetiradaScreen', 'kind']]) {
      const src = read(`../../screens/${file}.js`);
      expect(src).toMatch(new RegExp(`setCelebrate\\(celebration\\(${kind}`));
      expect(src).toMatch(/<SuccessAnimation event=\{celebrate\}/);
    }
    expect(read('../../navigation/AppNavigator.js')).toMatch(/animation: 'slide_from_right'/);
  });

  // Regressão: a animação do recebimento só aparecia depois de recarregar a OT (duas consultas).
  it('celebrates as soon as the server confirms, before reloading', () => {
    const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
    for (const [file, reload] of [['ReceberScreen', 'await load(code, true)'], ['ArmazenarScreen', 'await load()'], ['RetiradaScreen', 'await load()']]) {
      const src = read(`../../screens/${file}.js`);
      const celebrate = src.indexOf('setCelebrate(celebration(');
      expect(celebrate, file).toBeGreaterThan(-1);
      expect(src.indexOf(reload, celebrate - 400), file).toBeGreaterThan(celebrate);
    }
    // A animação não espera a consulta de "reduzir movimento" para começar.
    for (const file of ['SuccessAnimation', 'FadeIn']) {
      expect(read(`../../components/${file}.js`), file).not.toMatch(/isReduceMotionEnabled\(\)\s*\.catch/);
    }
  });
});
