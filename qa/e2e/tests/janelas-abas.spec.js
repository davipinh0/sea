// Janelas por cima do painel (não fecham clicando fora) e aba duplicada pelo navegador.
const { test, expect } = require('@playwright/test');
const { uiLogin } = require('./helpers');

test('janela aberta desfoca o fundo e só sai por Cancelar ou ×', async ({ page }) => {
  await uiLogin(page, 'qa.admin');
  await page.goto('/users');
  await page.getByRole('button', { name: 'Novo usuário' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo usuário' });
  await expect(dialog).toBeVisible();
  await page.getByLabel('Nome completo *').fill('Preenchido pela metade (fictício)');

  const blur = await page.locator('.modal-overlay').evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(blur).toContain('blur');

  // Clique fora (canto da tela, no fundo desfocado): continua aberta e com o que foi digitado.
  await page.mouse.click(5, 5);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Nome completo *')).toHaveValue('Preenchido pela metade (fictício)');
  await page.screenshot({ path: 'relatorio/janela-desfocada.png' });

  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
});

test('aba duplicada é bloqueada e a original continua', async ({ page, context }) => {
  await uiLogin(page, 'qa.admin');
  await page.goto('/users');
  await expect(page.getByRole('button', { name: 'Novo usuário' })).toBeVisible();
  // "Duplicar" copia o sessionStorage da aba; aqui a cópia é feita à mão antes de abrir a página.
  const storage = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
  const copy = await context.newPage();
  await copy.addInitScript((entries) => {
    if (!window.__copied) {
      for (const [k, v] of JSON.parse(entries)) sessionStorage.setItem(k, v);
      window.__copied = true;
    }
  }, storage);
  await copy.goto('/users');
  await expect(copy).toHaveURL(/\/login/);
  await expect(copy.getByText(/cópia de outra aba do painel e foi bloqueada/)).toBeVisible();

  // A aba original segue com a sessão.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Novo usuário' })).toBeVisible();
  await copy.close();
});

// Regressão (24/11/2026): o link copiado numa aba nova entrava direto, com os processos já liberados
// no celular pela outra aba. Agora o painel funciona em uma aba por vez.
test('link copiado para outra aba não entra; a aba original continua', async ({ page, context }) => {
  await uiLogin(page, 'qa.admin');
  await page.goto('/users');
  await expect(page.getByRole('button', { name: 'Novo usuário' })).toBeVisible();

  const other = await context.newPage();
  await other.goto('/users');
  await expect(other).toHaveURL(/\/login$/);
  await expect(other.getByText(/já está aberto em outra aba/)).toBeVisible();
  await expect(other.getByRole('button', { name: 'Novo usuário' })).toHaveCount(0);
  await other.screenshot({ path: 'relatorio/aba-nova-bloqueada.png' });
  await other.close();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Novo usuário' })).toBeVisible();
});
