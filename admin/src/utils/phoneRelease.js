import { api } from '../api.js';
import { readError } from './sea.js';

// Pede ao celular cadastrado a liberação de ``purpose`` e espera a resposta. Resolve quando o
// usuário confirma; rejeita com uma mensagem para mostrar (negado, tempo esgotado, sem celular).
export async function releaseOnPhone(purpose, { onWaiting, isCancelled = () => false, pollMs = 2000 } = {}) {
  const res = await api.post(`/sea/confirmacao/${purpose}`, {});
  if (res?.status !== 202) throw new Error(await readError(res, 'Não foi possível enviar para o celular.'));
  const { challenge_id: id, expires_in: expiresIn } = await res.json();
  onWaiting?.(expiresIn);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (isCancelled()) throw new Error('Pedido cancelado.');
    const follow = await api.get(`/sea/confirmacao/${purpose}/${id}`, { silentPermissionDenied: true });
    if (isCancelled()) throw new Error('Pedido cancelado.');
    if (follow?.status === 202) { onWaiting?.((await follow.json()).expires_in); continue; }
    if (follow?.ok) return;
    throw new Error(await readError(follow, 'A liberação não foi confirmada.'));
  }
}
