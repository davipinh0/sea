// Logins confirmados no celular cadastrado.

function pad(n) {
  return String(n).padStart(2, '0');
}

// Processos do painel liberados pelo celular.
export const PROCESS_LABELS = { recebimento: 'Recebimento', armazenagem: 'Armazenagem', retirada: 'Retirada', 'exclusao-usuario': 'Exclusão de usuário' };

export function approvalSummary(pending, now = new Date()) {
  const created = pending.created_at ? new Date(pending.created_at) : null;
  const sameDay = created && created.toDateString() === now.toDateString();
  const time = created ? `${pad(created.getHours())}:${pad(created.getMinutes())}` : '';
  const left = Math.max(0, pending.seconds_left ?? 0);
  const process = pending.purpose ? PROCESS_LABELS[pending.purpose] || pending.purpose : null;
  return {
    title: process ? `Liberar ${process} no painel web?` : 'Você está entrando no SEA?',
    client: pending.client || 'Navegador',
    ip: pending.client_ip || '',
    when: created ? (sameDay ? `Hoje às ${time}` : `${pad(created.getDate())}/${pad(created.getMonth() + 1)} às ${time}`) : '',
    timeLeft: left >= 60 ? `${Math.floor(left / 60)} min ${pad(left % 60)} s` : `${left} s`,
  };
}

export function approvalEndMessage(status) {
  switch (status) {
    case 403: return 'O acesso foi negado no celular cadastrado.';
    case 410: return 'O tempo para confirmar acabou. Entre de novo.';
    case 404: return 'Tentativa de login não encontrada. Entre de novo.';
    default: return 'Não foi possível confirmar o login. Tente de novo.';
  }
}
