// Alteração salva no painel: a API responde 428 pedindo o motivo e a confirmação no celular
// (require_justified_change). api.js chama o pedido registrado aqui pela janela do motivo
// (ChangeConfirmDialog), que devolve o motivo depois da confirmação, ou null se a pessoa desistiu.

export const CHANGE_PURPOSE = 'alteracao';
export const CHANGE_REASON_HEADER = 'X-SEA-Motivo';
export const CHANGE_REASON_MIN = 10;
export const CHANGE_REASON_MAX = 500;

// Um salvamento pode levar mais de um pedido (dados e permissões de um usuário): os que vêm logo
// depois da confirmação usam o mesmo motivo, sem perguntar de novo. Salvar outra vez pergunta.
export const SAME_SAVE_MS = 15000;

let askReason = null;
let recent = null;

export function setChangeConfirmHandler(handler) {
  askReason = handler;
  return () => { if (askReason === handler) askReason = null; };
}

export async function confirmChange(request, now = () => Date.now()) {
  if (recent && now() - recent.at < SAME_SAVE_MS) return recent.reason;
  const reason = askReason ? await askReason(request) : null;
  recent = reason ? { reason, at: now() } : null;
  return reason;
}

export function forgetRecentChange() {
  recent = null;
}

// Os acentos não podem ir crus num cabeçalho HTTP.
export function reasonHeader(reason) {
  return { [CHANGE_REASON_HEADER]: encodeURIComponent(reason) };
}

export function reasonProblem(reason) {
  const clean = (reason || '').trim().replace(/\s+/g, ' ');
  if (clean.length < CHANGE_REASON_MIN) return `Escreva o motivo com pelo menos ${CHANGE_REASON_MIN} caracteres.`;
  if (clean.length > CHANGE_REASON_MAX) return `O motivo pode ter no máximo ${CHANGE_REASON_MAX} caracteres.`;
  return null;
}
