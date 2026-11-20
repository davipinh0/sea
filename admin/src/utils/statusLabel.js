// Os códigos de status continuam em inglês (são comparados no código e gravados no banco); a
// tradução fica só aqui.
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
  DELIVERED: 'Entregue',
  DRAFT: 'Rascunho',
  FRAUD_REVIEW: 'Análise de fraude',
  IN_PROGRESS: 'Em andamento',
  INACTIVE: 'Inativo',
  LOW: 'Baixo',
  OPEN: 'Aberto',
  PACKED: 'Embalado',
  PARTIAL: 'Recebimento parcial',
  PARTIALLY_RECEIVED: 'Recebido parcialmente',
  PAUSED: 'Pausado',
  PENDING: 'Pendente',
  PICKED: 'Separado',
  PICKING: 'Em separação',
  READY: 'Pronto',
  RECEIVED: 'Recebido',
  REFUNDED: 'Reembolsado',
  REQUESTED: 'Aguardando avaliação',
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

export function statusLabel(status) {
  if (status === null || status === undefined) return status;
  return STATUS_LABELS[status] ?? status;
}
