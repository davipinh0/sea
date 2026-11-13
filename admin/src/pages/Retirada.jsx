import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import StatusTag from '../components/StatusTag.jsx';
import Modal from '../components/Modal.jsx';
import { OtDetailModal, OtTypeTag } from '../components/sea.jsx';
import { formatDateTime, readError } from '../utils/sea.js';

// Retirada: the stock keeper's queue. Requests made at the touchscreen
// terminal arrive here (polled), are separated and marked ready; the
// employee who requested then confirms the handover at the terminal.
// Every request stays on record: the Histórico tab lists the delivered
// and the cancelled ones, with who cancelled and why.

const OPEN = ['REQUESTED', 'PICKING', 'READY'];
const CLOSED = ['DELIVERED', 'CANCELLED'];
const POLL_MS = 10000;

const NEXT = {
  REQUESTED: { action: 'separar', label: 'Iniciar separação' },
  PICKING: { action: 'pronta', label: 'Separação concluída' },
};

export default function Retirada() {
  // The queue shows every location the user works in: a request must not
  // be missed because another location is selected in the top bar.
  const [view, setView] = useState('open');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState(null);

  // Bumping ``tick`` re-runs the fetch (after actions and every POLL_MS).
  const [tick, setTick] = useState(0);
  const load = () => setTick((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    const statuses = (view === 'open' ? OPEN : CLOSED).join(',');
    api.get(`/sea/retiradas?status=${statuses}`).then(async (res) => {
      if (cancelled || !res) return;
      if (!res.ok) {
        const msg = await readError(res, 'Não foi possível carregar as retiradas.');
        if (!cancelled) setError(msg);
        return;
      }
      const json = await res.json();
      if (!cancelled) { setError(''); setRows(json.withdrawals || []); }
    });
    return () => { cancelled = true; };
  }, [view, tick]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  async function step(w, action) {
    setBusy(w.withdrawal_id);
    const res = await api.post(`/sea/retiradas/${w.withdrawal_id}/${action}`, {});
    setBusy(null);
    if (!res) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível atualizar a retirada.')); load(); return; }
    setError('');
    setMessage((await res.json()).message);
    load();
  }

  async function confirmCancel() {
    const clean = reason.trim();
    if (!clean) return;
    const res = await api.post(`/sea/retiradas/${cancelling.withdrawal_id}/cancelar`, { reason: clean });
    if (res && !res.ok) setError(await readError(res, 'Não foi possível cancelar.'));
    else setMessage(`Retirada nº ${cancelling.withdrawal_id} cancelada; reserva liberada.`);
    setCancelling(null);
    setReason('');
    load();
  }

  return (
    <div>
      <PageHeader title="Retirada">
        <Link to="/retirada/terminal" className="btn btn-primary" target="_blank" rel="noopener">Abrir terminal de retirada</Link>
      </PageHeader>

      <div className="data-tabs" role="tablist">
        <button type="button" role="tab" className={`data-tab${view === 'open' ? ' active' : ''}`} onClick={() => setView('open')}>Em andamento</button>
        <button type="button" role="tab" className={`data-tab${view === 'closed' ? ' active' : ''}`} onClick={() => setView('closed')}>Histórico (entregues e canceladas)</button>
      </div>

      {message && <div className="tag tag-success" style={{ display: 'block', padding: 12, marginBottom: 12 }}>{message}</div>}
      {error && <div className="form-error">{error}</div>}
      {rows.length === 0 && (
        <p className="settings-note">
          {view === 'open' ? 'Nenhuma solicitação em andamento. As solicitações feitas no terminal aparecem aqui automaticamente.' : 'Nenhuma retirada entregue ou cancelada.'}
        </p>
      )}

      {rows.map((w) => (
        <div key={w.withdrawal_id} className="card" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            Retirada nº {w.withdrawal_id}
            <span>· Ordem <a href="#" className="mono" onClick={(e) => { e.preventDefault(); setDetail(w.ot); }}>{w.ot}</a></span>
            <OtTypeTag type={w.order_type} />
            <StatusTag status={w.status} />
            <span className="settings-note" style={{ marginLeft: 'auto' }}>
              Solicitada em {formatDateTime(w.requested_at)} por {w.requested_by_name || w.requested_by}{w.requested_by_email ? ` (${w.requested_by_email})` : ''}
            </span>
          </div>
          <table className="lines-table">
            <thead><tr><th>Local · Endereço</th><th>Código</th><th>Descrição</th><th>Quantidade</th></tr></thead>
            <tbody>
              {w.lines.map((l) => (
                <tr key={l.inventory_id}>
                  <td className="mono"><strong>{w.warehouse_code ? `${w.warehouse_code} · ` : ''}{l.bin_code}</strong></td><td className="mono">{l.sku}</td>
                  <td>{l.item_name}</td><td>{l.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {w.requester_note && <p className="settings-note">Observação: {w.requester_note}</p>}
          <div className="settings-note" style={{ marginTop: 8 }}>
            {w.picked_by && <>Separação: {w.picked_by} em {formatDateTime(w.picking_started_at)}. </>}
            {w.ready_at && <>Pronta em {formatDateTime(w.ready_at)}. </>}
            {w.delivered_at && <>Entregue a <strong>{w.delivered_to}</strong> em {formatDateTime(w.delivered_at)}. </>}
            {w.cancelled_at && <>Cancelada por {w.cancelled_by} em {formatDateTime(w.cancelled_at)}. Motivo: {w.cancel_reason || 'não informado'}.</>}
          </div>
          {OPEN.includes(w.status) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {NEXT[w.status] && (
                <button type="button" className="btn btn-primary" disabled={busy === w.withdrawal_id} onClick={() => step(w, NEXT[w.status].action)}>
                  {NEXT[w.status].label}
                </button>
              )}
              {w.status === 'READY' && <span className="tag tag-info" style={{ alignSelf: 'center' }}>Aguardando o solicitante confirmar o recebimento no terminal</span>}
              <button type="button" className="btn" onClick={() => setCancelling(w)}>Cancelar</button>
            </div>
          )}
        </div>
      ))}

      {cancelling && (
        <Modal
          title={`Cancelar retirada nº ${cancelling.withdrawal_id}`}
          onClose={() => { setCancelling(null); setReason(''); }}
          footer={<>
            <button type="button" className="btn" onClick={() => { setCancelling(null); setReason(''); }}>Voltar</button>
            <button type="button" className="btn btn-danger" disabled={!reason.trim()} onClick={confirmCancel}>Cancelar retirada</button>
          </>}
        >
          <p>A reserva dos materiais será liberada. Nenhuma baixa é feita. A solicitação continua registrada no histórico.</p>
          <label className="form-group" style={{ display: 'block' }}>
            <span>Motivo (obrigatório, fica registrado)</span>
            <input className="form-input" autoFocus required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {!reason.trim() && <div className="settings-note">Informe o motivo para cancelar.</div>}
        </Modal>
      )}
      {detail && <OtDetailModal code={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
