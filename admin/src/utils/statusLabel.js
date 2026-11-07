// Display labels (pt-BR) for status codes returned by the API.
// Status values themselves stay in English: they are compared in code,
// sent as query params and stored in the database. Translate only here.
const STATUS_LABELS = {
  All: 'Todos',
  ACTIVE: 'Ativo',
  ALLOCATED: 'Alocado',
  APPROVED: 'Aprovado',
  ARCHIVED: 'Arquivado',
  CANCELLED: 'Cancelado',
  CLOSED: 'Fechado',
  COMPLETE: 'Concluído',
  COMPLETED: 'Concluído',
  DRAFT: 'Rascunho',
  FRAUD_REVIEW: 'Análise de fraude',
  IN_PROGRESS: 'Em andamento',
  INACTIVE: 'Inativo',
  LOW: 'Baixo',
  OPEN: 'Aberto',
  PACKED: 'Embalado',
  PARTIAL: 'Parcial',
  PARTIALLY_RECEIVED: 'Recebido parcialmente',
  PAUSED: 'Pausado',
  PENDING: 'Pendente',
  PICKED: 'Separado',
  READY: 'Pronto',
  RECEIVED: 'Recebido',
  REFUNDED: 'Reembolsado',
  REJECTED: 'Rejeitado',
  REVOKED: 'Revogado',
  SHIPPED: 'Expedido',
  SHORT: 'Falta',
  SUBMITTED: 'Enviado',
  VARIANCE: 'Divergência',
  VOIDED: 'Anulado',
  WAITING_STOCK: 'Aguardando estoque',
  'Ready to pick': 'Pronto para separar',
};

/** Return the pt-BR label for a status code, or the code itself when unknown. */
export function statusLabel(status) {
  if (status === null || status === undefined) return status;
  return STATUS_LABELS[status] ?? status;
}
