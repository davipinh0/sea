import { friendlyError } from './friendlyError.js';

// Sem componentes aqui, para o fast refresh do React continuar funcionando.

export function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// Datas sem horário são formatadas sem passar por Date, que mudaria o dia por causa do fuso.
export function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '-';
}

// OT, reserva e ordem de serviço são três identificadores diferentes.
export const OT_HEADER_FIELDS = [
  { key: 'origin_company', label: 'Empresa de origem' },
  { key: 'label_date', label: 'Data da etiqueta', type: 'date' },
  { key: 'reservation_number', label: 'Reserva' },
  { key: 'needed_date', label: 'Data necessária', type: 'date' },
  { key: 'service_order_type', label: 'Ordem de serviço (tipo)', options: ['PM11', 'PM12'] },
  { key: 'service_order_number', label: 'Ordem de serviço (número)' },
  { key: 'department', label: 'Departamento' },
  { key: 'pickup_location', label: 'Local de retirada' },
  { key: 'unload_location', label: 'Local de descarga' },
  { key: 'requester_name', label: 'Solicitante' },
  { key: 'receiver_name', label: 'Recebedor', readOnly: true },
];

export const OT_HEADER_FORM = OT_HEADER_FIELDS.filter((f) => !f.readOnly);

export const EXPEDICAO_CODE = 'Expedição';

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

export const OT_MATERIAL_FIELDS = [
  { key: 'material_code', label: 'Código do material' },
  { key: 'description', label: 'Descrição' },
  { key: 'quantity', label: 'Quantidade', type: 'number' },
  { key: 'uom', label: 'Unidade' },
  { key: 'lot_number', label: 'Lote' },
  { key: 'expiry_date', label: 'Vencimento', type: 'date' },
];

export const ACTION_LABELS = {
  RECEIVE: 'Recebimento',
  USER_PHOTO: 'Foto do usuário',
  LOGIN_APPROVAL_REQUESTED: 'Login aguardando o celular',
  LOGIN_APPROVED: 'Login confirmado no celular',
  LOGIN_DENIED: 'Login negado no celular',
  LOGIN_APPROVAL_SETTING: 'Confirmação de login no celular',
  USER_DEVICES_REMOVED: 'Celulares do usuário removidos',
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
  WITHDRAWAL_APPROVED: 'Retirada aprovada',
  WITHDRAWAL_REJECTED: 'Retirada negada',
  WITHDRAWAL_PICKING: 'Retirada aceita (separação iniciada)',
  PROCESS_APPROVAL_REQUESTED: 'Processo aguardando o celular',
  PROCESS_APPROVED: 'Processo liberado no celular',
  PROCESS_DENIED: 'Processo negado no celular',
  WITHDRAWAL_READY: 'Separação concluída',
  WITHDRAWAL_DELIVERED: 'Retirada entregue (baixa)',
  WITHDRAWAL_CANCELLED: 'Retirada cancelada',
  PO_LINE_ADDED: 'Material adicionado à ordem',
  PO_LINE_UPDATED: 'Material da ordem alterado',
  PO_LINE_REMOVED: 'Material removido da ordem',
  LOGIN_LOCKOUT_MINUTES: 'Bloqueio de login alterado',
  CANCEL: 'Cancelamento',
  password_change: 'Senha alterada',
  forced_password_change_completed: 'Senha inicial trocada',
};

export const ENTITY_LABELS = {
  PO: 'Ordem',
  ITEM: 'Material',
  BIN: 'Endereço',
  INVENTORY: 'Estoque',
  WITHDRAWAL: 'Retirada',
  SAP_BASE: 'Base do SAP',
  WAREHOUSE: 'Local',
  USER: 'Usuário',
  user: 'Usuário',
  SETTING: 'Configuração',
};

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

export function entityLabel(entity) {
  return entity ? ENTITY_LABELS[entity] || readable(entity) : '-';
}

export const MOVEMENT_LABELS = {
  RECEBIMENTO: 'Recebimento',
  ARMAZENAMENTO: 'Armazenamento',
  TRANSFERENCIA: 'Transferência',
  RETIRADA: 'Retirada',
};

export function fieldsToPayload(fields, values) {
  const out = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? '').toString().trim();
    if (raw === '') out[f.key] = null;
    else out[f.key] = f.type === 'number' ? Number(raw) : raw;
  }
  return out;
}

export function payloadToFields(fields, values) {
  return Object.fromEntries(fields.map((f) => [f.key, values?.[f.key] == null ? '' : String(values[f.key])]));
}

// Erros de regra do SEA vêm escritos para o operador (user_facing); os demais passam por
// friendlyError, para nunca mostrar mensagens internas.
export function errorMessage(payload, fallback) {
  if (payload && payload.user_facing === true && typeof payload.error === 'string') {
    return payload.error;
  }
  return friendlyError(payload, fallback);
}

export async function readError(res, fallback) {
  try {
    return errorMessage(await res.json(), fallback);
  } catch {
    return fallback;
  }
}
