import * as LocalAuthentication from 'expo-local-authentication';
import { identityError, withoutLock } from './appLock';

// SEA: before receiving an OT, choosing where to store a material or
// processing a withdrawal, the operator confirms with the fingerprint or
// the phone's PIN/pattern. Returns null when confirmed, otherwise the
// message to show.
export async function confirmIdentity(reason) {
  const result = await withoutLock(() => LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: 'Cancelar',
    disableDeviceFallback: false,
  }));
  return identityError(result);
}
