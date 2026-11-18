// SEA: Histórico in the app (movements of the location and the full log).
// Labels mirror admin/src/utils/sea.js so both read the same.

export const ACTION_LABELS = {
  RECEIVE: 'Recebimento',
  USER_PHOTO: 'Foto do usuário',
  LOGIN_APPROVAL_REQUESTED: 'Login aguardando o celular',
  LOGIN_APPROVED: 'Login confirmado no celular',
  LOGIN_DENIED: 'Login negado no celular',
  LOGIN_APPROVAL_SETTING: 'Confirmação de login no celular',
  USER_DEVICES_REMOVED: 'Celulares do usuário removidos',
  RECEIVE_CANCEL: 'Estorno de recebimento',
  UNRECEIVE: 'Estorno de recebimento',
  PUTAWAY: 'Armazenagem',
  STOCK_TRANSFERRED: 'Transferência entre endereços',
  TRANSFER: 'Transferência entre endereços',
  ADJUST: 'Ajuste de estoque',
  COUNT: 'Contagem de estoque',
  PO_STATUS_CHANGED: 'Status da ordem alterado',
  OT_REGISTERED: 'Ordem cadastrada',
  OT_MATERIAL_ADDED: 'Material adicionado à ordem',
  OT_DATA_EDITED: 'Dados da ordem corrigidos',
  OT_MATERIAL_EDITED: 'Material da ordem corrigido',
  OT_MATERIAL_REMOVED: 'Material removido da ordem',
  OT_DELETED: 'Ordem excluída',
  MATERIAL_DELETED: 'Material excluído',
  SAP_BASE_IMPORTED: 'Base do SAP importada',
  WITHDRAWAL_REQUESTED: 'Retirada solicitada',
  WITHDRAWAL_PICKING: 'Separação iniciada',
  WITHDRAWAL_READY: 'Separação concluída',
  WITHDRAWAL_DELIVERED: 'Retirada entregue (baixa)',
  WITHDRAWAL_CANCELLED: 'Retirada cancelada',
  CANCEL: 'Cancelamento',
  password_change: 'Senha alterada',
  forced_password_change_completed: 'Senha inicial trocada',
};

function readable(code) {
  const text = String(code).replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function actionLabel(action) {
  return action ? ACTION_LABELS[action] || readable(action) : '-';
}

// One line of detail of a movement (same as the panel Painel).
export function describeMovement(entry) {
  const d = entry?.details || {};
  const parts = [];
  const order = d.ot || d.po_number || d.lot_number;
  if (order) parts.push(/^OT/i.test(order) ? order : `OT ${order}`);
  if (d.sku) parts.push(d.sku);
  if (d.quantity) parts.push(`${d.quantity} un.`);
  if (d.to_bin_code) parts.push(`→ ${d.to_bin_code}`);
  if (d.employee_name) parts.push(`para ${d.employee_name}`);
  if (d.reason) parts.push(`motivo: ${d.reason}`);
  return parts.join(' · ');
}

export function whenText(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// Who may open Histórico: administrators and users granted "Histórico".
export function canSeeHistory(me) {
  if (!me) return false;
  return me.role === 'ADMIN' || (me.allowed_pages || []).includes('audit-log');
}
