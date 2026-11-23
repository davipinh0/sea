// XSS guardado (texto salvo que viraria código na tela de outra pessoa) e acessibilidade (axe).
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { apiLogin, call, uiLogin } = require('./helpers');

const PAYLOAD = '<img src=x onerror="window.__xss=1">';

test.describe('XSS guardado', () => {
  test('texto com HTML aparece como texto e nunca roda', async ({ page, request }) => {
    const admin = await apiLogin(request, 'qa.admin');
    const n = String(Date.now()).slice(-9);
    const r = await call(request, 'POST', '/api/sea/sap/importar/materiais', admin,
      { records: [{ material_code: `QAX${n}`, description: `Material ${PAYLOAD}`, uom: 'PC' }] });
    expect(r.status).toBe(200);
    const user = await call(request, 'POST', '/api/admin/users', admin, {
      username: `qa.xss.${n}`, password: 'Senha123', full_name: `Nome ${PAYLOAD}`, role: 'USER', warehouse_ids: [1],
    });
    expect(user.status).toBe(201);

    await uiLogin(page, 'qa.admin');
    for (const path of ['/cadastro-materiais', '/users']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => window.__xss), `XSS em ${path}`).toBeUndefined();
    }
    await expect(page.getByText(`Nome ${PAYLOAD}`).first()).toBeVisible();
  });
});

test.describe('Acessibilidade (axe, regras WCAG A/AA)', () => {
  const scan = async (page) => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    return result.violations
      .filter((v) => ['critical', 'serious'].includes(v.impact))
      .map((v) => `${v.impact} ${v.id}: ${v.nodes.length}x ${v.nodes[0].target.join(' ')}`);
  };

  test('login', async ({ page }) => {
    await page.goto('/login');
    expect(await scan(page)).toEqual([]);
  });

  for (const [name, user, path] of [
    ['painel', 'qa.admin', '/'],
    ['usuários', 'qa.admin', '/users'],
    ['retirada', 'qa.admin', '/retirada'],
    ['terminal', 'qa.terminal', '/retirada/terminal'],
    ['gerenciar acessos', 'qa.solic', '/acessos'],
  ]) {
    test(name, async ({ page }) => {
      await uiLogin(page, user);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await scan(page)).toEqual([]);
    });
  }
});
