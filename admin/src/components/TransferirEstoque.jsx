import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatQuantity, readError } from '../utils/sea.js';

// Estoque > Materiais > material: where the material is and the option to
// move it to another address, in the same location (A1 to B2) or to
// another one (SP12 to the Contêiner de Solda). The API applies the
// rules (free balance, whole boxes, size class, capacity, compatibility).

export default function TransferirEstoque({ itemId, onMoved }) {
  const [stock, setStock] = useState(null);
  const [bins, setBins] = useState([]);
  const [moving, setMoving] = useState(null);
  const [toBin, setToBin] = useState('');
  const [quantity, setQuantity] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  // Bumping ``tick`` reloads the stock after a transfer.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get(`/sea/materiais/${itemId}/estoque`, { silentPermissionDenied: true }).then(async (res) => {
      const rows = res?.ok ? (await res.json()).stock || [] : [];
      if (!cancelled) setStock(rows);
    });
    return () => { cancelled = true; };
  }, [itemId, tick]);
  useEffect(() => {
    api.get('/sea/armazenagem/destinos', { silentPermissionDenied: true }).then(async (res) => {
      if (res?.ok) setBins((await res.json()).bins || []);
    });
  }, []);

  function start(row) {
    setMoving(row);
    setToBin('');
    setQuantity(String(row.available));
    setMessage(null);
  }

  async function confirm() {
    const amount = Number(quantity);
    if (!toBin) { setMessage({ type: 'error', text: 'Escolha o endereço de destino.' }); return; }
    if (!Number.isInteger(amount) || amount <= 0) { setMessage({ type: 'error', text: 'Informe a quantidade (número inteiro maior que zero).' }); return; }
    if (amount > moving.available) { setMessage({ type: 'error', text: `A quantidade é maior que o saldo livre (${moving.available}).` }); return; }
    setBusy(true);
    const res = await api.post('/sea/transferencias', { inventory_id: moving.inventory_id, to_bin_id: Number(toBin), quantity: amount });
    setBusy(false);
    if (!res) return;
    if (!res.ok) { setMessage({ type: 'error', text: await readError(res, 'Não foi possível transferir.') }); return; }
    const done = await res.json();
    setMessage({ type: 'ok', text: `${formatQuantity(done.quantity, moving.uom, moving.pack_weight_kg)} de ${done.sku} transferido(s) de ${done.from} para ${done.to}.` });
    setMoving(null);
    setTick((n) => n + 1);
    onMoved?.();
  }

  if (stock === null) return null;
  // Destinations grouped by location, without the address the stock is in.
  const groups = {};
  for (const b of bins) {
    if (moving && b.bin_id === moving.bin_id) continue;
    (groups[b.warehouse_code] ||= []).push(b);
  }

  return (
    <>
      <div className="section-title">Localizações no estoque</div>
      {message && (
        <div className={message.type === 'error' ? 'form-error' : 'tag tag-success'} role={message.type === 'error' ? 'alert' : 'status'} style={{ display: 'block', padding: 10, marginBottom: 10 }}>
          {message.text}
        </div>
      )}
      {stock.length === 0 ? <p className="settings-note">Sem saldo em estoque.</p> : (
        <table className="lines-table">
          <thead><tr><th>Local · Endereço</th><th>Ordem (OT)</th><th>Em estoque</th><th>Reservado</th><th>Livre</th><th /></tr></thead>
          <tbody>
            {stock.map((s) => (
              <tr key={s.inventory_id}>
                <td className="mono">{s.warehouse_code} · {s.bin_code}{!s.stored && ' (recebimento)'}</td>
                <td className="mono">{s.ot || '-'}</td>
                <td>{formatQuantity(s.quantity_on_hand, s.uom, s.pack_weight_kg)}</td>
                <td>{s.quantity_allocated}</td>
                <td>{s.available}</td>
                <td>
                  {s.stored && s.available > 0 && (
                    <button type="button" className="btn btn-sm" aria-label={`Transferir de ${s.warehouse_code} · ${s.bin_code}`} onClick={() => start(s)}>Transferir</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {moving && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-title">Transferir de {moving.warehouse_code} · {moving.bin_code}</div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="transfer-to">Destino</label>
              <select id="transfer-to" className="form-select" value={toBin} onChange={(e) => setToBin(e.target.value)}>
                <option value="">Escolha o endereço</option>
                {Object.entries(groups).map(([code, list]) => (
                  <optgroup key={code} label={`${code} - ${list[0].warehouse_name}`}>
                    {list.map((b) => <option key={b.bin_id} value={b.bin_id}>{code} · {b.bin_code}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="transfer-qty">Quantidade{moving.uom ? ` (${moving.uom})` : ''}</label>
              <input id="transfer-qty" className="form-input" type="number" min={moving.pack_weight_kg || 1} max={moving.available}
                step={moving.pack_weight_kg || 1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              <div className="settings-note">
                Saldo livre: {formatQuantity(moving.available, moving.uom, moving.pack_weight_kg)}.
                {moving.pack_weight_kg ? ` Caixas inteiras de ${moving.pack_weight_kg} KG.` : ''}
                {moving.quantity_allocated > 0 ? ` ${moving.quantity_allocated} reservado(s) para retirada não podem ser movidos.` : ''}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={confirm}>{busy ? 'Transferindo...' : 'Confirmar transferência'}</button>
            <button type="button" className="btn" onClick={() => setMoving(null)}>Cancelar</button>
          </div>
        </div>
      )}
    </>
  );
}
