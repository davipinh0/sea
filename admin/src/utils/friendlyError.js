/**
 * V-021: map backend error responses to user-friendly strings.
 *
 * The admin SPA used to render `data.error` verbatim, which surfaced
 * backend internals (SQL constraint names, Python exception reprs) to
 * end users. This helper converts a response payload to a finite,
 * human-readable message. Anything not explicitly mapped falls back to
 * a generic message and never echoes the raw backend string.
 */

// Backend-defined `error` values that are safe to surface as-is because
// they are end-user oriented (not internal diagnostics). Keys map to
// the user-facing string the UI should show.
const KNOWN_ERROR_MESSAGES = {
  validation_error: 'Um ou mais campos têm valores inválidos.',
  unsupported_media_type: 'Esse formato de requisição não é suportado.',
  'Usuário ou senha inválidos': 'Usuário ou senha incorretos.',
  'Conta desativada ou excluída': 'Sua conta não está mais ativa. Contate um administrador.',
  'Sessão expirada': 'Sua sessão expirou. Entre novamente.',
  Unauthorized: 'Você precisa entrar para continuar.',
  Forbidden: 'Você não tem permissão para essa ação.',
  'Token CSRF ausente ou inválido': 'Sua sessão está dessincronizada. Atualize a página e tente novamente.',
  'Acesso negado a este armazém': 'Você não tem acesso a esse local.',
  'A senha atual está incorreta': 'A senha atual está incorreta.',
  'Usuário não encontrado': 'Conta não encontrada.',
  "Password cannot be 'admin'": "A senha não pode ser 'admin'.",
  'Password must be at least 8 characters': 'A senha deve ter pelo menos 8 caracteres.',
  'Password must contain at least one letter': 'A senha deve conter pelo menos uma letra.',
  'Password must contain at least one digit': 'A senha deve conter pelo menos um dígito.',
  password_change_required: 'Você precisa alterar sua senha antes de continuar.',
};

export function friendlyError(payload, fallback = 'Algo deu errado. Tente novamente.') {
  if (!payload || typeof payload !== 'object') return fallback;
  const code = payload.error;
  if (code && Object.prototype.hasOwnProperty.call(KNOWN_ERROR_MESSAGES, code)) {
    return KNOWN_ERROR_MESSAGES[code];
  }
  return fallback;
}

/**
 * Resolve a friendly error from a fetch Response. Reads the JSON body
 * (if any) and maps via friendlyError. Use this when you have a non-ok
 * Response and want the right user-facing string.
 */
export async function friendlyErrorFromResponse(res, fallback) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return friendlyError(body, fallback);
}
