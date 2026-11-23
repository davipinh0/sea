// Gerenciar Acessos (dispositivos conectados) e a situação da ordem no terminal de retirada.
const { test, expect } = require('@playwright/test');
const { apiLogin, call, uiLogin } = require('./helpers');

test('Gerenciar Acessos lista os aparelhos e desconecta outro na hora', async ({ page, request }) => {
  // Outro "aparelho" do mesmo usuário (login pela API, como o app).
  const other = await apiLogin(request, 'qa.solic');
  expect((await call(request, 'GET', '/api/sea/meus-acessos', other)).status).toBe(200);

  await uiLogin(page, 'qa.solic');
  await page.locator('.topbar-avatar').click();
  await page.getByRole('button', { name: 'Gerenciar Acessos' }).click();
  await expect(page.getByRole('heading', { name: 'Gerenciar Acessos' })).toBeVisible();
  await expect(page.getByText('Este aparelho')).toHaveCount(1);
  const buttons = page.getByRole('button', { name: /^Desconectar / });
  expect(await buttons.count()).toBeGreaterThan(0);
  await page.screenshot({ path: 'relatorio/gerenciar-acessos.png', fullPage: true });

  // Desconecta todos os outros: a sessão da API para de funcionar, a do navegador continua.
  const all = page.getByRole('button', { name: 'Desconectar todos os outros' });
  if (await all.count()) await all.click(); else await buttons.first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Desconectar', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /desconectado/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Desconectar / })).toHaveCount(0);
  expect((await call(request, 'GET', '/api/sea/meus-acessos', other)).status).toBe(401);
  await expect(page.getByText('Este aparelho')).toBeVisible();
});

test('terminal avisa quando a ordem ainda não foi recebida', async ({ page, request }) => {
  const n = String(Date.now()).slice(-9);
  const ordem = `7${n}`;
  const admin = await apiLogin(request, 'qa.admin');
  for (const [kind, records] of [
    ['ordens', [{ order_number: ordem, order_type: 'PM12' }]],
    ['materiais', [{ material_code: `QAT${n}`, description: 'Filtro QA (fictício)', uom: 'PC' }]],
    ['reservas', [{ ot_number: `8${n}`, order_number: ordem, material_code: `QAT${n}`, quantity: 4 }]],
  ]) {
    const r = await call(request, 'POST', `/api/sea/sap/importar/${kind}`, admin, { records });
    expect(r.body.errors, `importar ${kind}`).toEqual([]);
  }

  await uiLogin(page, 'qa.terminal');
  await page.getByRole('link', { name: 'Abrir terminal de retirada' }).click();
  await page.getByRole('button', { name: /Não tenho acesso ao SEA/ }).click();
  await page.getByLabel('E-mail corporativo').fill('visitante.qa@empresa-ficticia.com');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Ordem').fill(ordem);
  await page.getByRole('button', { name: 'Consultar ordem' }).click();

  await expect(page.getByText(/Aguardando Recebimento: os materiais desta ordem ainda não chegaram/)).toBeVisible();
  await expect(page.getByText('Filtro QA (fictício)')).toBeVisible();
  await expect(page.getByText(/previsto: 4 PC · recebido: 0 PC/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Solicitar retirada' })).toHaveCount(0);
  await page.screenshot({ path: 'relatorio/terminal-aguardando-recebimento.png', fullPage: true });
});

test('o painel mostra o nome novo do sistema', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle('SEA - Sistema de Entrada e Armazenamento');
  await expect(page.getByText('Sistema de Entrada e Armazenamento')).toBeVisible();
});
