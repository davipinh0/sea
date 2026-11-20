// Depois da digital/PIN, o app avisa a API por 15 minutos (o mesmo prazo da liberação no painel), e
// o log registra "Usuário autenticado (Digital/PIN no app)".

export const IDENTITY_HEADER = 'X-SEA-Identidade';
export const IDENTITY_WINDOW_MS = 15 * 60 * 1000;

let confirmedAt = 0;

export function markIdentityConfirmed(now = Date.now()) {
  confirmedAt = now;
}

export function clearIdentityConfirmed() {
  confirmedAt = 0;
}

export function identityHeaders(now = Date.now()) {
  return confirmedAt && now - confirmedAt <= IDENTITY_WINDOW_MS
    ? { [IDENTITY_HEADER]: 'digital-pin' }
    : {};
}
