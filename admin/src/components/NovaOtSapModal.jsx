import { useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import { readError } from '../utils/sea.js';

// Monta uma OT na base do SAP à mão. Descrição, unidade e peso da caixa vêm do Cadastro de
// materiais; depois ela se comporta como uma OT vinda do SAP.

const EMPTY_LINE = { order_number: '', order_type: 'PM11', material_code: '', quantity: '', found: null, missing: false };

export default function NovaOtSapModal({ onClose, onCreated }) {
  const [header, setHeader] = useState({ ot_number: '', reservation_number: '', requester_name: '', needed_date: '' });
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function setLine(index, patch) {
    setLines((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function lookup(index) {
    const code = lines[index].material_code.trim();
    if (!code) { setLine(index, { found: null, missing: false }); return; }
    const res = await api.get(`/sea/catalogo/${encodeURIComponent(code)}`, { silentPermissionDenied: true });
    if (!res) return;
    if (res.ok) {
      const found = await res.json();
      setLine(index, { found: found.source === 'cadastro' ? found : null, missing: found.source !== 'cadastro' });
    } else {
      setLine(index, { found: null, missing: true });
    }
  }

  async function save() {
    setError('');
    const ot = header.ot_number.trim();
    if (!ot) { setError('Informe o número da OT.'); return; }
    const filled = lines.filter((l) => l.material_code.trim() || l.quantity || l.order_number.trim());
    if (filled.length === 0) { setError('Adicione ao menos um material.'); return; }
    for (const l of filled) {
      const qty = Number(l.quantity);
      if (!l.order_number.trim()) { setError('Informe a ordem de cada material.'); return; }
      if (!l.material_code.trim()) { setError('Informe o código de cada material.'); return; }
      if (!Number.isInteger(qty) || qty <= 0) { setError(`Informe a quantidade do material ${l.material_code} (número inteiro maior que zero).`); return; }
    }
    setBusy(true);
    const res = await api.post('/sea/sap/ots', {
      ot_number: ot,
      reservation_number: header.reservation_number.trim() || null,
      requester_name: header.requester_name.trim() || null,
      needed_date: header.needed_date || null,
      materials: filled.map((l) => ({
        order_number: l.order_number.trim(), order_type: l.order_type,
        material_code: l.material_code.trim(), quantity: Number(l.quantity),
      })),
    });
    setBusy(false);
    if (!res) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível criar a OT.')); return; }
    onCreated(ot);
  }

  return (
    <Modal
      title="Nova OT" onClose={onClose} size="wide"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Criando...' : 'Criar OT'}</button>
      </>}
    >
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="sap-ot">Número da OT *</label>
          <input id="sap-ot" className="form-input mono" value={header.ot_number} onChange={(e) => setHeader({ ...header, ot_number: e.target.value })} />
        </div>
        <div className="form-group">
          <label htmlFor="sap-reserva">Reserva</label>
          <input id="sap-reserva" className="form-input mono" value={header.reservation_number} onChange={(e) => setHeader({ ...header, reservation_number: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="sap-solicitante">Solicitante</label>
          <input id="sap-solicitante" className="form-input" value={header.requester_name} onChange={(e) => setHeader({ ...header, requester_name: e.target.value })} />
        </div>
        <div className="form-group">
          <label htmlFor="sap-data">Data necessária</label>
          <input id="sap-data" type="date" className="form-input" value={header.needed_date} onChange={(e) => setHeader({ ...header, needed_date: e.target.value })} />
        </div>
      </div>

      <div className="section-title">Materiais</div>
      <p className="settings-note">Informe o código: a descrição, a unidade e o peso por caixa vêm do cadastro de materiais.</p>
      {lines.map((l, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <input className="form-input mono" aria-label={`Ordem do material ${i + 1}`} placeholder="Ordem" value={l.order_number} onChange={(e) => setLine(i, { order_number: e.target.value })} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <select className="form-select" aria-label={`Tipo da ordem do material ${i + 1}`} value={l.order_type} onChange={(e) => setLine(i, { order_type: e.target.value })}>
                <option value="PM11">PM11</option>
                <option value="PM12">PM12</option>
              </select>
            </div>
            <div className="form-group" style={{ flex: 2 }}>
              <input className="form-input mono" aria-label={`Código do material ${i + 1}`} placeholder="Código do material" value={l.material_code}
                onChange={(e) => setLine(i, { material_code: e.target.value, found: null, missing: false })} onBlur={() => lookup(i)} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <input type="number" min="1" className="form-input" aria-label={`Quantidade do material ${i + 1}`} placeholder="Qtd." value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            </div>
            <button type="button" className="btn btn-sm" aria-label={`Remover material ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((all) => all.filter((_, idx) => idx !== i))}>&times;</button>
          </div>
          {l.found && (
            <div className="settings-note" role="status">
              {l.found.description} · unidade {l.found.uom || 'não definida'}{l.found.pack_weight_kg ? ` · caixa de ${l.found.pack_weight_kg} kg` : ''}
            </div>
          )}
          {l.missing && <div className="form-error" role="alert">Material não está no cadastro. Cadastre-o em Sistema &gt; Cadastro de materiais.</div>}
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setLines((all) => [...all, { ...EMPTY_LINE }])}>+ Material</button>
      {error && <div className="form-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}
