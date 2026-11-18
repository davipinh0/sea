// App lock: after the first password login on a phone the user registers
// the fingerprint; from then on the app locks whenever it goes to the
// background or is closed, and the fingerprint (or the account password)
// unlocks it. The lock screen covers the screens without unmounting them,
// so whatever was in progress is still there after unlocking.
//
// The rules live here, apart from React, so they can be tested.

// SecureStore key with the user that registered the fingerprint on this
// phone. It is not an auth key: logging out keeps it.
export const BIOMETRIC_USER_KEY = 'sea_biometric_user';

// Android system dialogs started by the app itself (camera or notification
// permission, the device PIN screen of the fingerprint prompt) put the app
// in the background for a moment; those must not lock it.
let suspended = 0;

export function suspendLock() {
  suspended += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspended = Math.max(0, suspended - 1);
  };
}

export function isLockSuspended() {
  return suspended > 0;
}

// Runs ``fn`` (which may open a system dialog) without locking the app.
// The release waits a little: the "active" event of the app can arrive
// just after the dialog's promise resolves.
export async function withoutLock(fn, releaseDelayMs = 700) {
  const release = suspendLock();
  try {
    return await fn();
  } finally {
    setTimeout(release, releaseDelayMs);
  }
}

// Whether a change of the app state must lock the app.
export function shouldLock(nextState, { enabled }) {
  return !!enabled && nextState === 'background' && !isLockSuspended();
}

// How this phone can unlock: 'biometric' (sensor with a fingerprint
// registered), 'enroll-device' (sensor without any fingerprint: the user
// registers one in the phone settings) or 'password' (no sensor).
export function unlockMode({ hasHardware, isEnrolled }) {
  if (hasHardware && isEnrolled) return 'biometric';
  if (hasHardware) return 'enroll-device';
  return 'password';
}

// The user that registered the fingerprint, compared without case.
export function sameUser(stored, username) {
  return !!stored && !!username && String(stored).toLowerCase() === String(username).toLowerCase();
}

// Message for a failed fingerprint prompt (expo-local-authentication's
// error codes); null when the user just cancelled.
export function biometricError(result) {
  if (!result || result.success) return null;
  switch (result.error) {
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
      return null;
    case 'lockout':
      return 'Muitas tentativas com a digital. Aguarde ou use a senha.';
    case 'not_enrolled':
      return 'Nenhuma digital cadastrada neste celular.';
    case 'not_available':
      return 'O leitor de digital não está disponível.';
    default:
      return 'Digital não reconhecida. Tente de novo ou use a senha.';
  }
}
