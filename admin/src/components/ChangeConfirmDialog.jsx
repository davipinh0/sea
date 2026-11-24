import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { releaseOnPhone } from '../utils/phoneRelease.js';
import {
  CHANGE_PURPOSE, CHANGE_REASON_MAX, reasonProblem, setChangeConfirmHandler,
} from '../utils/changeConfirm.js';

// Antes de salvar uma alteração (ou excluir), quem está no painel escreve o motivo e confirma no
// app SEA do celular. O motivo vai para o histórico junto com a alteração. Fica montada uma vez,
// no App; api.js a chama quando a API pede (changeConfirm.js).

export default function ChangeConfirmDialog() {
  const [request, setRequest] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(null);
  const resolver = useRef(null);
  const cancelled = useRef(false);

  useEffect(() => setChangeConfirmHandler((req) => new Promise((resolve) => {
    // Um pedido novo enquanto outro está aberto: o anterior desiste.
    resolver.current?.(null);
    resolver.current = resolve;
    cancelled.current = false;
    setReason('');
    setError('');
    setWaiting(null);
    setRequest(req);
  })), []);

  function finish(value) {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    setWaiting(null);
    resolve?.(value);
  }

  function cancel() {
    cancelled.current = true;
    finish(null);
  }

  async function confirm(e) {
    e.preventDefault();
    const problem = reasonProblem(reason);
    if (problem) { setError(problem); return; }
    setError('');
    setWaiting(0);
    try {
      await releaseOnPhone(CHANGE_PURPOSE, { onWaiting: setWaiting, isCancelled: () => cancelled.current });
    } catch (err) {
      if (!cancelled.current) { setError(err.message); setWaiting(null); }
      return;
    }
    if (!cancelled.current) finish(reason.trim().replace(/\s+/g, ' '));
  }

  if (!request) return null;
  const removing = request.method === 'DELETE';
  const busy = waiting !== null;
  return (
    <Modal
      title={removing ? 'Motivo da exclusão' : 'Motivo da alteração'}
      onClose={cancel}
      footer={<>
        <button type="button" className="btn" onClick={cancel}>Cancelar</button>
        <button type="submit" form="change-confirm-form" className="btn btn-primary" disabled={busy}>
          {busy ? 'Aguardando o celular…' : 'Confirmar no celular'}
        </button>
      </>}
    >
      <form id="change-confirm-form" onSubmit={confirm}>
        <p style={{ fontSize: 14, marginBottom: 8 }}>
          {removing ? 'Antes de excluir' : 'Antes de salvar'}, explique o motivo e confirme no app SEA do seu
          celular. O motivo fica registrado no histórico.
        </p>
        <div className="form-group">
          <label htmlFor="change-reason">Motivo</label>
          <textarea
            id="change-reason"
            className="form-input"
            rows={3}
            maxLength={CHANGE_REASON_MAX}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex.: quantidade corrigida conforme a nota fiscal"
            autoFocus
          />
        </div>
        {busy && (
          <p role="status" style={{ fontSize: 13, marginTop: 8 }}>
            Confirme no app SEA do seu celular.{waiting > 0 ? ` Tempo restante: ${waiting} s.` : ''}
          </p>
        )}
        {error && <div className="form-error" role="alert" style={{ marginTop: 8 }}>{error}</div>}
      </form>
    </Modal>
  );
}
