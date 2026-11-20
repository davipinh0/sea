// Trava do app: depois do primeiro login com senha no celular, o usuário cadastra a digital e o app
// trava sempre que vai para segundo plano. A tela de bloqueio cobre as telas sem desmontá-las,
// então o que estava em andamento continua lá.
// As regras ficam aqui, fora do React, para poderem ser testadas.

// Usuário que cadastrou a digital neste celular. Não é chave de login: sair mantém.
export const BIOMETRIC_USER_KEY = 'sea_biometric_user';

// Diálogos do Android abertos pelo próprio app (permissões, PIN da digital) jogam o app para
// segundo plano por um instante; isso não pode travar o app.
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

// A liberação espera um pouco: o evento "active" pode chegar logo depois da promise do diálogo.
export async function withoutLock(fn, releaseDelayMs = 700) {
  const release = suspendLock();
  try {
    return await fn();
  } finally {
    setTimeout(release, releaseDelayMs);
  }
}

export function shouldLock(nextState, { enabled }) {
  return !!enabled && nextState === 'background' && !isLockSuspended();
}

export const SECURITY_SECRET = 1;

// Como este celular destrava o app: 'biometric' (digital; o PIN também funciona no mesmo aviso),
// 'device' (sem digital: PIN, padrão ou senha) ou 'none' (sem bloqueio de tela; o usuário precisa
// ativar um).
export function unlockMode({ isEnrolled, securityLevel }) {
  if (isEnrolled) return 'biometric';
  if ((securityLevel ?? 0) >= SECURITY_SECRET) return 'device';
  return 'none';
}

export function sameUser(stored, username) {
  return !!stored && !!username && String(stored).toLowerCase() === String(username).toLowerCase();
}

// null quando o usuário só cancelou.
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

export function identityError(result) {
  if (result?.success) return null;
  switch (result?.error) {
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
      return 'Confirmação cancelada. Confirme com a digital ou o PIN do celular para continuar.';
    case 'passcode_not_set':
    case 'not_enrolled':
      return 'Ative a senha de tela (PIN ou padrão) do celular para usar este processo.';
    default:
      return biometricError(result) || 'Não foi possível confirmar. Tente de novo.';
  }
}
