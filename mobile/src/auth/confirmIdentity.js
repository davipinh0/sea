import * as LocalAuthentication from 'expo-local-authentication';
import { identityError, withoutLock } from './appLock';
import { markIdentityConfirmed } from './identityProof';

// Receber uma OT, escolher onde guardar e as etapas da retirada pedem a digital ou o PIN do
// celular. Retorna null quando confirmou; senão, a mensagem para mostrar.
export async function confirmIdentity(reason) {
  const result = await withoutLock(() => LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: 'Cancelar',
    disableDeviceFallback: false,
  }));
  const problem = identityError(result);
  if (!problem) markIdentityConfirmed();
  return problem;
}
