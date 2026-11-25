// Login salvo: depois que o usuário ativa o bloqueio por digital/PIN neste celular, a senha dele
// fica no cofre do Android (expo-secure-store, criptografado pelo keystore). A tela de login pede
// a digital ou o PIN e entra com ela, sem digitar.
// Sair da conta mantém o login salvo; ele é apagado quando o servidor recusa a senha (ela mudou)
// ou quando outro usuário entra neste celular.
// As funções recebem o cofre como parâmetro para poderem ser testadas sem o React Native.

import { sameUser } from './appLock';

export const SAVED_LOGIN_KEY = 'sea_saved_login';

export async function saveLogin(secureStore, username, password) {
  if (!username || !password) return;
  await secureStore.setItemAsync(SAVED_LOGIN_KEY, JSON.stringify({ username, password }));
}

export async function clearSavedLogin(secureStore) {
  try {
    await secureStore.deleteItemAsync(SAVED_LOGIN_KEY);
  } catch {
    // Nada salvo: apagar é idempotente.
  }
}

// Só vale para o usuário que ativou o bloqueio neste celular; qualquer outra coisa é ignorada.
export async function loadSavedLogin(secureStore, biometricUser) {
  let raw;
  try {
    raw = await secureStore.getItemAsync(SAVED_LOGIN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!saved || typeof saved.username !== 'string' || typeof saved.password !== 'string' || !saved.password) {
    return null;
  }
  return sameUser(biometricUser, saved.username) ? saved : null;
}

// Outro usuário entrou neste celular: o login salvo do anterior não serve mais.
export async function forgetOtherUser(secureStore, username) {
  let raw = null;
  try {
    raw = await secureStore.getItemAsync(SAVED_LOGIN_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let savedUser = null;
  try {
    savedUser = JSON.parse(raw)?.username;
  } catch {
    // Conteúdo inválido: apaga.
  }
  if (!sameUser(savedUser, username)) await clearSavedLogin(secureStore);
}
