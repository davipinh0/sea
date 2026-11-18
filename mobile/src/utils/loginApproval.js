// SEA (mig 092): logins confirmed on the registered phone.

function pad(n) {
  return String(n).padStart(2, '0');
}

// What the phone shows about a login waiting for it.
export function approvalSummary(pending, now = new Date()) {
  const created = pending.created_at ? new Date(pending.created_at) : null;
  const sameDay = created && created.toDateString() === now.toDateString();
  const time = created ? `${pad(created.getHours())}:${pad(created.getMinutes())}` : '';
  const left = Math.max(0, pending.seconds_left ?? 0);
  return {
    client: pending.client || 'Navegador',
    ip: pending.client_ip || '',
    when: created ? (sameDay ? `Hoje às ${time}` : `${pad(created.getDate())}/${pad(created.getMonth() + 1)} às ${time}`) : '',
    timeLeft: left >= 60 ? `${Math.floor(left / 60)} min ${pad(left % 60)} s` : `${left} s`,
  };
}

// Message for the end of a wait on another phone's confirmation.
export function approvalEndMessage(status) {
  switch (status) {
    case 403: return 'O acesso foi negado no celular cadastrado.';
    case 410: return 'O tempo para confirmar acabou. Entre de novo.';
    case 404: return 'Tentativa de login não encontrada. Entre de novo.';
    default: return 'Não foi possível confirmar o login. Tente de novo.';
  }
}
