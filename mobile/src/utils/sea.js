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

// Modules of the app. A module shows when the user is an administrator,
// holds one of its page permissions (Sistema > Usuários) or, for the two
// original modules, the matching mobile function. ``onlyAt`` limits it to
// one location.
export const MODULES = [
  { key: 'receive', label: 'RECEBER', sub: 'Recebimento de ordem', screen: 'Receber', accent: 'red', fn: 'receive', pages: ['receiving'], onlyAt: EXPEDICAO_CODE },
  { key: 'putaway', label: 'ARMAZENAR', sub: 'Guardar o que foi recebido', screen: 'Armazenar', accent: 'copper', fn: 'putaway', pages: ['putaway'], onlyAt: EXPEDICAO_CODE },
  { key: 'retirada', label: 'RETIRADA', sub: 'Fila de solicitações', screen: 'Retirada', accent: 'red', pages: ['retirada'] },
  { key: 'transfer', label: 'TRANSFERIR', sub: 'Entre endereços e locais', screen: 'Transferir', accent: 'gray', pages: ['items', 'inventory', 'putaway'] },
  { key: 'estoque', label: 'ESTOQUE', sub: 'O que há em cada endereço', screen: 'Estoque', accent: 'copper', pages: ['inventory'] },
  { key: 'ordens', label: 'ORDENS', sub: 'Consulta de OTs e materiais', screen: 'Ordens', accent: 'gray', pages: ['inventory', 'purchase-orders', 'receiving', 'putaway', 'retirada'] },
  // Every user follows the notifications of the locations they work in.
  { key: 'notificacoes', label: 'NOTIFICAÇÕES', sub: 'Avisos do sistema', screen: 'Notificacoes', accent: 'red', pages: [], everyone: true },
];

export function visibleModules(me, warehouseCode) {
  if (!me) return [];
  const pages = me.allowed_pages || [];
  const functions = me.allowed_functions || [];
  return MODULES.filter((m) => {
    if (m.onlyAt && warehouseCode !== m.onlyAt) return false;
    if (me.role === 'ADMIN' || m.everyone) return true;
    return (m.fn && functions.includes(m.fn)) || m.pages.some((p) => pages.includes(p));
  });
}

// Message of a failed request, written for the operator.
export function apiError(err, fallback) {
  if (err?.isTimeout) return 'O servidor demorou a responder. Verifique a rede e tente de novo.';
  if (!err?.response) return 'Sem conexão com o servidor. Verifique a rede e o endereço do servidor.';
  const data = err.response.data;
  if (err.response.status === 403) return 'Você não tem permissão para esta ação.';
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
