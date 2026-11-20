// API do terminal. A sessão é própria, separada da do painel: o token fica na memória da tela e
// ``credentials: 'omit'`` impede o navegador de mexer nos cookies do painel aberto no mesmo
// navegador.

import { waitForApproval } from './utils/loginApproval.js';

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

// Identifica o funcionário. Se ele confirma logins no celular, ``onWaiting`` é chamado enquanto o
// terminal espera.
export async function terminalLogin(identifier, password, { onWaiting, isCancelled } = {}) {
  const res = await send('/auth/login', { method: 'POST', body: { username: identifier, password } });
  if (res.status === 429) throw new Error('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
  if (!res.ok) throw new Error('E-mail, usuário ou senha inválidos.');
  let data = await res.json();
  if (res.status === 202) {
    onWaiting?.(data.expires_in);
    data = await waitForApproval((path, body) => send(path, { method: 'POST', body }), data,
      { onTick: onWaiting, isCancelled });
  }
  const { token } = data;
  const me = await send('/auth/me', { token });
  if (!me.ok) throw new Error('Não foi possível iniciar a sessão. Tente novamente.');
  return { token, user: await me.json() };
}

export function terminalLogout(token) {
  return send('/auth/logout', { method: 'POST', token }).catch(() => null);
}

export function terminalApi(token) {
  return {
    get: (path) => send(path, { token }),
    post: (path, body) => send(path, { method: 'POST', token, body }),
  };
}
