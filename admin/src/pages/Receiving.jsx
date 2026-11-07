import { useState, useEffect, Fragment } from 'react';
import { api } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import StatusTag from '../components/StatusTag.jsx';
import Modal from '../components/Modal.jsx';

// /api/receiving/receive only accepts OPEN or PARTIAL POs. Mirror
// that constraint in the UI so the operator never sees a 400 from
// the server for a finished PO.
const RECEIVABLE_PO_STATUSES = new Set(['OPEN', 'PARTIAL']);

export default function Receiving() {
  const [pos, setPos] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active');
  // Bins scoped to the selected PO's warehouse; populated when a PO
  // is opened. Receive form's bin dropdown reads from here.
  const [warehouseBins, setWarehouseBins] = useState([]);
  const [defaultBinId, setDefaultBinId] = useState(null);
  // Per-line draft state: { [po_line_id]: { qty, bin_id, error, saving } }
  const [lineDrafts, setLineDrafts] = useState({});
  // Receipt history (the item_receipts rows for the PO) and the
  // per-line expand state. Each line shows a "Receipts (N)" toggle;
  // clicking it surfaces the rows + per-row Unreceive buttons. Loaded
  // alongside the PO detail so the toggle is a pure UI operation.
  const [receipts, setReceipts] = useState([]);
  const [expandedLines, setExpandedLines] = useState(new Set());
  // Unreceive confirm state. unreceiving holds the receipt row being
  // reversed; unreceiveReason is the free-text the operator types
  // (sent to the backend, capped server-side at 500 chars).
  const [unreceiving, setUnreceiving] = useState(null);
  const [unreceiveReason, setUnreceiveReason] = useState('');
  const [unreceiveError, setUnreceiveError] = useState('');
  const [unreceiveSubmitting, setUnreceiveSubmitting] = useState(false);

  useEffect(() => {
    loadPOs();
  }, [statusFilter]);

  async function loadPOs() {
    if (statusFilter === 'active') {
      const [openRes, partialRes] = await Promise.all([
        api.get('/admin/purchase-orders?status=OPEN&per_page=50'),
        api.get('/admin/purchase-orders?status=PARTIAL&per_page=50'),
      ]);
      const all = [];
      for (const res of [openRes, partialRes]) {
        if (res?.ok) {
          const data = await res.json();
          all.push(...(data.purchase_orders || []));
        }
      }
      setPos(all);
    } else {
      const params = new URLSearchParams({ per_page: 50 });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await api.get(`/admin/purchase-orders?${params}`);
      if (res?.ok) {
        const data = await res.json();
        setPos(data.purchase_orders || []);
      }
    }
  }

  async function viewPO(po) {
    setSelected(po);
    const id = po.po_id || po.id;
    const res = await api.get(`/admin/purchase-orders/${id}`);
    if (!res?.ok) return;
    const data = await res.json();
    setDetail(data);

    const warehouseId = data.purchase_order?.warehouse_id;
    if (warehouseId) {
      const binsRes = await api.get(
        `/admin/bins?warehouse_id=${warehouseId}&per_page=500`,
      );
      if (binsRes?.ok) {
        const bdata = await binsRes.json();
        const bins = bdata.bins || [];
        setWarehouseBins(bins);
        // Default to the first Staging bin in the warehouse so the
        // common receive-to-staging-then-putaway flow is one click.
        // Fall back to the first bin overall if no Staging bins
        // exist (small / unusual warehouse layouts).
        const staging = bins.find((b) => b.bin_type === 'Staging');
        const fallback = bins[0];
        setDefaultBinId((staging || fallback)?.bin_id || null);
      } else {
        setWarehouseBins([]);
        setDefaultBinId(null);
      }
    }
    setLineDrafts({});
    await loadReceipts(id);
  }

  function closeDetail() {
    setSelected(null);
    setDetail(null);
    setWarehouseBins([]);
    setDefaultBinId(null);
    setLineDrafts({});
    setReceipts([]);
    setExpandedLines(new Set());
  }

  async function refreshDetail() {
    if (!detail?.purchase_order) return;
    const po_id = detail.purchase_order.po_id;
    const res = await api.get(`/admin/purchase-orders/${po_id}`);
    if (res?.ok) {
      setDetail(await res.json());
    }
    await loadReceipts(po_id);
  }

  async function loadReceipts(po_id) {
    const res = await api.get(`/admin/purchase-orders/${po_id}/receipts`);
    if (res?.ok) {
      const data = await res.json();
      setReceipts(data.receipts || []);
    } else {
      setReceipts([]);
    }
  }

  function toggleLineReceipts(lineId) {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId); else next.add(lineId);
      return next;
    });
  }

  function openUnreceive(receipt) {
    setUnreceiveReason('');
    setUnreceiveError('');
    setUnreceiving(receipt);
  }

  function closeUnreceive() {
    setUnreceiving(null);
    setUnreceiveReason('');
    setUnreceiveError('');
    setUnreceiveSubmitting(false);
  }

  async function submitUnreceive() {
    if (!unreceiving) return;
    setUnreceiveError('');
    setUnreceiveSubmitting(true);
    try {
      const body = {};
      if (unreceiveReason.trim()) body.reason = unreceiveReason.trim();
      const res = await api.post(
        `/admin/receipts/${unreceiving.receipt_id}/unreceive`,
        body,
      );
      if (!res?.ok) {
        let data = null;
        try { data = await res?.json(); } catch (_) { /* non-JSON */ }
        setUnreceiveError(data?.error || 'Falha ao estornar o recebimento');
        return;
      }
      closeUnreceive();
      await refreshDetail();
      loadPOs();
    } finally {
      setUnreceiveSubmitting(false);
    }
  }

  function updateDraft(lineId, patch) {
    setLineDrafts((d) => ({
      ...d,
      [lineId]: { ...(d[lineId] || {}), ...patch },
    }));
  }

  async function receiveLine(line) {
    const draft = lineDrafts[line.po_line_id] || {};
    const qty = parseInt(draft.qty, 10);
    const binId = parseInt(draft.bin_id ?? defaultBinId, 10);
    if (isNaN(qty) || qty <= 0) {
      updateDraft(line.po_line_id, { error: 'Informe uma quantidade positiva' });
      return;
    }
    if (!binId) {
      updateDraft(line.po_line_id, { error: 'Escolha um endereço' });
      return;
    }
    updateDraft(line.po_line_id, { saving: true, error: '' });
    const res = await api.post('/receiving/receive', {
      po_id: detail.purchase_order.po_id,
      items: [{ item_id: line.item_id, quantity: qty, bin_id: binId }],
    });
    if (res?.ok) {
      // Clear this line's draft and pull the updated PO so the
      // received counter + status reflect the change.
      setLineDrafts((d) => {
        const next = { ...d };
        delete next[line.po_line_id];
        return next;
      });
      await refreshDetail();
      loadPOs();
    } else {
      const data = await res?.json();
      updateDraft(line.po_line_id, {
        saving: false,
        error: data?.error || 'Falha ao receber',
      });
    }
  }

  const columns = [
    { key: 'po_number', label: 'Número do PC', mono: true },
    { key: 'vendor_name', label: 'Fornecedor' },
    { key: 'expected_date', label: 'Data prevista', mono: true, render: (r) => r.expected_date || '-' },
    { key: 'status', label: 'Status', render: (r) => <StatusTag status={r.status} /> },
  ];

  const po = detail?.purchase_order;
  const canReceive = po && RECEIVABLE_PO_STATUSES.has(po.status);

  return (
    <div>
      <PageHeader title="Recebimento" />
      <div className="filter-bar">
        <select className="form-select" style={{ width: 140 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="active">Abertos / Parciais</option>
          <option value="all">Todos</option>
          <option value="OPEN">Abrir</option>
          <option value="PARTIAL">Parcial</option>
          <option value="RECEIVED">Recebido</option>
          <option value="CLOSED">Fechado</option>
        </select>
      </div>
      <DataTable rowKey="po_id" columns={columns} data={pos} onRowClick={viewPO} emptyMessage="Nenhum pedido de compra" />

      {selected && detail && (
        <Modal
          title={`PC ${po?.po_number || selected.po_number}`}
          onClose={closeDetail}
          footer={<button className="btn" onClick={closeDetail}>Fechar</button>}
          size="wide"
        >
          <section className="section">
            <div className="section-title">Resumo do PC</div>
            <div className="detail-grid detail-grid-2col" style={{ marginBottom: 0 }}>
              <span className="detail-label">Fornecedor</span><span>{po?.vendor_name || '-'}</span>
              <span className="detail-label">Status</span><span><StatusTag status={po?.status} /></span>
              <span className="detail-label">Data prevista</span><span className="mono">{po?.expected_date || '-'}</span>
              <span className="detail-label">Armazém</span><span className="mono">{po?.warehouse_id ?? '-'}</span>
            </div>
          </section>

          <section className="section" style={{ marginBottom: 0 }}>
            <div className="section-title">Linhas do pedido</div>
            {!canReceive && (
              <p style={{
                fontSize: 12, color: 'var(--text-secondary)',
                marginBottom: 8, fontStyle: 'italic',
              }}>
                O status do PC é {po?.status}; o recebimento fica desabilitado até o PC estar ABERTO ou PARCIAL.
              </p>
            )}
            {(detail.lines || []).length > 0 ? (
              <table className="lines-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>UPC</th>
                    <th>MPN</th>
                    <th>Material</th>
                    <th style={{ textAlign: 'right' }}>Pedido</th>
                    <th style={{ textAlign: 'right' }}>Recebido</th>
                    <th style={{ textAlign: 'right' }}>Restante</th>
                    {canReceive && (
                      <>
                        <th style={{ width: 90, textAlign: 'right' }}>Qtd.</th>
                        <th style={{ width: 220 }}>Endereço</th>
                        <th style={{ width: 110 }}></th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(detail.lines || []).map((l) => {
                    const remaining = (l.quantity_ordered || 0) - (l.quantity_received || 0);
                    const draft = lineDrafts[l.po_line_id] || {};
                    const lineReceivable = canReceive && remaining > 0;
                    const lineReceipts = receipts.filter((r) => r.po_line_id === l.po_line_id);
                    const isExpanded = expandedLines.has(l.po_line_id);
                    return (
                      <Fragment key={l.po_line_id}>
                        <tr>
                          <td className="mono">{l.sku}</td>
                          <td className="mono">{l.upc || '-'}</td>
                          <td className="mono">{l.mpn || '-'}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>
                            {l.item_name}
                            {lineReceipts.length > 0 && (
                              <button
                                type="button"
                                onClick={() => toggleLineReceipts(l.po_line_id)}
                                style={{
                                  marginLeft: 8,
                                  background: 'none',
                                  border: 'none',
                                  color: 'var(--accent)',
                                  cursor: 'pointer',
                                  fontSize: 12,
                                  textDecoration: 'underline',
                                  padding: 0,
                                }}
                                title={isExpanded
                                  ? 'Ocultar histórico de recebimentos'
                                  : 'Mostrar histórico de recebimentos (com estorno)'}
                              >
                                {isExpanded ? 'Ocultar' : 'Mostrar'} recebimentos ({lineReceipts.length})
                              </button>
                            )}
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>{l.quantity_ordered}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{l.quantity_received}</td>
                          <td className="mono" style={{
                            textAlign: 'right',
                            color: remaining > 0 ? 'var(--copper)' : 'var(--text-secondary)',
                            fontWeight: remaining > 0 ? 600 : 400,
                          }}>{remaining}</td>
                          {canReceive && (
                            <>
                              <td style={{ textAlign: 'right' }}>
                                <input
                                  type="number" min={1} max={remaining}
                                  className="form-input mono"
                                  style={{ width: 76, textAlign: 'right', padding: '4px 8px' }}
                                  value={draft.qty ?? ''}
                                  disabled={!lineReceivable || draft.saving}
                                  placeholder={lineReceivable ? '0' : ''}
                                  onChange={(e) => updateDraft(l.po_line_id, { qty: e.target.value })}
                                />
                              </td>
                              <td>
                                <select
                                  className="form-select"
                                  style={{ padding: '4px 8px' }}
                                  value={draft.bin_id ?? defaultBinId ?? ''}
                                  disabled={!lineReceivable || draft.saving}
                                  onChange={(e) => updateDraft(l.po_line_id, { bin_id: e.target.value })}
                                >
                                  {warehouseBins.map((b) => (
                                    <option key={b.bin_id} value={b.bin_id}>
                                      {b.bin_code}{b.bin_type ? ` (${b.bin_type})` : ''}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <button
                                  className="btn btn-sm btn-primary"
                                  disabled={!lineReceivable || draft.saving}
                                  onClick={() => receiveLine(l)}
                                >
                                  {draft.saving ? 'Recebendo...' : 'Receber'}
                                </button>
                              </td>
                            </>
                          )}
                        </tr>
                        {/* Expanded receipt history for this line.
                            Each row shows the receipt's qty, bin,
                            receiver, and an Unreceive button that
                            opens the confirm modal. */}
                        {isExpanded && lineReceipts.map((r) => (
                          <tr key={`receipt-${r.receipt_id}`} style={{ background: 'var(--surface)' }}>
                            <td colSpan={3}></td>
                            <td colSpan={canReceive ? 6 : 3} style={{ fontSize: 12 }}>
                              <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                                {r.received_at ? new Date(r.received_at).toLocaleString() : '-'}
                              </span>
                              {' - '}
                              <strong>{r.quantity_received}</strong> unidades no endereço{' '}
                              <span className="mono">{r.bin_code}</span>
                              {r.received_by ? <> por <strong>{r.received_by}</strong></> : null}
                              {r.lot_number ? <> (lote {r.lot_number})</> : null}
                              {r.serial_number ? <> (série {r.serial_number})</> : null}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => openUnreceive(r)}
                                title="Estornar este recebimento"
                              >
                                Estornar recebimento
                              </button>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                  {Object.entries(lineDrafts).filter(([, d]) => d.error).map(([lineId, d]) => (
                    <tr key={`err-${lineId}`}>
                      <td colSpan={canReceive ? 10 : 7}>
                        <div className="form-error" style={{ fontSize: 12, padding: '4px 0' }}>
                          Linha {lineId}: {d.error}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Nenhuma linha</p>
            )}
          </section>
        </Modal>
      )}

      {/* Unreceive confirm modal. The operator sees what they're about
          to back out (SKU, qty, bin, when, who) plus an optional
          free-text reason that lands in the ACTION_RECEIVE_CANCEL
          audit row + the receipt.cancelled event payload. */}
      {unreceiving && (
        <Modal
          title={`Estornar recebimento: ${unreceiving.sku}`}
          onClose={closeUnreceive}
          footer={
            <>
              <button
                className="btn"
                onClick={closeUnreceive}
                disabled={unreceiveSubmitting}
              >Cancelar</button>
              <button
                className="btn btn-danger"
                onClick={submitUnreceive}
                disabled={unreceiveSubmitting}
              >
                {unreceiveSubmitting ? 'Estornando...' : 'Estornar recebimento'}
              </button>
            </>
          }
        >
          {unreceiveError && (
            <div className="form-error" style={{ marginBottom: 12 }}>{unreceiveError}</div>
          )}
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Estornar <strong>{unreceiving.quantity_received}</strong> unidades de{' '}
            <span className="mono">{unreceiving.sku}</span>{' '}
            ({unreceiving.item_name}) recebido no endereço{' '}
            <span className="mono">{unreceiving.bin_code}</span>
            {unreceiving.received_at ? (
              <> em {new Date(unreceiving.received_at).toLocaleString()}</>
            ) : null}
            {unreceiving.received_by ? (
              <> por <strong>{unreceiving.received_by}</strong></>
            ) : null}.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            O estoque é baixado do armazém (preferindo o endereço original do recebimento; passa para outros endereços com este material se já foi armazenado). O contador da linha e o status do PC são atualizados juntos, e um evento receipt.cancelled é disparado para que um assinante externo estorne a contagem de entrada.
          </p>
          <div className="form-group">
            <label>Motivo (opcional, registrado na auditoria)</label>
            <input
              className="form-input"
              value={unreceiveReason}
              onChange={(e) => setUnreceiveReason(e.target.value)}
              placeholder="ex.: leitura duplicada"
              maxLength={500}
              disabled={unreceiveSubmitting}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
