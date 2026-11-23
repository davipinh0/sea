// Os nomes das operações seguem os do painel (admin/src/utils/sea.js).

export const ACTION_LABELS = {
  RECEIVE: 'Recebimento',
  USER_PHOTO: 'Foto do usuário',
  LOGIN_APPROVAL_REQUESTED: 'Login aguardando o celular',
  LOGIN_APPROVED: 'Login confirmado no celular',
  LOGIN_DENIED: 'Login negado no celular',
  LOGIN_APPROVAL_SETTING: 'Confirmação de login no celular',
  USER_DEVICES_REMOVED: 'Celulares do usuário removidos',
  USER_SESSIONS_ENDED: 'Aparelhos desconectados pelo usuário',
  USER_DELETED: 'Usuário excluído',
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
  WITHDRAWAL_PICKING: 'Retirada aceita (separação iniciada)',
  WITHDRAWAL_APPROVED: 'Retirada aprovada',
  WITHDRAWAL_REJECTED: 'Retirada negada',
  PROCESS_APPROVAL_REQUESTED: 'Processo aguardando o celular',
  PROCESS_APPROVED: 'Processo liberado no celular',
  PROCESS_DENIED: 'Processo negado no celular',
  PO_LINE_ADDED: 'Material adicionado à ordem',
  PO_LINE_UPDATED: 'Material da ordem alterado',
  PO_LINE_REMOVED: 'Material removido da ordem',
  LOGIN_LOCKOUT_MINUTES: 'Bloqueio de login alterado',
  WITHDRAWAL_READY: 'Separação concluída',
  WITHDRAWAL_DELIVERED: 'Retirada entregue (baixa)',
  WITHDRAWAL_CANCELLED: 'Retirada cancelada',
  CANCEL: 'Cancelamento',
  password_change: 'Senha alterada',
  forced_password_change_completed: 'Senha inicial trocada',
};

// Palavras de um código sem tradução, em português, para nada aparecer em inglês.
const WORDS = {
  WITHDRAWAL: 'retirada', RECEIVE: 'recebimento', RECEIVED: 'recebido', PUTAWAY: 'armazenagem',
  TRANSFER: 'transferência', STOCK: 'estoque', ITEM: 'material', BIN: 'endereço', PO: 'ordem',
  LINE: 'linha', USER: 'usuário', LOGIN: 'login', APPROVAL: 'aprovação', APPROVED: 'aprovado',
  REJECTED: 'negado', DENIED: 'negado', REQUESTED: 'solicitado', CANCELLED: 'cancelado',
  CANCEL: 'cancelamento', CREATED: 'criado', CREATE: 'criação', UPDATED: 'alterado',
  UPDATE: 'alteração', DELETED: 'excluído', DELETE: 'exclusão', ADDED: 'adicionado',
  REMOVED: 'removido', STATUS: 'status', CHANGED: 'alterado', READY: 'pronto',
  DELIVERED: 'entregue', PICKING: 'separação', PROCESS: 'processo', SETTING: 'configuração',
  PASSWORD: 'senha', CHANGE: 'troca', TOKEN: 'token', ISSUE: 'emissão', REVOKE: 'revogação',
};

function readable(code) {
  const text = String(code).split('_').map((w) => WORDS[w.toUpperCase()] || w.toLowerCase()).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function actionLabel(action) {
  return action ? ACTION_LABELS[action] || readable(action) : '-';
}

// Ao abrir um registro: a ordem (PM12 - número, nunca a OT), o material e como o usuário se
// autenticou.
export function orderText(entry) {
  const orders = entry?.orders || [];
  if (orders.length === 0) return null;
  return `${orders.length > 1 ? 'Ordens' : 'Ordem'} ${orders.join(', ')}`;
}

export function describeMovement(entry) {
  const d = entry?.details || {};
  const parts = [];
  if (d.sku) parts.push(`Material ${d.sku}`);
  if (d.quantity) parts.push(`quantidade ${d.quantity}`);
  if (d.to_bin_code) parts.push(`destino ${d.to_bin_code}`);
  if (d.employee_name) parts.push(`entregue para ${d.employee_name}`);
  if (d.requester_email) parts.push(`solicitante ${d.requester_email}`);
  if (d.reason) parts.push(`motivo: ${d.reason}`);
  // Remoção de celulares: um ou mais motivos e a observação.
  if (Array.isArray(d.motivos) && d.motivos.length) {
    parts.push(`motivo: ${d.motivos.join(', ')}${d.observacao ? ` (${d.observacao})` : ''}`);
  }
  return parts.join(' · ');
}

export function authText(entry) {
  const how = entry?.details?.autenticacao;
  return how ? `Usuário autenticado (${how})` : null;
}

export function whenText(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function canSeeHistory(me) {
  if (!me) return false;
  return me.role === 'ADMIN' || (me.allowed_pages || []).includes('audit-log');
}
