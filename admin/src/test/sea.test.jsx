/*
 * Telas do SEA: terminal de retirada, recebimento, menu por permissão e mensagens de erro.
 * Regressão: o filtro 'All' das ordens nunca pode ser enviado como status.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const apiGet = vi.fn();
const apiPost = vi.fn();
let currentUser = { username: 'terminal', full_name: 'Terminal SP12', role: 'USER', allowed_pages: ['retirada'] };

vi.mock('../api.js', () => ({
  api: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
    put: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    delete: vi.fn(),
  },
}));
let warehouseList = [];
let currentWarehouse = { warehouse_id: 7, warehouse_code: 'Recebimento' };
vi.mock('../warehouse.jsx', () => ({ useWarehouse: () => ({ warehouseId: 7, warehouses: warehouseList, warehouse: currentWarehouse }) }));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: currentUser }) }));
// O terminal tem sessão própria; as chamadas dele passam pelos mesmos mocks, marcadas com o token
// usado.
const terminalLogin = vi.fn();
const terminalLogout = vi.fn();
const terminalTokens = [];
vi.mock('../terminalApi.js', () => ({
  terminalLogin: (...a) => terminalLogin(...a),
  terminalLogout: (...a) => terminalLogout(...a),
  terminalApi: (token) => ({
    get: (path) => { terminalTokens.push(token); return apiGet(path); },
    post: (path, body) => { terminalTokens.push(token); return apiPost(path, body); },
  }),
}));
const TERMINAL_USER = { username: 'retirada', full_name: 'Usuário de Retirada', role: 'USER', allowed_pages: ['retirada'], must_change_password: false };

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = (status, body) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });

import TerminalRetirada, { TERMINAL_IDLE_MS } from '../pages/TerminalRetirada.jsx';
import Retirada from '../pages/Retirada.jsx';
import Items from '../pages/Items.jsx';
import ArmazenagemSP12 from '../pages/ArmazenagemSP12.jsx';
import Notificacoes from '../components/Notificacoes.jsx';
import RecebimentoOT from '../pages/RecebimentoOT.jsx';
import Sidebar from '../components/Sidebar.jsx';
import PurchaseOrders from '../pages/PurchaseOrders.jsx';
import { errorMessage, formatQuantity } from '../utils/sea.js';

const OT = { ot: 'OT-1', order_type: 'PM11', status: 'RECEIVED', warehouse_id: 7 };
const STOCK = [
  { inventory_id: 11, sku: 'MAT-1', item_name: 'Parafuso', bin_code: 'A3', stored: true, available: 5 },
  { inventory_id: 12, sku: 'MAT-2', item_name: 'Porca', bin_code: 'SP12-RECEB', stored: false, available: 9 },
];
// Para uma ordem, o terminal só recebe o que está guardado e disponível, cada linha com a sua OT.
const ORDER = {
  order_number: '2000000011', order_type: 'PM11',
  stock: [{ inventory_id: 11, ot: 'OT-1', sku: 'MAT-1', item_name: 'Parafuso', bin_code: 'A3', warehouse_id: 7, warehouse_code: 'SP12', available: 5 }],
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  terminalLogin.mockReset().mockResolvedValue({ token: 'tok-terminal', user: TERMINAL_USER });
  terminalTokens.length = 0;
  terminalLogout.mockReset().mockResolvedValue(null);
  warehouseList = [];
  currentUser = { username: 'terminal', full_name: 'Terminal SP12', role: 'USER', allowed_pages: ['retirada'] };
});

async function terminalSignIn() {
  render(<MemoryRouter><TerminalRetirada /></MemoryRouter>);
  expect(screen.queryByLabelText('Ordem')).toBeNull();
  fireEvent.click(screen.getByText('Tenho acesso ao SEA'));
  fireEvent.change(screen.getByLabelText('E-mail corporativo ou usuário'), { target: { value: 'retirada@sea.example' } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'Sea@2026' } });
  fireEvent.click(screen.getByText('Entrar'));
  await screen.findByLabelText('Ordem');
}

describe('Terminal de retirada', () => {
  it('runs login -> order -> materials -> request -> ready -> confirm, without a badge', async () => {
    let status = 'REQUESTED';
    const withdrawal = () => ({ withdrawal_id: 3, status, delivered_to: 'Usuário de Retirada', lines: [{ inventory_id: 11, item_name: 'Parafuso', bin_code: 'A3', quantity: 2 }] });
    apiGet.mockImplementation((path) => {
      if (path === '/sea/ordens/2000000011') return ok(ORDER);
      if (path === '/sea/retiradas/3') return ok({ withdrawal: withdrawal() });
      return ok({});
    });
    apiPost.mockImplementation((path) => {
      if (path === '/sea/retiradas') return ok({ withdrawal: withdrawal() });
      if (path === '/sea/retiradas/3/entregar') { status = 'DELIVERED'; return ok({ withdrawal: withdrawal() }); }
      return ok({});
    });

    await terminalSignIn();
    expect(terminalLogin).toHaveBeenCalledWith('retirada@sea.example', 'Sea@2026', expect.objectContaining({ onWaiting: expect.any(Function) }));
    expect(screen.getByText(/Identificado: Usuário de Retirada/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));

    // O funcionário só informa a ordem: sem OT, sem código de barras.
    await screen.findByText('Parafuso');
    expect(screen.getByText(/2000000011 · materiais disponíveis/)).toBeInTheDocument();
    expect(screen.queryByText(/código de barras/i)).toBeNull();
    fireEvent.click(screen.getByLabelText('Aumentar MAT-1'));
    fireEvent.click(screen.getByLabelText('Aumentar MAT-1'));
    fireEvent.click(screen.getByText('Solicitar retirada'));

    await screen.findByText(/Solicitação nº 3 enviada/);
    expect(apiPost).toHaveBeenCalledWith('/sea/retiradas', { ot: 'OT-1', lines: [{ inventory_id: 11, quantity: 2 }] });

    status = 'READY';
    fireEvent.click(await screen.findByText('Confirmo que recebi os materiais', {}, { timeout: 5000 }));
    await screen.findByText('Retirada concluída');
    expect(apiPost).toHaveBeenCalledWith('/sea/retiradas/3/entregar', {});
    expect(screen.queryByText(/crachá/i)).toBeNull();

    // Todas as chamadas usaram o token do terminal, nunca a sessão do painel.
    expect(new Set(terminalTokens)).toEqual(new Set(['tok-terminal']));

    fireEvent.click(screen.getByText('Encerrar sessão'));
    await screen.findByText('Tenho acesso ao SEA');
    expect(terminalLogout).toHaveBeenCalledWith('tok-terminal');
  }, 15000);

  it('who has no access to the SEA asks with the corporate e-mail only (mig 098)', async () => {
    apiGet.mockImplementation((path) => (path === '/sea/ordens/2000000011' ? ok(ORDER) : ok({})));
    apiPost.mockImplementation(() => ok({ withdrawal: { withdrawal_id: 9, status: 'REQUESTED', lines: [] } }));
    render(<MemoryRouter><TerminalRetirada /></MemoryRouter>);
    fireEvent.click(screen.getByText('Não tenho acesso ao SEA'));
    expect(screen.queryByLabelText('Senha')).toBeNull();

    fireEvent.change(screen.getByLabelText('E-mail corporativo'), { target: { value: 'sem-arroba' } });
    fireEvent.click(screen.getByText('Continuar'));
    expect(await screen.findByRole('alert')).toHaveTextContent('e-mail corporativo válido');

    fireEvent.change(screen.getByLabelText('E-mail corporativo'), { target: { value: ' Fulano@Empresa.example ' } });
    fireEvent.click(screen.getByText('Continuar'));
    await screen.findByLabelText('Ordem');
    expect(screen.getByText(/Identificado: fulano@empresa.example \(sem acesso ao SEA\)/)).toBeInTheDocument();
    expect(terminalLogin).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));
    await screen.findByText('Parafuso');
    fireEvent.click(screen.getByLabelText('Aumentar MAT-1'));
    fireEvent.click(screen.getByText('Solicitar retirada'));
    await screen.findByText(/Solicitação nº 9 enviada/);
    expect(apiPost).toHaveBeenCalledWith('/sea/retiradas', {
      ot: 'OT-1', lines: [{ inventory_id: 11, quantity: 1 }], requester_email: 'fulano@empresa.example',
    });
    // Os pedidos saíram pela sessão do usuário do terminal, não com o token de um funcionário.
    expect(terminalTokens).toEqual([]);
  });

  it('says why an order has nothing to withdraw and marks each material', async () => {
    const mat = (sku, status, extra = {}) => ({
      ot: 'OT-9', sku, item_name: `Peça ${sku}`, uom: 'PC', pack_weight_kg: null, status,
      quantity_ordered: 2, quantity_received: 2, awaiting_storage: 0, available: 0, withdrawn: 0, ...extra,
    });
    const orders = {
      '2000000091': { order_number: '2000000091', status: 'RETIRADA', withdrawn_at: '2026-11-20T13:05:00Z', stock: [],
        materials: [mat('ESG-1', 'ESGOTADO', { withdrawn: 2 })] },
      '2000000092': { order_number: '2000000092', status: 'AGUARDANDO_RECEBIMENTO', stock: [],
        materials: [mat('SAP-1', 'AGUARDANDO_RECEBIMENTO', { quantity_received: 0 })] },
      '2000000093': { order_number: '2000000093', status: 'AGUARDANDO_ARMAZENAMENTO', stock: [],
        materials: [mat('STG-1', 'AGUARDANDO_ARMAZENAMENTO', { awaiting_storage: 2 })] },
      '2000000094': { ...ORDER, order_number: '2000000094', status: 'DISPONIVEL',
        materials: [mat('MAT-1', 'DISPONIVEL', { available: 5 }), mat('ESG-2', 'ESGOTADO', { withdrawn: 2 })] },
    };
    apiGet.mockImplementation((path) => ok(orders[path.split('/').pop()] || {}));
    render(<MemoryRouter><TerminalRetirada /></MemoryRouter>);
    fireEvent.click(screen.getByText('Não tenho acesso ao SEA'));
    fireEvent.change(screen.getByLabelText('E-mail corporativo'), { target: { value: 'fulano@empresa.example' } });
    fireEvent.click(screen.getByText('Continuar'));
    const ask = async (number) => {
      fireEvent.change(await screen.findByLabelText('Ordem'), { target: { value: number } });
      fireEvent.click(screen.getByText('Consultar ordem'));
    };

    await ask('2000000091');
    expect(await screen.findByRole('status')).toHaveTextContent(/já foi retirada em \d{2}\/11\/2026/);
    expect(screen.getByText('Esgotado')).toBeInTheDocument();
    expect(screen.getByText(/retirado: 2/)).toBeInTheDocument();
    expect(screen.queryByText('Solicitar retirada')).toBeNull();
    expect(screen.queryByText(/materiais disponíveis/)).toBeNull();

    fireEvent.click(screen.getByText('Voltar'));
    await ask('2000000092');
    expect(await screen.findByRole('status')).toHaveTextContent('Aguardando Recebimento');
    expect(screen.getByText(/previsto: 2 PC · recebido: 0 PC/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Voltar'));
    await ask('2000000093');
    expect(await screen.findByRole('status')).toHaveTextContent('Aguardando Armazenamento');

    // Com material disponível, os esgotados aparecem à parte e o pedido segue normal.
    fireEvent.click(screen.getByText('Voltar'));
    await ask('2000000094');
    await screen.findByText('Parafuso');
    expect(screen.queryByText(/já foi retirada|Aguardando Recebimento:|Nenhum material desta ordem/)).toBeNull();
    expect(screen.getByText('Outros materiais desta ordem')).toBeInTheDocument();
    expect(screen.getByText('Esgotado')).toBeInTheDocument();
    expect(screen.getByText('Solicitar retirada')).toBeInTheDocument();
  });

  it('signs out an employee who walks away before asking for material', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await terminalSignIn();
      await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS + 6000);
      expect(await screen.findByText('Tenho acesso ao SEA')).toBeInTheDocument();
      expect(terminalLogout).toHaveBeenCalledWith('tok-terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a wrong login and a user without the retirada permission', async () => {
    terminalLogin.mockRejectedValueOnce(new Error('E-mail, usuário ou senha inválidos.'));
    render(<MemoryRouter><TerminalRetirada /></MemoryRouter>);
    fireEvent.click(screen.getByText('Tenho acesso ao SEA'));
    fireEvent.change(screen.getByLabelText('E-mail corporativo ou usuário'), { target: { value: 'x@y.example' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'errada' } });
    fireEvent.click(screen.getByText('Entrar'));
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail, usuário ou senha inválidos.');

    terminalLogin.mockResolvedValueOnce({ token: 't', user: { username: 'outro', role: 'USER', allowed_pages: ['items'], must_change_password: false } });
    fireEvent.click(screen.getByText('Entrar'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('não tem permissão para retirar'));
    expect(screen.queryByLabelText('Ordem')).toBeNull();

    terminalLogin.mockResolvedValueOnce({ token: 't', user: { ...TERMINAL_USER, must_change_password: true } });
    fireEvent.click(screen.getByText('Entrar'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('precisa trocar a senha'));
    expect(screen.queryByLabelText('Ordem')).toBeNull();
  });

  it('cannot request more than the available quantity', async () => {
    apiGet.mockImplementation(() => ok(ORDER));
    await terminalSignIn();
    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));
    await screen.findByText('Parafuso');
    const plus = screen.getByLabelText('Aumentar MAT-1');
    for (let i = 0; i < 10; i += 1) fireEvent.click(plus);
    expect(screen.getByRole('group', { name: 'MAT-1' }).querySelector('output').textContent).toBe('5');
    expect(plus).toBeDisabled();
  });

  it('does not mix deliveries or locations in one request', async () => {
    apiGet.mockImplementation(() => ok({
      ...ORDER,
      stock: [...ORDER.stock, { inventory_id: 13, ot: 'OT-2', sku: 'MAT-3', item_name: 'Arruela', bin_code: 'SOLDA', warehouse_id: 9, warehouse_code: 'Solda', available: 2 }],
    }));
    await terminalSignIn();
    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));
    await screen.findByText('Arruela');
    fireEvent.click(screen.getByLabelText('Aumentar MAT-1'));
    fireEvent.click(screen.getByLabelText('Aumentar MAT-3'));
    fireEvent.click(screen.getByText('Solicitar retirada'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Solicite um grupo de cada vez');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('shows the API rule message (user_facing) when the request is refused', async () => {
    apiGet.mockImplementation(() => ok(ORDER));
    apiPost.mockImplementation(() => fail(409, { error: 'Quantidade solicitada maior que o saldo.', user_facing: true }));
    await terminalSignIn();
    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));
    await screen.findByText('Parafuso');
    fireEvent.click(screen.getByLabelText('Aumentar MAT-1'));
    fireEvent.click(screen.getByText('Solicitar retirada'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Quantidade solicitada maior que o saldo.');
  });
});

describe('Material em KG retirado por caixa', () => {
  const WIRE = {
    order_number: '2000000011', order_type: 'PM11',
    stock: [
      { inventory_id: 21, ot: 'OT-1', sku: 'ARAME', item_name: 'Arame de soldagem', bin_code: 'A3', warehouse_id: 7, warehouse_code: 'SP12', available: 36, uom: 'KG', pack_weight_kg: 18 },
      { inventory_id: 22, ot: 'OT-1', sku: 'LUVA', item_name: 'Luva', bin_code: 'A3', warehouse_id: 7, warehouse_code: 'SP12', available: 4, uom: 'PC', pack_weight_kg: null },
    ],
  };

  it('formats quantities by box only when the material has a box weight', () => {
    expect(formatQuantity(36, 'KG', 18)).toBe('2 cx (36 KG)');
    expect(formatQuantity(150, 'KG', 15)).toBe('10 cx (150 KG)');
    expect(formatQuantity(40, 'KG', 18)).toBe('2,2 cx (40 KG)');
    expect(formatQuantity(7, 'KG', null)).toBe('7 KG');
    expect(formatQuantity(3, 'PC', null)).toBe('3 PC');
    expect(formatQuantity(3, null, null)).toBe('3');
  });

  it('1 box of 18 KG out of 36 KG requests 18 KG; 1 PC requests 1', async () => {
    apiGet.mockImplementation(() => ok(WIRE));
    apiPost.mockImplementation(() => ok({ withdrawal: { withdrawal_id: 4, status: 'REQUESTED', lines: [
      { inventory_id: 21, item_name: 'Arame de soldagem', bin_code: 'A3', quantity: 18, uom: 'KG', pack_weight_kg: 18 },
      { inventory_id: 22, item_name: 'Luva', bin_code: 'A3', quantity: 1, uom: 'PC', pack_weight_kg: null },
    ] } }));
    await terminalSignIn();
    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));
    await screen.findByText('Arame de soldagem');
    expect(screen.getByText(/disponível: 2 cx \(36 KG\)/)).toBeInTheDocument();

    const wire = () => screen.getByRole('group', { name: 'ARAME' }).querySelector('output').textContent;
    const plus = screen.getByLabelText('Aumentar ARAME');
    expect(wire()).toBe('0 KG');
    fireEvent.click(plus);
    expect(wire()).toBe('18 KG');
    expect(screen.getByText(/Retirando 1 cx \(18 KG\); ficam 18 KG\./)).toBeInTheDocument();
    // Só caixas inteiras: 36 KG dá duas.
    fireEvent.click(plus);
    expect(wire()).toBe('36 KG');
    expect(plus).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Diminuir ARAME'));
    expect(wire()).toBe('18 KG');

    fireEvent.click(screen.getByLabelText('Aumentar LUVA'));
    fireEvent.click(screen.getByText('Solicitar retirada'));
    await screen.findByText(/Solicitação nº 4 enviada/);
    expect(apiPost).toHaveBeenCalledWith('/sea/retiradas', { ot: 'OT-1', lines: [
      { inventory_id: 21, quantity: 18 },
      { inventory_id: 22, quantity: 1 },
    ] });
    expect(screen.getByText(/1 cx \(18 KG\) · Arame de soldagem/)).toBeInTheDocument();
    expect(screen.getByText(/1 PC · Luva/)).toBeInTheDocument();
  });
});

describe('Retirada: cancelamento', () => {
  it('does not accept a blank reason', async () => {
    const open = { withdrawal_id: 5, ot: 'OT-1', order_type: 'PM11', status: 'REQUESTED', requested_by: 'retirada', lines: [] };
    apiGet.mockImplementation(() => ok({ withdrawals: [open] }));
    apiPost.mockImplementation(() => ok({ message: 'Retirada cancelada' }));
    render(<MemoryRouter><Retirada /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Cancelar'));
    const confirm = screen.getByText('Cancelar retirada');
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' pedido errado ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/retiradas/5/cancelar', { reason: 'pedido errado' }));
  });
});

describe('Armazenagem entre locais', () => {
  it('offers the shelves of the other locations for material received in the Recebimento', async () => {
    currentUser = { username: 'almoxarife', role: 'USER', allowed_pages: ['putaway'] };
    warehouseList = [
      { warehouse_id: 7, warehouse_code: 'Recebimento', warehouse_name: 'Área de Recebimento' },
      { warehouse_id: 8, warehouse_code: 'SP12', warehouse_name: 'Setor SP12' },
    ];
    const staged = { inventory_id: 40, item_id: 3, sku: 'MAT-1', item_name: 'Parafuso', quantity: 20, bin_id: 1, bin_code: 'EXPEDICAO', lot_number: '100000001', ot: '100000001', order_number: '2000000011', order_type: 'PM12', warehouse_id: 7, warehouse_code: 'Recebimento' };
    apiGet.mockImplementation((path) => {
      if (path === '/sea/armazenagem/pendentes') return ok({ pending_items: [staged] });
      if (path === '/sea/armazenagem/destinos') {
        return ok({ bins: [
          { bin_id: 21, bin_code: 'A0', warehouse_id: 8, warehouse_code: 'SP12', warehouse_name: 'Setor SP12', size_class: null },
          { bin_id: 22, bin_code: 'A3', warehouse_id: 8, warehouse_code: 'SP12', warehouse_name: 'Setor SP12', size_class: 'PEQUENO' },
          { bin_id: 31, bin_code: 'SOLDA', warehouse_id: 9, warehouse_code: 'Solda', warehouse_name: 'Contêiner de Solda', size_class: null },
        ] });
      }
      if (path === '/sea/armazenagem/sugestao/40') return ok({ bin_id: 21, bin_code: 'A0', warehouse_code: 'SP12', quantity: 20, rejected: [] });
      return ok({});
    });
    apiPost.mockImplementation(() => ok({ quantity: 20, item: 'MAT-1', to_bin: 'A0' }));

    render(<MemoryRouter><ArmazenagemSP12 /></MemoryRouter>);
    expect(await screen.findByText('Recebimento · EXPEDICAO')).toBeInTheDocument();
    const select = screen.getByLabelText('Endereço de destino de MAT-1');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Escolha…', 'A0', 'A3', 'SOLDA']);
    expect(screen.getByText('2000000011')).toBeInTheDocument();
    expect(screen.getByText('100000001')).toBeInTheDocument();
    expect(screen.queryByText(/Regras:/)).toBeNull();
    expect(Array.from(select.querySelectorAll('optgroup')).map((g) => g.label)).toEqual(['SP12 - Setor SP12', 'Solda - Contêiner de Solda']);
    await waitFor(() => expect(select).toHaveValue('21'));
    expect(screen.getByText('SP12 · A0')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Confirmar'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/putaway/confirm', { item_id: 3, from_bin_id: 1, to_bin_id: 21, quantity: 20, lot_number: '100000001' }));
    expect(await screen.findByText(/Armazenagem registrada: 20 de MAT-1 em SP12 · A0/)).toBeInTheDocument();
  });
});

describe('Materiais', () => {
  it('lists order, order type, code, description, quantity and unit', async () => {
    currentUser = { username: 'admin', role: 'ADMIN' };
    apiGet.mockImplementation(() => ok({
      items: [{ row_id: '1-9', item_id: 1, order: '2005113840', order_type: 'PM12', sku: '74165325', item_name: 'ARAME', quantity: 54, uom: 'KG', category: 'Solda', size_class: null, weight_lbs: null, is_active: true }],
      page: 1, pages: 1, total: 1, per_page: 50,
    }));
    render(<MemoryRouter><Items /></MemoryRouter>);
    expect(await screen.findByText('2005113840')).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent.trim()).filter(Boolean);
    expect(headers).toEqual(['Ordem', 'Tipo Ordem', 'Código', 'Descrição', 'Quantidade', 'Unidade', 'Peso por caixa', 'Categoria', 'Tamanho', 'Peso', 'Ativo']);
    expect(apiGet.mock.calls[0][0]).toMatch(/^\/sea\/materiais\?.*warehouse_id=7/);
    expect(screen.getByText('54')).toBeInTheDocument();
    expect(screen.getByText('KG')).toBeInTheDocument();
  });
});

describe('Notificações do painel', () => {
  it('shows and counts only what arrives after the panel opened', async () => {
    currentUser = { username: 'admin', role: 'ADMIN' };
    const old = { notification_id: 4, kind: 'RECEBIMENTO', title: 'Recebimento antigo', message: 'm', warehouse_code: 'SP12', email_status: 'ENVIADO', created_at: '2026-11-11T10:00:00Z' };
    const fresh = { notification_id: 5, kind: 'RETIRADA_SOLICITADA', title: 'Retirada nº 9 solicitada', message: '2 x MAT-1 (A3)', warehouse_code: 'SP12', email_status: 'NAO_CONFIGURADO', created_at: '2026-11-11T10:05:00Z' };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiGet.mockImplementation((path) => ok({ notifications: path.includes('after=4') ? [fresh] : [old] }));
      render(<MemoryRouter><Notificacoes /></MemoryRouter>);
      await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/sea/notificacoes', expect.anything()));
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByLabelText('Notificações')).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(10000);
      expect(await screen.findByRole('status')).toHaveTextContent('Retirada nº 9 solicitada');
      expect(screen.getByLabelText('Notificações: 1 nova(s)')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Notificações: 1 nova(s)'));
      expect(screen.getByText('Recebimento antigo')).toBeInTheDocument();
      expect(screen.getByText(/e-mail não configurado/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Notificações clicáveis', () => {
  function Where() {
    return <div data-testid="where">{useLocation().pathname}</div>;
  }

  it.each([
    ['RETIRADA_SOLICITADA', '/retirada'],
    ['RECEBIMENTO', '/recebimento/armazenagem'],
    ['ARMAZENAGEM_CONCLUIDA', '/estoque/sp12'],
  ])('%s opens %s', async (kind, target) => {
    currentUser = { username: 'admin', role: 'ADMIN' };
    apiGet.mockImplementation(() => ok({ notifications: [
      { notification_id: 8, kind, title: 'Aviso de teste', message: 'm', warehouse_id: 7, warehouse_code: 'SP12', email_status: 'ENVIADO', created_at: '2026-11-11T10:00:00Z' },
    ] }));
    render(<MemoryRouter><Notificacoes /><Where /></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('Notificações'));
    fireEvent.click(await screen.findByRole('button', { name: /Aviso de teste/ }));
    expect(screen.getByTestId('where').textContent).toBe(target);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clears the list on request', async () => {
    currentUser = { username: 'admin', role: 'ADMIN' };
    apiGet.mockImplementation(() => ok({ notifications: [
      { notification_id: 8, kind: 'RECEBIMENTO', title: 'Aviso de teste', message: 'm', warehouse_id: 7, warehouse_code: 'SP12', email_status: 'ENVIADO', created_at: '2026-11-11T10:00:00Z' },
    ] }));
    apiPost.mockImplementation(() => ok({ cleared_id: 8 }));
    render(<MemoryRouter><Notificacoes /></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('Notificações'));
    fireEvent.click(await screen.findByText('Limpar notificações'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/notificacoes/limpar', {}));
    expect(await screen.findByText('Nenhuma notificação.')).toBeInTheDocument();
    expect(screen.queryByText('Aviso de teste')).toBeNull();
    expect(screen.queryByText('Limpar notificações')).toBeNull();
  });
});

describe('Recebimento de OT', () => {
  it('integral receipt sends every remaining quantity to the receiving area', async () => {
    currentUser = { username: 'almoxarife', full_name: 'Almoxarife', role: 'USER', allowed_pages: ['receiving'] };
    const po = { po_id: 4, po_number: 'OT-9', order_type: 'PM12', status: 'PARTIAL' };
    apiGet.mockImplementation((path) => {
      if (path.startsWith('/sea/recebimentos/areas')) return ok({ bins: [{ bin_id: 1, bin_code: 'SP12-RECEB' }] });
      if (path.startsWith('/receiving/po/')) return ok({ purchase_order: po, lines: [
        { po_line_id: 1, item_id: 21, sku: 'MAT-1', item_name: 'Parafuso', quantity_ordered: 10, quantity_received: 4, quantity_remaining: 6 },
        { po_line_id: 2, item_id: 22, sku: 'MAT-2', item_name: 'Porca', quantity_ordered: 3, quantity_received: 3, quantity_remaining: 0 },
      ] });
      if (path.startsWith('/sea/ots/')) return ok({ receipts: [] });
      if (path.startsWith('/sea/ots')) return ok({ ots: [] });
      return ok({});
    });
    apiPost.mockImplementation(() => ok({}));

    render(<MemoryRouter><RecebimentoOT /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/Leia ou digite o número da OT/), { target: { value: 'OT-9' } });
    fireEvent.click(screen.getByText('Consultar'));
    await screen.findByText('Parafuso');
    // O operador digitou uma quantidade parcial, mas o "integral" tem de ignorá-la.
    fireEvent.change(screen.getByLabelText('Quantidade a receber de MAT-1'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Receber ordem integral'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/receiving/receive', { po_id: 4, items: [{ item_id: 21, quantity: 6, bin_id: 1 }] });
  });
});

describe('Recebimento por etiqueta', () => {
  const PARSED = {
    header: {
      ot_code: '1003329915', barcode: null, origin_company: 'EXPEDICAO', label_date: '2026-11-05',
      reservation_number: '0285365145 /02', needed_date: '2026-10-28', department: 'PP1',
      pickup_location: 'B02 18 003 F', unload_location: null, requester_name: 'Fulano',
      receiver_name: 'OFICINA CENT', service_order_type: 'PM12', service_order_number: '2005113840',
    },
    materials: [{ material_code: '74165325', description: 'ARAME', quantity: 54, uom: 'KG', lot_number: '0000245045', expiry_date: null }],
    pending: ['unload_location'], warnings: [], unrecognized: ['Centro de custo 4411'], existing: null,
  };

  function mockUnknownOt() {
    apiGet.mockImplementation((path) => {
      if (path.startsWith('/receiving/po/')) return fail(404, { error: 'not found' });
      if (path.startsWith('/sea/recebimentos/consulta')) return ok({ found: false, ot: '1003329915', integration: { source: 'none', data: null } });
      if (path.startsWith('/sea/ots')) return ok({ ots: [] });
      return ok({ bins: [] });
    });
  }

  async function openNewReceipt() {
    currentUser = { username: 'almoxarife', full_name: 'Almoxarife', role: 'USER', allowed_pages: ['receiving'] };
    render(<MemoryRouter><RecebimentoOT /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/Leia ou digite o número da OT/), { target: { value: '1003329915' } });
    fireEvent.click(screen.getByText('Consultar'));
    fireEvent.click(await screen.findByText('Iniciar recebimento pela etiqueta'));
  }

  it('OT found in the SAP base shows its materials and is registered as the base holds it', async () => {
    const BASE = {
      header: { ot_code: '1000000101', reservation_number: '0280000101', requester_name: 'Solicitante A', needed_date: '2026-12-01' },
      materials: [
        { material_code: '70000001', description: 'Arame de solda', quantity: 54, uom: 'KG', service_order_type: 'PM11', service_order_number: '2000000011' },
        { material_code: '70000002', description: 'Luva', quantity: 10, uom: 'PAR', service_order_type: 'PM12', service_order_number: '2000000012' },
      ],
    };
    apiGet.mockImplementation((path) => {
      if (path.startsWith('/receiving/po/')) return fail(404, { error: 'not found' });
      if (path.startsWith('/sea/recebimentos/consulta')) return ok({ found: false, ot: '1000000101', integration: { source: 'base', data: BASE } });
      if (path.startsWith('/sea/ots')) return ok({ ots: [] });
      return ok({ bins: [] });
    });
    apiPost.mockImplementation(() => ok({ ot: '1000000101', created: true, divergences: [] }));
    currentUser = { username: 'almoxarife', full_name: 'Almoxarife', role: 'USER', allowed_pages: ['receiving'] };
    render(<MemoryRouter><RecebimentoOT /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/Leia ou digite o número da OT/), { target: { value: '1000000101' } });
    fireEvent.click(screen.getByText('Consultar'));

    expect(await screen.findByText(/encontrada na base do SAP/)).toBeInTheDocument();
    expect(screen.getByText('Solicitante A')).toBeInTheDocument();
    expect(screen.getByText('2000000011')).toBeInTheDocument();
    expect(screen.getByText('2000000012')).toBeInTheDocument();
    expect(screen.getByText('Arame de solda')).toBeInTheDocument();
    expect(screen.getByText('PAR')).toBeInTheDocument();
    expect(screen.queryByText('Iniciar recebimento pela etiqueta')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Registrar entrega'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/recebimentos/base', { warehouse_id: 7, ot_code: '1000000101' }));
  });

  it('asks the KG per box as soon as the unit is KG, and sends it with the material', async () => {
    mockUnknownOt();
    apiPost.mockImplementation(() => ok({ ot: '1003329915', created: true, divergences: [] }));
    await openNewReceipt();
    expect(screen.queryByLabelText('KG por caixa')).toBeNull();
    fireEvent.change(screen.getByLabelText('Unidade'), { target: { value: 'kg' } });
    fireEvent.change(await screen.findByLabelText('KG por caixa'), { target: { value: '18' } });
    fireEvent.change(screen.getByLabelText('Ordem de serviço (tipo)'), { target: { value: 'PM11' } });
    fireEvent.change(screen.getByLabelText('Código do material'), { target: { value: '74165325' } });
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '36' } });
    fireEvent.click(screen.getByText('Confirmar cadastro'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/recebimentos', expect.anything()));
    const sent = apiPost.mock.calls.find(([path]) => path === '/sea/recebimentos')[1].materials[0];
    expect(sent).toMatchObject({ material_code: '74165325', quantity: 36, pack_weight_kg: 18 });
  });

  it('does not ask the KG per box for other units', async () => {
    mockUnknownOt();
    await openNewReceipt();
    fireEvent.change(screen.getByLabelText('Unidade'), { target: { value: 'KG' } });
    expect(await screen.findByLabelText('KG por caixa')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Unidade'), { target: { value: 'PC' } });
    expect(screen.queryByLabelText('KG por caixa')).toBeNull();
  });

  it('the label form has no receiver field (the SEA fills it in)', async () => {
    mockUnknownOt();
    await openNewReceipt();
    expect(screen.getByLabelText('Solicitante')).toBeInTheDocument();
    expect(screen.queryByLabelText('Recebedor')).not.toBeInTheDocument();
  });

  it('unknown OT starts a new receipt and the label fills the form', async () => {
    mockUnknownOt();
    apiPost.mockImplementation((path) => (path === '/sea/etiquetas/interpretar' ? ok(PARSED) : ok({ ot: '1003329915', created: true, divergences: [] })));
    await openNewReceipt();
    expect(screen.getByLabelText('Código da OT')).toHaveValue('1003329915');

    fireEvent.change(screen.getByLabelText('Texto da etiqueta'), { target: { value: 'OT: 1003329915' } });
    fireEvent.click(screen.getByText('Interpretar etiqueta'));
    await waitFor(() => expect(screen.getByLabelText('Lote')).toHaveValue('0000245045'));
    expect(screen.getByLabelText('Reserva')).toHaveValue('0285365145 /02');
    // O que não foi lido da etiqueta fica vazio e marcado, nunca adivinhado.
    expect(screen.getByLabelText(/Local de descarga/)).toHaveValue('');
    expect(screen.getByText('Centro de custo 4411')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Confirmar cadastro'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/recebimentos', expect.anything()));
    const body = apiPost.mock.calls.find(([path]) => path === '/sea/recebimentos')[1];
    expect(body.warehouse_id).toBe(7);
    expect(body.source).toBe('ETIQUETA');
    expect(body.header).toMatchObject({ ot_code: '1003329915', reservation_number: '0285365145 /02', service_order_type: 'PM12', unload_location: null });
    expect(body.materials).toEqual([{ material_code: '74165325', description: 'ARAME', quantity: 54, uom: 'KG', pack_weight_kg: null, lot_number: '0000245045', expiry_date: null }]);
    expect(body.unrecognized).toEqual(['Centro de custo 4411']);
  });

  it('does not submit without material code, quantity and service order type', async () => {
    mockUnknownOt();
    apiPost.mockImplementation(() => ok({}));
    await openNewReceipt();
    fireEvent.click(screen.getByText('Confirmar cadastro'));
    expect(await screen.findByRole('alert')).toHaveTextContent('tipo da ordem de serviço');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('shows the duplicate refusal from the API', async () => {
    mockUnknownOt();
    apiPost.mockImplementation((path) => (path === '/sea/etiquetas/interpretar'
      ? ok(PARSED)
      : fail(409, { error: 'O material 74165325 já está cadastrado na OT 1003329915.', user_facing: true, duplicate: true })));
    await openNewReceipt();
    fireEvent.change(screen.getByLabelText('Texto da etiqueta'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Interpretar etiqueta'));
    await waitFor(() => expect(screen.getByLabelText('Lote')).toHaveValue('0000245045'));
    fireEvent.click(screen.getByText('Confirmar cadastro'));
    expect(await screen.findByRole('alert')).toHaveTextContent('já está cadastrado na OT 1003329915');
  });
});

describe('Navegação SEA', () => {
  it('shows only the tabs a USER is allowed to open', async () => {
    currentUser = { role: 'USER', allowed_pages: ['retirada'] };
    apiGet.mockImplementation(() => ok({}));
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.getByText('Painel')).toBeInTheDocument();
    expect(screen.getByText('Retirada')).toBeInTheDocument();
    expect(screen.queryByText('Estoque')).toBeNull();
    expect(screen.queryByText('Usuários')).toBeNull();
  });

  it('the terminal account sees only Retirada (mig 098)', () => {
    currentUser = { role: 'USER', allowed_pages: ['terminal-retirada'] };
    apiGet.mockImplementation(() => ok({}));
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.getByText('Retirada')).toBeInTheDocument();
    for (const label of ['Painel', 'Estoque', 'Usuários']) expect(screen.queryByText(label)).toBeNull();
  });

  it('shows every SEA tab to ADMIN and nothing from the removed SEA pages', () => {
    currentUser = { role: 'ADMIN', allowed_pages: null };
    apiGet.mockImplementation(() => ok({}));
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    for (const label of ['Painel', 'Estoque', 'Recebimento', 'Retirada', 'Usuários', 'Configurações', 'Importação de dados']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Pedidos de venda')).toBeNull();
    expect(screen.queryByText('Webhooks')).toBeNull();
  });

  it('offers Recebimento only while the Recebimento location is selected', () => {
    currentUser = { role: 'ADMIN', allowed_pages: null };
    apiGet.mockImplementation(() => ok({}));
    currentWarehouse = { warehouse_id: 8, warehouse_code: 'SP12' };
    try {
      render(<MemoryRouter><Sidebar /></MemoryRouter>);
      expect(screen.getByText('Estoque')).toBeInTheDocument();
      expect(screen.getByText('Retirada')).toBeInTheDocument();
      expect(screen.queryByText('Recebimento')).toBeNull();
    } finally {
      currentWarehouse = { warehouse_id: 7, warehouse_code: 'Recebimento' };
    }
  });
});

describe('Exclusão de materiais e ordens', () => {
  const apiDelete = vi.fn();
  beforeEach(async () => {
    const { api } = await import('../api.js');
    apiDelete.mockReset();
    api.delete = (...a) => apiDelete(...a);
  });
  const MATERIAL = { row_id: '21-5', item_id: 21, sku: 'MAT-1', item_name: 'Parafuso', quantity: 4, uom: 'PC', order: '2000000011', ot: '1000000101', order_type: 'PM11', is_active: true };
  const ORDER = { po_id: 4, po_number: '1000000101', order_type: 'PM11', status: 'OPEN', created_at: '2026-11-01T10:00:00Z' };

  it('a refused material deletion is explained on the page', async () => {
    currentUser = { role: 'ADMIN', allowed_pages: null };
    apiGet.mockImplementation(() => ok({ items: [MATERIAL], total: 1, page: 1, pages: 1 }));
    apiDelete.mockImplementation(() => fail(409, { error: 'O material MAT-1 tem registros de expedição de pedidos.', user_facing: true }));
    render(<MemoryRouter><Items /></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('Excluir'));
    // O botão da linha e o de confirmação têm o mesmo nome; o de confirmar é o último.
    fireEvent.click(screen.getAllByRole('button', { name: 'Excluir' }).at(-1));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/sea/materiais/21'));
    expect(await screen.findByRole('alert')).toHaveTextContent('tem registros de expedição');
  });

  it('only an administrator sees the delete buttons', async () => {
    currentUser = { role: 'USER', allowed_pages: ['items', 'purchase-orders'] };
    apiGet.mockImplementation(() => ok({ items: [MATERIAL], total: 1, page: 1, pages: 1 }));
    render(<MemoryRouter><Items /></MemoryRouter>);
    await screen.findByText('MAT-1');
    expect(screen.queryByLabelText('Excluir')).toBeNull();
  });

  it('an order is deleted after confirmation', async () => {
    currentUser = { role: 'ADMIN', allowed_pages: null };
    apiGet.mockImplementation(() => ok({ purchase_orders: [ORDER], total: 1, page: 1, pages: 1 }));
    apiDelete.mockImplementation(() => ok({ message: 'Ordem excluída' }));
    render(<MemoryRouter><PurchaseOrders /></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('Excluir ordem 1000000101'));
    expect(apiDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/sea/ots/4'));
  });
});

describe('errorMessage', () => {
  it('shows user_facing API messages and hides everything else', () => {
    expect(errorMessage({ error: 'Capacidade excedida em B0', user_facing: true }, 'x')).toBe('Capacidade excedida em B0');
    expect(errorMessage({ error: 'psycopg2.errors.UniqueViolation ...' }, 'Falhou')).toBe('Falhou');
  });
});

describe('OTs: status filter regression', () => {
  it("'Todos os status' never sends status=Todos to the API", async () => {
    currentUser = { role: 'ADMIN', allowed_pages: null };
    apiGet.mockImplementation(() => ok({ purchase_orders: [], total: 0, page: 1, pages: 1 }));
    render(<MemoryRouter><PurchaseOrders /></MemoryRouter>);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const listCalls = apiGet.mock.calls.map(([p]) => p).filter((p) => p.startsWith('/admin/purchase-orders'));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const p of listCalls) expect(p).not.toMatch(/status=/);
    const option = screen.getByRole('option', { name: 'Todos' });
    expect(option.value).toBe('All');
  });
});

describe('Retirada avaliada antes de ser feita (mig 096)', () => {
  const request = (status, extra = {}) => ({ withdrawal_id: 9, ot: 'OT-1', order_type: 'PM11', status, requested_by: 'retirada', lines: [], ...extra });

  it('the evaluator approves, or denies with a reason', async () => {
    currentUser = { username: 'avaliador', role: 'USER', allowed_pages: ['retirada-avaliar'] };
    apiGet.mockImplementation(() => ok({ withdrawals: [request('REQUESTED')] }));
    apiPost.mockImplementation(() => ok({ message: 'ok' }));
    render(<MemoryRouter><Retirada /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Aprovar'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/retiradas/9/avaliar', { approve: true }));

    fireEvent.click(screen.getByText('Negar'));
    const deny = screen.getByText('Negar retirada');
    expect(deny).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' sem urgência ' } });
    fireEvent.click(deny);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/retiradas/9/avaliar', { approve: false, note: 'sem urgência' }));
    expect(screen.queryByText('Aceitar e separar')).toBeNull();
  });

  it('who does withdrawals accepts an approved request; others only wait', async () => {
    currentUser = { username: 'almoxarife', role: 'USER', allowed_pages: ['retirada-fazer'] };
    apiGet.mockImplementation(() => ok({ withdrawals: [request('APPROVED')] }));
    apiPost.mockImplementation(() => ok({ message: 'ok' }));
    const { unmount } = render(<MemoryRouter><Retirada /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Aceitar e separar'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/retiradas/9/separar', {}));
    unmount();

    currentUser = { username: 'avaliador', role: 'USER', allowed_pages: ['retirada-avaliar'] };
    render(<MemoryRouter><Retirada /></MemoryRouter>);
    expect(await screen.findByText(/aguardando alguém aceitar/)).toBeInTheDocument();
    expect(screen.queryByText('Aceitar e separar')).toBeNull();
  });

  it('the terminal shows the name and photo of who accepted', async () => {
    let status = 'REQUESTED';
    const withdrawal = () => ({ withdrawal_id: 3, status, picked_by: status === 'PICKING' ? 'caique' : null, lines: [{ inventory_id: 11, item_name: 'Parafuso', bin_code: 'A3', quantity: 2 }] });
    apiGet.mockImplementation((path) => {
      if (path === '/sea/ordens/2000000011') return ok(ORDER);
      if (path === '/sea/retiradas/3') return ok({ withdrawal: withdrawal() });
      if (path === '/sea/retiradas/3/responsavel') return ok({ name: 'Caique Lima', photo: 'data:image/png;base64,AAAA' });
      return ok({});
    });
    apiPost.mockImplementation((path) => (path === '/sea/retiradas' ? ok({ withdrawal: withdrawal() }) : ok({})));

    await terminalSignIn();
    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));
    await screen.findByText('Parafuso');
    fireEvent.click(screen.getByLabelText('Aumentar MAT-1'));
    fireEvent.click(screen.getByText('Solicitar retirada'));
    expect(await screen.findByText(/Aguardando a avaliação/)).toBeInTheDocument();

    status = 'PICKING';
    const photo = await screen.findByAltText('Foto de Caique Lima', {}, { timeout: 6000 });
    expect(photo).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(screen.getByText(/está preparando os seus materiais/)).toBeInTheDocument();
  }, 15000);

  it('the terminal tells the employee why a request was denied', async () => {
    let status = 'REQUESTED';
    const withdrawal = () => ({ withdrawal_id: 3, status, evaluation_note: 'Sem urgência', lines: [{ inventory_id: 11, item_name: 'Parafuso', bin_code: 'A3', quantity: 2 }] });
    apiGet.mockImplementation((path) => {
      if (path === '/sea/ordens/2000000011') return ok(ORDER);
      if (path === '/sea/retiradas/3') return ok({ withdrawal: withdrawal() });
      return ok({});
    });
    apiPost.mockImplementation((path) => (path === '/sea/retiradas' ? ok({ withdrawal: withdrawal() }) : ok({})));
    await terminalSignIn();
    fireEvent.change(screen.getByLabelText('Ordem'), { target: { value: '2000000011' } });
    fireEvent.click(screen.getByText('Consultar ordem'));
    await screen.findByText('Parafuso');
    fireEvent.click(screen.getByLabelText('Aumentar MAT-1'));
    fireEvent.click(screen.getByText('Solicitar retirada'));
    await screen.findByText(/Aguardando a avaliação/);
    status = 'REJECTED';
    expect(await screen.findByText(/negada: Sem urgência/, {}, { timeout: 6000 })).toBeInTheDocument();
  }, 15000);
});
