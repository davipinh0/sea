import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useWarehouse } from '../warehouse.jsx';
import PageHeader from '../components/PageHeader.jsx';
import StatusTag from '../components/StatusTag.jsx';
import Modal from '../components/Modal.jsx';
import { OtDetailModal, OtTypeTag } from '../components/sea.jsx';
import { DadosOtModal, MaterialOtModal, RegistroOtModal } from '../components/OtForms.jsx';
import { OT_HEADER_FIELDS, formatDate, formatDateTime, readError } from '../utils/sea.js';
import { useLiveRefresh } from '../utils/useLiveRefresh.js';

// Expedição > Recebimento: read the OT barcode, check material code,
// description and expected quantity, receive partially or in full into
// the receiving area. The responsible user and timestamp are recorded by
// the API (same endpoints the mobile app uses, so both stay in sync).
//
// An OT that is not registered yet is looked up in the SAP base: when it
// is there, its materials (order, quantity, unit) and requester are shown
// and the delivery is registered as the base holds it. An OT that is not
// in the base can still be registered from its label. The receiver is
// always the logged-in user.

export default function RecebimentoOT() {
  const { user } = useAuth();
  const { warehouseId } = useWarehouse();
  const inputRef = useRef(null);
  const [code, setCode] = useState('');
  const [ot, setOt] = useState(null);
  const [lines, setLines] = useState([]);
  const [qty, setQty] = useState({});
  const [stagingBins, setStagingBins] = useState([]);
  const [binId, setBinId] = useState('');
  const [openOts, setOpenOts] = useState([]);
  const [info, setInfo] = useState(null);
  // OT scanned but not registered: { code, prefill } (prefill is the OT
  // as the SAP base holds it; null when the code is not in the base).
  const [unknown, setUnknown] = useState(null);
  const [registering, setRegistering] = useState(null);
  const [editingData, setEditingData] = useState(false);
  const [materialId, setMaterialId] = useState(null);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [unreceiving, setUnreceiving] = useState(null);
  const [reason, setReason] = useState('');

  // Bumping ``openTick`` refreshes the list of OTs waiting for receipt.
  const [openTick, setOpenTick] = useState(0);
  const loadOpenOts = () => setOpenTick((n) => n + 1);
  // Only the list of orders waiting: the order being received is not
  // reloaded under the operator (it would erase the quantities typed).
  useLiveRefresh(loadOpenOts);

  useEffect(() => {
    if (!warehouseId) return undefined;
    let cancelled = false;
    api.get(`/sea/ots?warehouse_id=${warehouseId}`).then(async (res) => {
      if (cancelled || !res?.ok) return;
      const all = (await res.json()).ots || [];
      if (!cancelled) setOpenOts(all.filter((o) => o.status === 'OPEN' || o.status === 'PARTIAL'));
    });
    return () => { cancelled = true; };
  }, [warehouseId, openTick]);

  useEffect(() => {
    if (!warehouseId) return;
    api.get(`/sea/recebimentos/areas?warehouse_id=${warehouseId}`).then(async (res) => {
      if (!res?.ok) return;
      // The API returns only the active receiving areas of the location.
      const bins = (await res.json()).bins || [];
      setStagingBins(bins);
      setBinId((current) => current || (bins[0] ? String(bins[0].bin_id) : ''));
    });
  }, [warehouseId]);

  const loadOt = useCallback(async (otCode) => {
    const clean = (otCode || '').trim();
    if (!clean) return;
    setMessage(null);
    const res = await api.get(`/receiving/po/${encodeURIComponent(clean)}`);
    if (!res) return;
    setUnknown(null);
    if (!res.ok) {
      setOt(null);
      setLines([]);
      setInfo(null);
      if (res.status !== 404) {
        setMessage({ type: 'error', text: await readError(res, 'Não foi possível consultar a OT.') });
        return;
      }
      const lookup = await api.get(`/sea/recebimentos/consulta?codigo=${encodeURIComponent(clean)}`);
      const found = lookup?.ok ? await lookup.json() : null;
      setUnknown({ code: clean, prefill: found?.integration?.data || null });
      return;
    }
    const data = await res.json();
    setOt(data.purchase_order);
    setLines(data.lines || []);
    setQty(Object.fromEntries((data.lines || []).map((l) => [l.po_line_id, String(Math.max(0, l.quantity_remaining))])));
    const detailRes = await api.get(`/sea/ots/${encodeURIComponent(data.purchase_order.po_number)}`);
    setInfo(detailRes?.ok ? await detailRes.json() : null);
  }, []);

  async function registerFromBase() {
    if (!warehouseId) {
      setMessage({ type: 'error', text: 'Selecione um local na barra superior.' });
      return;
    }
    setSaving(true);
    const res = await api.post('/sea/recebimentos/base', { warehouse_id: warehouseId, ot_code: unknown.code });
    setSaving(false);
    if (!res) return;
    if (!res.ok) {
      setMessage({ type: 'error', text: await readError(res, 'Não foi possível registrar a entrega.') });
      return;
    }
    await onRegistered(await res.json());
  }

  async function onRegistered(result) {
    setRegistering(null);
    setCode(result.ot);
    await loadOt(result.ot);
    loadOpenOts();
    const base = result.created ? `OT ${result.ot} cadastrada.` : `Material adicionado à OT ${result.ot}.`;
    const diverged = (result.divergences || []).map((d) => d.label).join(', ');
    setMessage({
      type: 'ok',
      text: diverged
        ? `${base} A etiqueta diverge do cadastro em: ${diverged}. O cadastro foi mantido e a diferença ficou registrada para conferência.`
        : `${base} Confira os dados e receba o material.`,
    });
  }

  async function reload() {
    setEditingData(false);
    setMaterialId(null);
    await loadOt(ot.po_number);
    loadOpenOts();
  }

  function onScan(e) {
    e.preventDefault();
    loadOt(code);
  }

  // ``full`` receives every pending line in its remaining quantity
  // (integral receipt) instead of the quantities typed by the operator.
  async function receive(linesToReceive, { full = false } = {}) {
    const items = linesToReceive
      .map((l) => ({ line: l, quantity: full ? l.quantity_remaining : parseInt(qty[l.po_line_id], 10) }))
      .filter((x) => Number.isInteger(x.quantity) && x.quantity > 0);
    if (items.length === 0) {
      setMessage({ type: 'error', text: 'Informe ao menos uma quantidade maior que zero.' });
      return;
    }
    const over = items.find((x) => x.quantity > x.line.quantity_remaining);
    if (over) {
      setMessage({ type: 'error', text: `A quantidade de ${over.line.sku} (${over.quantity}) é maior que o restante previsto (${over.line.quantity_remaining}).` });
      return;
    }
    if (!binId) {
      setMessage({ type: 'error', text: 'Nenhuma área de recebimento cadastrada neste local.' });
      return;
    }
    setSaving(true);
    const res = await api.post('/receiving/receive', {
      po_id: ot.po_id,
      items: items.map((x) => ({ item_id: x.line.item_id, quantity: x.quantity, bin_id: parseInt(binId, 10) })),
    });
    setSaving(false);
    if (!res) return;
    if (!res.ok) {
      setMessage({ type: 'error', text: await readError(res, 'Não foi possível registrar o recebimento.') });
      return;
    }
    const total = items.reduce((acc, x) => acc + x.quantity, 0);
    setMessage({
      type: 'ok',
      text: `${total} unidade(s) recebida(s) por ${user?.full_name || user?.username} em ${formatDateTime(new Date().toISOString())}. Material disponível para armazenagem.`,
    });
    await loadOt(ot.po_number);
    loadOpenOts();
  }

  async function confirmUnreceive() {
    const res = await api.post(`/admin/receipts/${unreceiving.receipt_id}/unreceive`, { reason: reason || null });
    if (!res) return;
    if (!res.ok) {
      setMessage({ type: 'error', text: await readError(res, 'Não foi possível estornar o recebimento.') });
    } else {
      setMessage({ type: 'ok', text: `Recebimento de ${unreceiving.sku} estornado.` });
      await loadOt(ot.po_number);
      loadOpenOts();
    }
    setUnreceiving(null);
    setReason('');
  }

  const receivable = ot && (ot.status === 'OPEN' || ot.status === 'PARTIAL');
  const pending = lines.filter((l) => l.quantity_remaining > 0);
  const receipts = info?.receipts || [];
  const otData = info?.ot || null;
  const materials = Object.fromEntries((info?.materials || []).map((m) => [m.po_line_id, m]));
  const material = materialId ? materials[materialId] : null;

  return (
    <div>
      <PageHeader title="Recebimento de Ordem" />

      <form onSubmit={onScan} className="card" style={{ marginBottom: 16 }}>
        <label className="form-group" style={{ display: 'block' }}>
          <span>Código de barras da OT</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={inputRef}
              autoFocus
              className="form-input"
              style={{ fontSize: 20, fontFamily: 'var(--mono)' }}
              placeholder="Leia ou digite o número da OT (ex.: 1003329915)"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit" className="btn btn-primary">Consultar</button>
          </div>
        </label>
        <div className="settings-note">
          O código de barras é o da OT. O SEA procura a OT na base do SAP e traz os materiais, as ordens PM11/PM12, as quantidades, as unidades e o solicitante.
          Recebedor: <strong>{user?.full_name || user?.username}</strong> (quem está registrando a entrega).
        </div>
      </form>

      {message && (
        <div className={message.type === 'error' ? 'form-error' : 'tag tag-success'} style={{ display: 'block', padding: 12, marginBottom: 16 }}>
          {message.text}
          {message.type === 'ok' && <> {' '}<Link to="/expedicao/armazenagem">Ir para a armazenagem →</Link></>}
        </div>
      )}

      {unknown && unknown.prefill && (
        <div className="card" style={{ marginBottom: 16 }} role="status">
          <div className="card-title">OT {unknown.prefill.header.ot_code} encontrada na base do SAP</div>
          <div className="detail-grid" style={{ marginBottom: 12 }}>
            <div><span className="detail-label">Reserva</span> {unknown.prefill.header.reservation_number || '-'}</div>
            <div><span className="detail-label">Solicitante</span> {unknown.prefill.header.requester_name || '-'}</div>
            <div><span className="detail-label">Data necessária</span> {formatDate(unknown.prefill.header.needed_date)}</div>
            <div><span className="detail-label">Recebedor</span> {user?.full_name || user?.username}</div>
          </div>
          <table className="lines-table">
            <thead><tr><th>Ordem</th><th>Tipo</th><th>Código</th><th>Descrição</th><th>Lote</th><th>Quantidade</th><th>Unidade</th></tr></thead>
            <tbody>
              {unknown.prefill.materials.map((m) => (
                <tr key={m.material_code}>
                  <td className="mono">{m.service_order_number}</td>
                  <td><OtTypeTag type={m.service_order_type} /></td>
                  <td className="mono">{m.material_code}</td>
                  <td>{m.description}</td>
                  <td className="mono">{m.lot_number || '-'}</td>
                  <td>{m.quantity}</td>
                  <td>{m.uom || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={saving} onClick={registerFromBase}>
            Registrar entrega
          </button>
        </div>
      )}

      {unknown && !unknown.prefill && (
        <div className="card" style={{ marginBottom: 16 }} role="status">
          <div className="card-title">OT {unknown.code} não encontrada na base do SAP</div>
          <p className="settings-note">
            Confira o código lido. Se a OT ainda não chegou à base, o recebimento pode ser iniciado com os dados da etiqueta.
          </p>
          <button type="button" className="btn" onClick={() => setRegistering({ otCode: unknown.code })}>
            Iniciar recebimento pela etiqueta
          </button>
        </div>
      )}

      {ot && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            OT {ot.po_number} <OtTypeTag type={ot.order_type} />
            <StatusTag status={ot.status} />
            <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setDetail(ot.po_number)}>Histórico completo</button>
          </div>
          {!ot.order_type && <p className="form-error">Este pedido não é uma ordem PM11/PM12 do SEA.</p>}
          {otData && (
            <>
              <div className="detail-grid" style={{ marginBottom: 12 }}>
                {OT_HEADER_FIELDS.map((f) => (
                  <div key={f.key}>
                    <span className="detail-label">{f.label}</span>{' '}
                    {otData[f.key]
                      ? (f.type === 'date' ? formatDate(otData[f.key]) : otData[f.key])
                      : <span className="tag tag-warning">pendente</span>}
                  </div>
                ))}
              </div>
              {otData.review_notes?.length > 0 && (
                <div className="form-error" style={{ marginBottom: 12 }}>
                  <strong>Para conferência:</strong>
                  <ul style={{ margin: '4px 0 0 18px' }}>{otData.review_notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button type="button" className="btn btn-sm" disabled={!receivable} onClick={() => setRegistering({ existingOt: otData })}>+ Adicionar material</button>
                <button type="button" className="btn btn-sm" disabled={!receivable} onClick={() => setEditingData(true)}>Corrigir dados</button>
              </div>
            </>
          )}
          <div className="detail-grid" style={{ marginBottom: 12 }}>
            {!otData && <div><span className="detail-label">Origem</span> {ot.vendor_name || '-'}</div>}
            {!otData && <div><span className="detail-label">Prevista</span> {ot.expected_date || '-'}</div>}
            <div>
              <span className="detail-label">Área de recebimento</span>{' '}
              <select className="form-select" value={binId} onChange={(e) => setBinId(e.target.value)} aria-label="Área de recebimento">
                {stagingBins.map((b) => <option key={b.bin_id} value={b.bin_id}>{b.bin_code}</option>)}
              </select>
            </div>
          </div>

          <table className="lines-table">
            <thead>
              <tr><th>Ordem</th><th>Tipo</th><th>Código</th><th>Descrição</th><th>Lote</th><th>Un.</th><th>Prevista</th><th>Recebida</th><th>Restante</th><th>Receber agora</th><th /></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.po_line_id}>
                  <td className="mono">{materials[l.po_line_id]?.service_order_number || '-'}</td>
                  <td>{materials[l.po_line_id]?.service_order_type || '-'}</td>
                  <td className="mono">{l.sku}</td>
                  <td>{l.item_name}</td>
                  <td className="mono">{materials[l.po_line_id]?.lot_number || '-'}</td>
                  <td>{materials[l.po_line_id]?.uom || '-'}</td>
                  <td>{l.quantity_ordered}</td>
                  <td>{l.quantity_received}</td>
                  <td>{l.quantity_remaining}</td>
                  <td>
                    <input
                      type="number" min="0" max={l.quantity_remaining}
                      className="form-input" style={{ width: 90 }}
                      aria-label={`Quantidade a receber de ${l.sku}`}
                      disabled={!receivable || l.quantity_remaining <= 0}
                      value={qty[l.po_line_id] ?? ''}
                      onChange={(e) => setQty((q) => ({ ...q, [l.po_line_id]: e.target.value }))}
                    />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" disabled={!receivable || saving || l.quantity_remaining <= 0} onClick={() => receive([l])}>
                      Receber
                    </button>
                    {materials[l.po_line_id] && (
                      <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} aria-label={`Detalhes de ${l.sku}`} onClick={() => setMaterialId(l.po_line_id)}>
                        Detalhes
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button" className="btn btn-primary"
              disabled={!receivable || saving || pending.length === 0}
              onClick={() => receive(pending, { full: true })}
            >
              {saving ? 'Recebendo...' : 'Receber ordem integral'}
            </button>
            <button type="button" className="btn" disabled={!receivable || saving} onClick={() => receive(pending)}>
              Receber quantidades informadas (parcial)
            </button>
          </div>

          {receipts.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 16 }}>Recebimentos registrados</div>
              <table className="lines-table">
                <thead><tr><th>Código</th><th>Qtd.</th><th>Endereço</th><th>Responsável</th><th>Data/hora</th><th /></tr></thead>
                <tbody>
                  {receipts.map((r) => (
                    <tr key={r.receipt_id}>
                      <td className="mono">{r.sku}</td><td>{r.quantity}</td><td className="mono">{r.bin_code}</td>
                      <td>{r.received_by}</td><td>{formatDateTime(r.received_at)}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setUnreceiving(r)}>Estornar</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      <div className="section-title">Ordens aguardando recebimento</div>
      {openOts.length === 0 ? <p className="settings-note">Nenhuma ordem aberta.</p> : (
        <table className="lines-table">
          <thead><tr><th>Ordem (OT)</th><th>Tipo</th><th>Status</th><th>Prevista</th><th>Recebida</th><th /></tr></thead>
          <tbody>
            {openOts.map((o) => (
              <tr key={o.po_id}>
                <td className="mono">{o.ot}</td><td><OtTypeTag type={o.order_type} /></td>
                <td><StatusTag status={o.status} /></td><td>{o.qty_ordered}</td><td>{o.qty_received}</td>
                <td><button type="button" className="btn btn-sm" onClick={() => { setCode(o.ot); loadOt(o.ot); }}>Receber</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && <OtDetailModal code={detail} onClose={() => setDetail(null)} />}
      {registering && (
        <RegistroOtModal
          warehouseId={warehouseId} otCode={registering.otCode} existingOt={registering.existingOt}
          onClose={() => setRegistering(null)} onSaved={onRegistered}
        />
      )}
      {editingData && otData && <DadosOtModal ot={otData} onClose={() => setEditingData(false)} onSaved={reload} />}
      {material && otData && <MaterialOtModal ot={otData} material={material} onClose={() => setMaterialId(null)} onChanged={reload} />}
      {unreceiving && (
        <Modal
          title={`Estornar recebimento de ${unreceiving.sku}`}
          onClose={() => setUnreceiving(null)}
          footer={<>
            <button type="button" className="btn" onClick={() => setUnreceiving(null)}>Cancelar</button>
            <button type="button" className="btn btn-danger" onClick={confirmUnreceive}>Estornar</button>
          </>}
        >
          <p>{unreceiving.quantity} unidade(s) recebida(s) por {unreceiving.received_by} serão retiradas do estoque desta ordem.</p>
          <label className="form-group" style={{ display: 'block' }}>
            <span>Motivo (opcional, registrado na auditoria)</span>
            <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex.: leitura duplicada" />
          </label>
        </Modal>
      )}
    </div>
  );
}
