// SEA helpers shared by the mobile screens. Pure functions only (they are
// unit-tested without React Native).

// Code of the location where orders arrive. Receiving and storage are
// only offered while it is selected, like the Expedição section of the panel.
export const EXPEDICAO_CODE = 'Expedição';

// Quantity as the operator reads it. A material kept in KG with a box
// weight is counted in boxes: 36 KG in boxes of 18 KG = "2 cx (36 KG)".
export function formatQuantity(quantity, uom, packWeightKg) {
  if (quantity == null) return '-';
  if (packWeightKg) {
    const boxes = quantity / packWeightKg;
    const count = Number.isInteger(boxes) ? boxes : boxes.toFixed(1).replace('.', ',');
    return `${count} cx (${quantity} KG)`;
  }
  return uom ? `${quantity} ${uom}` : String(quantity);
}

// How a material is named on screen: by its order, e.g. "PM12 2002349234".
export function orderName(row) {
  if (!row) return '-';
  return [row.order_type, row.order_number].filter(Boolean).join(' ') || '-';
}

// Modules of the app. A module shows when the user is an administrator,
// holds one of its page permissions (Sistema > Usuários) or, for the two
// original modules, the matching mobile function. ``onlyAt`` limits it to
// one location.
export const MODULES = [
  { key: 'receive', label: 'RECEBER', sub: 'Recebimento de ordem', screen: 'Receber', accent: 'red', fn: 'receive', pages: ['receiving'], onlyAt: EXPEDICAO_CODE },
  { key: 'putaway', label: 'ARMAZENAR', sub: 'Guardar o que foi recebido', screen: 'Armazenar', accent: 'copper', fn: 'putaway', pages: ['putaway'], onlyAt: EXPEDICAO_CODE },
  { key: 'retirada', label: 'RETIRADA', sub: 'Fila de solicitações', screen: 'Retirada', accent: 'red', pages: ['retirada', 'retirada-avaliar', 'retirada-fazer'] },
  { key: 'transfer', label: 'TRANSFERIR', sub: 'Entre endereços e locais', screen: 'Transferir', accent: 'gray', pages: ['items', 'inventory', 'putaway'] },
  { key: 'estoque', label: 'ESTOQUE', sub: 'O que há em cada endereço', screen: 'Estoque', accent: 'copper', pages: ['inventory'] },
  { key: 'ordens', label: 'ORDENS', sub: 'Consulta de OTs e materiais', screen: 'Ordens', accent: 'gray', pages: ['inventory', 'purchase-orders', 'receiving', 'putaway', 'retirada'] },
  { key: 'historico', label: 'HISTÓRICO', sub: 'Movimentações e log', screen: 'Historico', accent: 'gray', pages: ['audit-log'] },
];

export function visibleModules(me, warehouseCode) {
  if (!me) return [];
  const pages = me.allowed_pages || [];
  const functions = me.allowed_functions || [];
  return MODULES.filter((m) => {
    if (m.onlyAt && warehouseCode !== m.onlyAt) return false;
    if (me.role === 'ADMIN') return true;
    return (m.fn && functions.includes(m.fn)) || m.pages.some((p) => pages.includes(p));
  });
}

// mig 096: what the user may do with a withdrawal of the queue.
// Evaluate needs "retirada-avaliar"; accept and finish need "retirada-fazer".
export function withdrawalActions(w, me) {
  const pages = me?.allowed_pages || [];
  const admin = me?.role === 'ADMIN';
  const canEvaluate = admin || pages.includes('retirada-avaliar');
  const canDo = admin || pages.includes('retirada-fazer');
  if (w.status === 'REQUESTED' && canEvaluate) {
    return [
      { action: 'avaliar', label: 'APROVAR', body: { approve: true }, done: `Retirada nº ${w.withdrawal_id} aprovada.` },
      { action: 'avaliar', label: 'NEGAR', deny: true },
    ];
  }
  if (w.status === 'APPROVED' && canDo) {
    return [{ action: 'separar', label: 'ACEITAR E SEPARAR', done: `Retirada nº ${w.withdrawal_id} aceita: prepare o material.` }];
  }
  // mig 098: once accepted, only who accepted carries it on.
  if (w.status === 'PICKING' && canDo && (!w.picked_by || w.picked_by === me?.username)) {
    return [{ action: 'pronta', label: 'PRONTA PARA ENTREGA', done: `Retirada nº ${w.withdrawal_id} pronta. O funcionário confirma no terminal.` }];
  }
  return [];
}

// Message of a failed request, written for the operator.
export function apiError(err, fallback) {
  if (err?.isTimeout) return 'O servidor demorou a responder. Verifique a rede e tente de novo.';
  if (!err?.response) return 'Sem conexão com o servidor. Verifique a rede e o endereço do servidor.';
  const data = err.response.data;
  if (err.response.status === 403 && !(data && data.user_facing)) return 'Você não tem permissão para esta ação.';
  if (err.response.status >= 502 && err.response.status <= 504) return 'O servidor do SEA está iniciando ou fora do ar. Tente de novo em instantes.';
  if (data && typeof data.error === 'string' && data.user_facing) return data.error;
  return fallback;
}

// Whole number typed by the operator, or null.
export function parseQuantity(text) {
  const clean = String(text ?? '').trim();
  if (!/^\d+$/.test(clean)) return null;
  const value = Number(clean);
  return value > 0 ? value : null;
}

// Why a quantity cannot be used, or null. ``max`` is the balance that may
// move; a material with a box weight only goes in whole boxes.
export function quantityProblem(text, { max, packWeightKg } = {}) {
  const value = parseQuantity(text);
  if (value === null) return 'Informe a quantidade (número inteiro maior que zero).';
  if (max != null && value > max) return `A quantidade é maior que o saldo (${max}).`;
  if (packWeightKg && value % packWeightKg) return `Este material vai por caixa de ${packWeightKg} KG: informe caixas inteiras.`;
  return null;
}

// Addresses grouped by location, for the destination lists.
export function groupByLocation(bins, excludeBinId) {
  const groups = [];
  for (const bin of bins || []) {
    if (bin.bin_id === excludeBinId) continue;
    let group = groups.find((g) => g.code === bin.warehouse_code);
    if (!group) {
      group = { code: bin.warehouse_code, name: bin.warehouse_name, bins: [] };
      groups.push(group);
    }
    group.bins.push(bin);
  }
  return groups;
}
