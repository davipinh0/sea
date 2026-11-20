// Apoio dos testes: login pela API (Bearer, como o app), dados fictícios únicos por execução e o
// "celular" que aprova pedidos de liberação.
const { expect } = require('@playwright/test');

const PASSWORD = 'Qa@12345';
const EXPEDICAO = 1;

async function apiLogin(request, username, deviceToken) {
  const res = await request.post('/api/auth/login', {
    data: { username, password: PASSWORD, ...(deviceToken && { device_token: deviceToken }) },
  });
  expect(res.status(), `login ${username}`).toBe(200);
  const { token } = await res.json();
  return { Authorization: `Bearer ${token}` };
}

async function call(request, method, path, headers, data) {
  const res = await request.fetch(path, { method, headers, ...(data !== undefined && { data }) });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

// O celular cadastrado do usuário aprova o primeiro pedido pendente.
async function approveOnPhone(request, username) {
  const phone = await apiLogin(request, username, `ExponentPushToken[${username}]`);
  let pending = [];
  for (let i = 0; i < 20 && pending.length === 0; i += 1) {
    pending = (await call(request, 'GET', '/api/sea/login/pendentes', phone)).body.pending || [];
    if (!pending.length) await new Promise((r) => setTimeout(r, 500));
  }
  expect(pending.length, 'pedido chegou ao celular').toBeGreaterThan(0);
  const decided = await call(request, 'POST', `/api/sea/login/${pending[0].challenge_id}/decidir`, phone,
    { approve: true, device_token: `ExponentPushToken[${username}]` });
  expect(decided.status).toBe(200);
}

// Cria uma OT fictícia na base do SAP, registra, recebe e guarda no SP12. Retorna a ordem.
async function stockedOrder(request) {
  const n = String(Date.now()).slice(-9);
  const ot = `6${n}`; const ordem = `5${n}`; const material = `QAE${n}`;
  const admin = await apiLogin(request, 'qa.admin');
  const oper = await apiLogin(request, 'qa.oper');
  for (const [kind, records] of [
    ['ordens', [{ order_number: ordem, order_type: 'PM11' }]],
    ['materiais', [{ material_code: material, description: 'Luva QA (fictício)', uom: 'PAR' }]],
    ['reservas', [{ ot_number: ot, order_number: ordem, material_code: material, quantity: 10 }]],
  ]) {
    const r = await call(request, 'POST', `/api/sea/sap/importar/${kind}`, admin, { records });
    expect(r.body.errors, `importar ${kind}`).toEqual([]);
  }
  const reg = await call(request, 'POST', '/api/sea/recebimentos/base', oper, { warehouse_id: EXPEDICAO, ot_code: ot });
  expect(reg.status).toBe(201);
  const area = (await call(request, 'GET', `/api/sea/recebimentos/areas?warehouse_id=${EXPEDICAO}`, oper)).body.bins[0].bin_id;
  const line = (await call(request, 'GET', `/api/receiving/po/${ot}`, oper)).body.lines[0];
  expect((await call(request, 'POST', '/api/receiving/receive', oper,
    { po_id: reg.body.po_id, items: [{ item_id: line.item_id, quantity: 10, bin_id: area }] })).status).toBe(200);
  const pending = (await call(request, 'GET', '/api/sea/armazenagem/pendentes', oper)).body.pending_items.find((p) => p.lot_number === ot);
  const bin = (await call(request, 'GET', '/api/sea/armazenagem/destinos', oper)).body.bins.find((b) => b.warehouse_code === 'SP12');
  expect((await call(request, 'POST', '/api/putaway/confirm', oper,
    { item_id: line.item_id, from_bin_id: pending.bin_id, to_bin_id: bin.bin_id, quantity: 10, lot_number: ot })).status).toBe(200);
  return { ot, ordem, material };
}

async function uiLogin(page, username) {
  await page.goto('/login');
  await page.locator('input[type="text"]').fill(username);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

module.exports = { PASSWORD, apiLogin, call, approveOnPhone, stockedOrder, uiLogin };
