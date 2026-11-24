// Só funções puras, testadas sem o React Native.

// Recebimento e armazenagem só aparecem com o local Recebimento selecionado, como no painel.
export const RECEBIMENTO_CODE = 'Recebimento';

// Material em KG com peso de caixa é contado em caixas: 36 KG em caixas de 18 KG = "2 cx (36 KG)".
export function formatQuantity(quantity, uom, packWeightKg) {
  if (quantity == null) return '-';
  if (packWeightKg) {
    const boxes = quantity / packWeightKg;
    const count = Number.isInteger(boxes) ? boxes : boxes.toFixed(1).replace('.', ',');
    return `${count} cx (${quantity} KG)`;
  }
  return uom ? `${quantity} ${uom}` : String(quantity);
}

export function orderName(row) {
  if (!row) return '-';
  return [row.order_type, row.order_number].filter(Boolean).join(' ') || '-';
}

// Um módulo aparece para o administrador, para quem tem uma das permissões dele ou, nos dois
// módulos originais, a função de celular correspondente. ``onlyAt`` limita a um local.
export const MODULES = [
  { key: 'receive', label: 'RECEBER', sub: 'Recebimento de ordem', screen: 'Receber', accent: 'red', fn: 'receive', pages: ['receiving'], onlyAt: RECEBIMENTO_CODE },
  { key: 'putaway', label: 'ARMAZENAR', sub: 'Guardar o que foi recebido', screen: 'Armazenar', accent: 'copper', fn: 'putaway', pages: ['putaway'], onlyAt: RECEBIMENTO_CODE },
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

// Avaliar pede "retirada-avaliar"; aceitar e concluir pedem "retirada-fazer".
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
  // Depois do aceite, só quem aceitou dá andamento.
  if (w.status === 'PICKING' && canDo && (!w.picked_by || w.picked_by === me?.username)) {
    return [{ action: 'pronta', label: 'PRONTA PARA ENTREGA', done: `Retirada nº ${w.withdrawal_id} pronta. O funcionário confirma no terminal.` }];
  }
  return [];
}

export function apiError(err, fallback) {
  if (err?.isTimeout) return 'O servidor demorou a responder. Verifique a rede e tente de novo.';
  if (!err?.response) return 'Sem conexão com o servidor. Verifique a rede e o endereço do servidor.';
  const data = err.response.data;
  if (err.response.status === 403 && !(data && data.user_facing)) return 'Você não tem permissão para esta ação.';
  if (err.response.status >= 502 && err.response.status <= 504) return 'O servidor do SEA está iniciando ou fora do ar. Tente de novo em instantes.';
  if (data && typeof data.error === 'string' && data.user_facing) return data.error;
  return fallback;
}

export function parseQuantity(text) {
  const clean = String(text ?? '').trim();
  if (!/^\d+$/.test(clean)) return null;
  const value = Number(clean);
  return value > 0 ? value : null;
}

// Material com peso de caixa só anda em caixas inteiras.
export function quantityProblem(text, { max, packWeightKg } = {}) {
  const value = parseQuantity(text);
  if (value === null) return 'Informe a quantidade (número inteiro maior que zero).';
  if (max != null && value > max) return `A quantidade é maior que o saldo (${max}).`;
  if (packWeightKg && value % packWeightKg) return `Este material vai por caixa de ${packWeightKg} KG: informe caixas inteiras.`;
  return null;
}

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
