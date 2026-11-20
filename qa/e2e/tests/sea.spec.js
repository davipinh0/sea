// Fluxos ponta a ponta do painel e do terminal, como o usuário faz.
const { test, expect } = require('@playwright/test');
const { apiLogin, call, approveOnPhone, stockedOrder, uiLogin } = require('./helpers');

test.describe('Login e sessão', () => {
  test('senha errada mostra a mensagem e não entra', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="text"]').fill('qa.oper');
    await page.locator('input[type="password"]').fill('errada');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('.login-error')).toContainText('incorretos');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sair e voltar pelo histórico pede login de novo', async ({ page }) => {
    await uiLogin(page, 'qa.oper');
    await page.locator('.topbar-avatar').click();
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goBack();
    // Voltar não mostra nenhuma tela do painel; abrir de novo exige login.
    await expect(page.locator('.topbar-avatar')).toHaveCount(0);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('aba nova não herda a sessão de uma aba que já foi fechada', async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await uiLogin(first, 'qa.oper');
    await first.close();
    const second = await context.newPage();
    await second.goto('/');
    await expect(second).toHaveURL(/\/login/);
    await context.close();
  });
});

test.describe('Permissões no menu', () => {
  test('usuário sem permissão não vê Retirada nem entra pela URL', async ({ page }) => {
    await uiLogin(page, 'qa.semperm');
    await expect(page.getByRole('link', { name: 'Retirada' })).toHaveCount(0);
    await page.goto('/retirada');
    await expect(page).not.toHaveURL(/\/retirada$/);
  });

  test('usuário do terminal só vê Retirada e o botão do terminal', async ({ page }) => {
    await uiLogin(page, 'qa.terminal');
    await expect(page).toHaveURL(/\/retirada$/);
    await expect(page.getByRole('link', { name: 'Painel' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir terminal de retirada' })).toBeVisible();
    await page.goto('/users');
    await expect(page).toHaveURL(/\/retirada$/);
  });
});

test.describe('Processos liberados pelo celular', () => {
  test('Recebimento só abre depois da confirmação no celular', async ({ page, request }) => {
    await uiLogin(page, 'qa.oper');
    await page.goto('/expedicao/recebimento');
    await page.getByRole('button', { name: 'Enviar para o celular' }).click();
    await expect(page.getByText(/SIM, SOU EU/)).toBeVisible();
    await approveOnPhone(request, 'qa.oper');
    await expect(page.getByText('Código de barras da OT')).toBeVisible({ timeout: 15_000 });
  });

  test('no tema escuro o aviso não fica branco com texto branco', async ({ page }) => {
    await uiLogin(page, 'qa.almox');
    await page.getByRole('button', { name: 'Usar tema escuro' }).click();
    await page.goto('/retirada');
    const card = page.locator('.process-gate-card');
    await expect(card).toBeVisible();
    const [bg, fg] = await card.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    expect(bg).not.toBe('rgb(255, 255, 255)');
    expect(bg).not.toBe(fg);
  });
});

test.describe('Terminal de retirada', () => {
  test('quem não tem acesso pede com o e-mail e recebe no terminal', async ({ page, request }) => {
    const { ordem } = await stockedOrder(request);
    await uiLogin(page, 'qa.terminal');
    await page.getByRole('link', { name: 'Abrir terminal de retirada' }).click();
    await page.getByRole('button', { name: /Não tenho acesso ao SEA/ }).click();
    await page.getByLabel('E-mail corporativo').fill('sem-arroba');
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('alert')).toContainText('e-mail corporativo válido');
    await page.getByLabel('E-mail corporativo').fill('Visitante.QA@Empresa-Ficticia.com');
    await page.getByRole('button', { name: 'Continuar' }).click();

    await page.getByLabel('Ordem').fill(ordem);
    await page.getByRole('button', { name: 'Consultar ordem' }).click();
    await page.getByRole('button', { name: /^Aumentar/ }).first().click();
    await page.getByRole('button', { name: 'Solicitar retirada' }).click();
    await expect(page.getByText(/Aguardando a avaliação/)).toBeVisible();

    const wid = (await page.getByText(/Solicitação nº \d+/).textContent()).match(/\d+/)[0];
    const avaliador = await apiLogin(request, 'qa.avaliador');
    const almox = await apiLogin(request, 'qa.almox');
    expect((await call(request, 'POST', `/api/sea/retiradas/${wid}/avaliar`, avaliador, { approve: true })).status).toBe(200);
    expect((await call(request, 'POST', `/api/sea/retiradas/${wid}/separar`, almox, {})).status).toBe(200);
    await expect(page.getByText(/está preparando os seus materiais/)).toBeVisible({ timeout: 15_000 });
    expect((await call(request, 'POST', `/api/sea/retiradas/${wid}/pronta`, almox, {})).status).toBe(200);

    await page.getByRole('button', { name: 'Confirmo que recebi os materiais' }).click({ timeout: 15_000 });
    await expect(page.getByText('Retirada concluída')).toBeVisible();
    await expect(page.getByText(/Entrega registrada para visitante.qa@empresa-ficticia.com/)).toBeVisible();
  });
});

test.describe('Usuários', () => {
  test('excluir pede o celular e remove o usuário', async ({ page, request }) => {
    const admin = await apiLogin(request, 'qa.admin');
    const username = `qa.excluir.${Date.now()}`;
    const created = await call(request, 'POST', '/api/admin/users', admin, {
      username, password: 'Senha123', full_name: 'Para Excluir (fictício)', role: 'USER', warehouse_ids: [1],
    });
    expect(created.status).toBe(201);

    await uiLogin(page, 'qa.gestor');
    await page.goto('/users');
    const row = page.getByRole('row', { name: new RegExp(username.replace(/\./g, '\\.')) });
    await row.getByLabel('Excluir').click();
    await page.locator('.modal').getByRole('button', { name: 'Excluir' }).click();
    await expect(page.getByText(/SIM, SOU EU/)).toBeVisible();
    await approveOnPhone(request, 'qa.gestor');
    await expect(page.getByText(username)).toHaveCount(0, { timeout: 15_000 });
  });
});
