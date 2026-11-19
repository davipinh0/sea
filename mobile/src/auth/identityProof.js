// SEA: the processes that require authentication (receive, store,
// withdrawal) are confirmed with the fingerprint or the phone's PIN. For
// a while after that confirmation the app tells the API, which records
// "Usuário autenticado (Digital/PIN no app)" on the log of what was done.
// The window matches the panel's release by the phone (15 minutes).

export const IDENTITY_HEADER = 'X-SEA-Identidade';
export const IDENTITY_WINDOW_MS = 15 * 60 * 1000;

let confirmedAt = 0;

export function markIdentityConfirmed(now = Date.now()) {
  confirmedAt = now;
}

export function clearIdentityConfirmed() {
  confirmedAt = 0;
}

// Header to send with a request: empty when the confirmation is too old.
export function identityHeaders(now = Date.now()) {
  return confirmedAt && now - confirmedAt <= IDENTITY_WINDOW_MS
    ? { [IDENTITY_HEADER]: 'digital-pin' }
    : {};
}
