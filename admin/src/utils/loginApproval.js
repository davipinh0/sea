// SEA (mig 092): a password login that waits for the user to confirm it in
// the SEA app of the registered phone. The login answers 202 with a
// challenge; whoever started it asks /auth/login/aprovacao until the
// phone decides (or the time runs out).

const MESSAGES = {
  403: 'O acesso foi negado no celular.',
  404: 'Tentativa de login não encontrada. Entre de novo.',
  410: 'O tempo para confirmar acabou. Entre de novo.',
};

export class LoginApprovalCancelled extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ``post(path, body)`` returns a fetch Response. Resolves with the body of
// the approved login ({ token, user }); rejects with an Error whose
// message can be shown, or LoginApprovalCancelled.
export async function waitForApproval(post, challenge, { intervalMs = 2000, onTick, isCancelled = () => false } = {}) {
  const body = { challenge_id: challenge.challenge_id, poll_token: challenge.poll_token };
  for (;;) {
    if (isCancelled()) throw new LoginApprovalCancelled();
    const res = await post('/auth/login/aprovacao', body);
    if (isCancelled()) throw new LoginApprovalCancelled();
    if (!res) throw new Error('Sem resposta do servidor. Tente de novo.');
    if (res.status === 200) return res.json();
    if (res.status === 202) {
      const data = await res.json().catch(() => ({}));
      onTick?.(data.expires_in);
      await sleep(intervalMs);
      continue;
    }
    throw new Error(MESSAGES[res.status] || 'Não foi possível confirmar o login. Tente de novo.');
  }
}
