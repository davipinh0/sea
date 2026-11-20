// Testes ponta a ponta do painel. Rodam contra o SEA local (docker compose), com os usuários de
// qa/seed_qa.py. Ver qa/README.md.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1, // os testes compartilham o banco local
  reporter: [['list'], ['html', { outputFolder: 'relatorio', open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    locale: 'pt-BR',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
