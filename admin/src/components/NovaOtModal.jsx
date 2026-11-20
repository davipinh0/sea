import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import { readError } from '../utils/sea.js';

// Cadastro manual de OT (PM11/PM12). Uma integração com o SAP criaria os mesmos registros.

const EMPTY_LINE = { item_id: '', quantity: '' };

export default function NovaOtModal({ warehouseId, onClose, onCreated }) {
  const [number, setNumber] = useState('');
  const [type, setType] = useState('PM11');
  const [origin, setOrigin] = useState('SAP (simulado)');
  const [expected, setExpected] = useState('');
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/admin/items?per_page=1000&active=true').then(async (res) => {
      if (!res?.ok) return;
      setItems(((await res.json()).items || []).sort((a, b) => a.sku.localeCompare(b.sku)));
    });
  }, []);

  function setLine(i, patch) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function save() {
    setError('');
    const clean = number.trim();
    if (!clean) { setError('Informe o número da ordem.'); return; }
    if (!warehouseId) { setError('Selecione um local na barra superior.'); return; }
    const parsed = lines
      .filter((l) => l.item_id || l.quantity)
      .map((l) => ({ item_id: parseInt(l.item_id, 10), quantity_ordered: parseInt(l.quantity, 10) }));
    if (parsed.length === 0) { setError('Adicione ao menos um material.'); return; }
    if (parsed.some((l) => !l.item_id || !Number.isInteger(l.quantity_ordered) || l.quantity_ordered <= 0)) {
      setError('Cada linha precisa de um material e uma quantidade maior que zero.');
      return;
    }
    if (new Set(parsed.map((l) => l.item_id)).size !== parsed.length) {
      setError('O mesmo material aparece em mais de uma linha.');
      return;
    }
    setSaving(true);
    const res = await api.post('/admin/purchase-orders', {
      po_number: clean,
      po_barcode: clean,
      warehouse_id: warehouseId,
      order_type: type,
      vendor_name: origin.trim() || null,
      expected_date: expected || null,
      lines: parsed.map((l, idx) => ({ ...l, line_number: idx + 1 })),
    });
    setSaving(false);
    if (!res) return;
    if (!res.ok) {
      setError(await readError(res, 'Não foi possível criar a ordem. Verifique se o número já existe.'));
      return;
    }
    onCreated(clean);
  }

  return (
    <Modal
      title="Nova ordem de serviço"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Criando...' : 'Criar ordem'}
        </button>
      </>}
    >
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="ot-number">Número / código de barras</label>
          <input id="ot-number" className="form-input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="ex.: OT-7000010" />
        </div>
        <div className="form-group">
          <label htmlFor="ot-type">Tipo</label>
          <select id="ot-type" className="form-select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="PM11">PM11</option>
            <option value="PM12">PM12</option>
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="ot-origin">Origem</label>
          <input id="ot-origin" className="form-input" value={origin} onChange={(e) => setOrigin(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="ot-expected">Data prevista</label>
          <input id="ot-expected" type="date" className="form-input" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      </div>
      <div className="section-title">Materiais</div>
      {lines.map((l, i) => (
        <div className="form-row" key={i}>
          <div className="form-group" style={{ flex: 3 }}>
            <select className="form-select" aria-label={`Material da linha ${i + 1}`} value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })}>
              <option value="">Escolha o material…</option>
              {items.map((it) => <option key={it.item_id} value={it.item_id}>{it.sku} - {it.item_name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <input type="number" min="1" className="form-input" aria-label={`Quantidade da linha ${i + 1}`} placeholder="Qtd." value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
          </div>
          <button type="button" className="btn btn-sm" aria-label={`Remover linha ${i + 1}`} disabled={lines.length === 1}
            onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>&times;</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}>+ Material</button>
      {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}
