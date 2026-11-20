import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import StatusTag from './StatusTag.jsx';
import { MOVEMENT_LABELS, OT_HEADER_FIELDS, formatDate, formatDateTime, readError } from '../utils/sea.js';

// Peças comuns das telas do SEA: etiqueta do tipo da OT e o detalhe da OT.

export function OtTypeTag({ type }) {
  if (!type) return null;
  return <span className={`tag sea-badge-${type.toLowerCase()}`}>{type}</span>;
}

export function OtDetailModal({ code, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get(`/sea/ots/${encodeURIComponent(code)}`).then(async (res) => {
      if (cancelled || !res) return;
      if (!res.ok) {
        setError(await readError(res, 'Não foi possível carregar a ordem.'));
        return;
      }
      setData(await res.json());
    });
    return () => { cancelled = true; };
  }, [code]);

  return (
    <Modal title={`OT ${code}`} onClose={onClose} size="lg">
      {error && <div className="form-error">{error}</div>}
      {!data && !error && <p>Carregando…</p>}
      {data && (
        <>
          <div className="detail-grid" style={{ marginBottom: 16 }}>
            <div><span className="detail-label">Tipo</span> <OtTypeTag type={data.ot.order_type} /></div>
            <div><span className="detail-label">Status</span> <StatusTag status={data.ot.status} /></div>
            {OT_HEADER_FIELDS.filter((f) => f.key !== 'service_order_type').map((f) => (
              <div key={f.key}>
                <span className="detail-label">{f.label}</span>{' '}
                {data.ot[f.key] ? (f.type === 'date' ? formatDate(data.ot[f.key]) : data.ot[f.key]) : '-'}
              </div>
            ))}
            <div><span className="detail-label">Criada em</span> {formatDateTime(data.ot.created_at)}</div>
            <div><span className="detail-label">Recebida em</span> {formatDateTime(data.ot.received_at)}</div>
          </div>

          <div className="section-title">Materiais da ordem</div>
          <table className="lines-table">
            <thead><tr><th>Ordem</th><th>Código</th><th>Descrição</th><th>Lote</th><th>Un.</th><th>Prevista</th><th>Recebida</th><th>Em estoque</th><th>Retirada</th><th>Status</th></tr></thead>
            <tbody>
              {(data.materials || data.lines).map((l) => (
                <tr key={l.po_line_id ?? l.line_number}>
                  <td className="mono">{[l.service_order_type, l.service_order_number].filter(Boolean).join(' ') || '-'}</td>
                  <td className="mono">{l.sku}</td><td>{l.item_name}</td>
                  <td className="mono">{l.lot_number || '-'}</td><td>{l.uom || '-'}</td>
                  <td>{l.quantity_ordered}</td><td>{l.quantity_received}</td>
                  <td>{l.quantity_in_stock ?? '-'}</td><td>{l.quantity_withdrawn ?? '-'}</td>
                  <td><StatusTag status={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.movements?.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 16 }}>Movimentações</div>
              <table className="lines-table">
                <thead><tr><th>Tipo</th><th>Código</th><th>Qtd.</th><th>Origem</th><th>Destino</th><th>Responsável</th><th>Data/hora</th></tr></thead>
                <tbody>
                  {data.movements.map((m, i) => (
                    <tr key={`${m.kind}-${m.sku}-${m.moved_at}-${i}`}>
                      <td>{MOVEMENT_LABELS[m.kind] || m.kind}</td><td className="mono">{m.sku}</td><td>{m.quantity}</td>
                      <td className="mono">{m.origin || '-'}</td><td>{m.destination || '-'}</td>
                      <td>{m.responsible || '-'}</td><td>{formatDateTime(m.moved_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="section-title" style={{ marginTop: 16 }}>Recebimentos</div>
          {data.receipts.length === 0 ? <p className="settings-note">Nenhum recebimento ainda.</p> : (
            <table className="lines-table">
              <thead><tr><th>Código</th><th>Qtd.</th><th>Endereço</th><th>Responsável</th><th>Data/hora</th></tr></thead>
              <tbody>
                {data.receipts.map((r) => (
                  <tr key={r.receipt_id}>
                    <td className="mono">{r.sku}</td><td>{r.quantity}</td><td className="mono">{r.bin_code}</td>
                    <td>{r.received_by}</td><td>{formatDateTime(r.received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="section-title" style={{ marginTop: 16 }}>Localização no estoque</div>
          {data.stock.length === 0 ? <p className="settings-note">Sem saldo em estoque.</p> : (
            <table className="lines-table">
              <thead><tr><th>Endereço</th><th>Código</th><th>Em estoque</th><th>Reservado</th><th>Disponível</th></tr></thead>
              <tbody>
                {data.stock.map((s) => (
                  <tr key={s.inventory_id}>
                    <td className="mono">{s.bin_code}{!s.stored && ' (recebimento)'}</td>
                    <td className="mono">{s.sku}</td><td>{s.quantity_on_hand}</td>
                    <td>{s.quantity_allocated}</td><td>{s.available}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="section-title" style={{ marginTop: 16 }}>Retiradas</div>
          {data.withdrawals.length === 0 ? <p className="settings-note">Nenhuma retirada.</p> : (
            <table className="lines-table">
              <thead><tr><th>Nº</th><th>Status</th><th>Materiais</th><th>Entregue a</th><th>Data/hora</th></tr></thead>
              <tbody>
                {data.withdrawals.map((w) => (
                  <tr key={w.withdrawal_id}>
                    <td>{w.withdrawal_id}</td><td><StatusTag status={w.status} /></td>
                    <td>{w.lines.map((l) => `${l.sku} x${l.quantity}`).join(', ')}</td>
                    <td>{w.delivered_to || '-'}</td>
                    <td>{formatDateTime(w.delivered_at || w.cancelled_at || w.requested_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}
