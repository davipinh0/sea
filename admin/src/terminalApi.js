// API access for the withdrawal terminal.
//
// The terminal has its own session, separate from the panel: the token
// returned by the login is kept in memory by the terminal screen and
// sent as a Bearer header. ``credentials: 'omit'`` makes the browser
// neither send nor store cookies, so signing in or out at the terminal
// never touches a panel session open in the same browser.

const API_BASE = '/api';

async function send(path, { method = 'GET', token, body } = {}) {
  return fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

// Identify the employee. Returns { token, user } where user carries
// allowed_pages and must_change_password; throws an Error whose message
// can be shown to the employee.
export async function terminalLogin(identifier, password) {
  const res = await send('/auth/login', { method: 'POST', body: { username: identifier, password } });
  if (res.status === 429) throw new Error('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
  if (!res.ok) throw new Error('E-mail, usuário ou senha inválidos.');
  const { token } = await res.json();
  const me = await send('/auth/me', { token });
  if (!me.ok) throw new Error('Não foi possível iniciar a sessão. Tente novamente.');
  return { token, user: await me.json() };
}

export function terminalApi(token) {
  return {
    get: (path) => send(path, { token }),
    post: (path, body) => send(path, { method: 'POST', token, body }),
  };
}
