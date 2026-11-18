import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { readError } from '../utils/sea.js';

// SEA (mig 095): Recebimento, Armazenagem and Retirada in the web panel
// open only after the user confirms on the SEA app of the registered
// phone (fingerprint or PIN). The release lasts while the process is used;
// when it ends the API answers 403 step_up_required and the gate closes.

const POLL_MS = 2000;

export default function ProcessGate({ purpose, label, children }) {
  const [phase, setPhase] = useState('checking'); // checking | open | locked | waiting
  const [message, setMessage] = useState('');
  const [left, setLeft] = useState(null);
  const alive = useRef(true);
  const challenge = useRef(null);

  useEffect(() => {
    alive.current = true;
    api.get(`/sea/confirmacao/${purpose}`, { silentPermissionDenied: true }).then(async (res) => {
      if (!alive.current) return;
      if (!res?.ok) { setPhase('locked'); setMessage(await readError(res, 'Não foi possível verificar a liberação.')); return; }
      const data = await res.json();
      if (!data.required || data.granted) { setPhase('open'); return; }
      setPhase('locked');
      setMessage(data.has_phone ? '' : `Para usar ${label} no painel, cadastre o app SEA no seu celular (entre no app e ative o bloqueio com digital ou PIN).`);
    });
    // The release ended while the screen was open (15 min without use).
    const onExpired = (event) => {
      if (event.detail?.purpose !== purpose) return;
      setPhase('locked');
      setMessage(`A liberação de ${label} terminou. Confirme de novo no celular.`);
    };
    window.addEventListener('sea:step-up', onExpired);
    return () => { alive.current = false; window.removeEventListener('sea:step-up', onExpired); };
  }, [purpose, label]);

  async function ask() {
    setMessage('');
    const res = await api.post(`/sea/confirmacao/${purpose}`, {});
    if (!alive.current) return;
    if (res?.status !== 202) { setMessage(await readError(res, 'Não foi possível enviar para o celular.')); return; }
    const data = await res.json();
    challenge.current = data.challenge_id;
    setLeft(data.expires_in);
    setPhase('waiting');
    follow(data.challenge_id);
  }

  async function follow(id) {
    while (alive.current && challenge.current === id) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (!alive.current || challenge.current !== id) return;
      const res = await api.get(`/sea/confirmacao/${purpose}/${id}`, { silentPermissionDenied: true });
      if (!alive.current || challenge.current !== id) return;
      if (res?.status === 202) { setLeft((await res.json()).expires_in); continue; }
      challenge.current = null;
      if (res?.ok) { setPhase('open'); setMessage(''); return; }
      setPhase('locked');
      setMessage(await readError(res, 'A liberação não foi confirmada.'));
      return;
    }
  }

  function cancel() {
    challenge.current = null;
    setPhase('locked');
    setMessage('Pedido cancelado.');
  }

  if (phase === 'open') return children;
  return (
    <div className="process-gate" role="status" aria-live="polite">
      <div className="process-gate-card">
        <div className="process-gate-icon" aria-hidden="true">📱</div>
        <h2>{label}: confirme no seu celular</h2>
        {phase === 'checking' && <p>Verificando a liberação…</p>}
        {phase === 'locked' && (
          <>
            <p>Por segurança, {label} no painel web só abre depois de você confirmar no app SEA do seu celular, com a digital ou a senha do celular (PIN ou padrão).</p>
            {message && <div className="form-error">{message}</div>}
            <button type="button" className="btn btn-primary" onClick={ask}>Enviar para o celular</button>
          </>
        )}
        {phase === 'waiting' && (
          <>
            <p>Abra o app SEA no seu celular e toque em <strong>SIM, SOU EU</strong>.</p>
            <p className="login-approval-time">Tempo restante: {Math.floor((left || 0) / 60)}:{String((left || 0) % 60).padStart(2, '0')}</p>
            <button type="button" className="btn" onClick={cancel}>Cancelar</button>
          </>
        )}
      </div>
    </div>
  );
}
