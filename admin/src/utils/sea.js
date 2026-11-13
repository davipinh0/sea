import { friendlyError } from './friendlyError.js';

// SEA UI helpers shared by the SEA pages (no components here so React
// fast refresh keeps working for the component modules).

export function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// Date-only values (ISO yyyy-mm-dd) shown as dd/mm/aaaa without going
// through Date, which would shift the day across time zones.
export function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '-';
}

// Receipt header as printed on the label. OT, reserva and ordem de
// serviço are three different identifiers and each has its own field.
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
  // Filled in by the SEA with the user who registers the delivery.
  { key: 'receiver_name', label: 'Recebedor', readOnly: true },
];

// What the operator types or corrects (everything but the receiver).
export const OT_HEADER_FORM = OT_HEADER_FIELDS.filter((f) => !f.readOnly);

// Code of the location where orders arrive. The Expedição section
// (receiving, storage, orders, SAP) is only offered while it is selected.
export const EXPEDICAO_CODE = 'Expedição';

export const OT_MATERIAL_FIELDS = [
  { key: 'material_code', label: 'Código do material' },
  { key: 'description', label: 'Descrição' },
  { key: 'quantity', label: 'Quantidade', type: 'number' },
  { key: 'uom', label: 'Unidade' },
  { key: 'lot_number', label: 'Lote' },
  { key: 'expiry_date', label: 'Vencimento', type: 'date' },
];

export const MOVEMENT_LABELS = {
  RECEBIMENTO: 'Recebimento',
  ARMAZENAMENTO: 'Armazenamento',
  TRANSFERENCIA: 'Transferência',
  RETIRADA: 'Retirada',
};

// Form state keeps every value as a string; the API wants null for a
// blank ("pendente") and a number for the quantity.
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

// SEA business-rule errors are written for the operator and flagged
// user_facing by the API; everything else goes through friendlyError so
// raw backend diagnostics are never shown (V-021).
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
