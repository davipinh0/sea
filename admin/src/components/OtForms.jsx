import { useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import StatusTag from './StatusTag.jsx';
import {
  MOVEMENT_LABELS, OT_HEADER_FORM, OT_MATERIAL_FIELDS,
  fieldsToPayload, formatDate, formatDateTime, payloadToFields, readError,
} from '../utils/sea.js';

// Receiving by label: register an OT and its materials from the label
// text, correct the registered data, and consult one material with its
// lot, locations and movements. The API interprets and validates; these
// forms only collect and show.

function Pending() {
  return <span className="tag tag-warning" style={{ marginLeft: 6 }}>pendente</span>;
}

function FieldGrid({ fields, values, onChange, idPrefix, flagPending, disabled = {} }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const value = values[f.key] ?? '';
        const common = {
          id, value, disabled: !!disabled[f.key],
          onChange: (e) => onChange({ ...values, [f.key]: e.target.value }),
        };
        return (
          <div className="form-group" key={f.key} style={{ margin: 0 }}>
            <label htmlFor={id}>{f.label}{flagPending && value === '' && !f.optional && <Pending />}</label>
            {f.options ? (
              <select className="form-select" {...common}>
                <option value="">—</option>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input className="form-input" type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'} min={f.type === 'number' ? 1 : undefined} {...common} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const MATERIAL_FORM = OT_MATERIAL_FIELDS.map((f) => (f.key === 'expiry_date' ? { ...f, optional: true } : f));

// New receipt (OT not registered yet) or one more material for an
// existing OT. ``existingOt`` is the OT detail when adding a material.
export function RegistroOtModal({ warehouseId, otCode, existingOt, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [ot, setOt] = useState(existingOt?.ot || otCode || '');
  const [header, setHeader] = useState(payloadToFields(OT_HEADER_FORM, existingOt));
  const [material, setMaterial] = useState(payloadToFields(MATERIAL_FORM));
  const [reading, setReading] = useState(null);
  const [fromLabel, setFromLabel] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function interpret() {
    setError('');
    if (!text.trim()) { setError('Cole ou digite o texto da etiqueta.'); return; }
    setBusy(true);
    const res = await api.post('/sea/etiquetas/interpretar', { text });
    setBusy(false);
    if (!res) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível interpretar a etiqueta.')); return; }
    const data = await res.json();
    const labelOt = data.header.ot_code;
    if (existingOt && labelOt && labelOt !== existingOt.ot) {
      setError(`Esta etiqueta é da OT ${labelOt}, não da OT ${existingOt.ot}. Nada foi preenchido.`);
      return;
    }
    if (labelOt) setOt(labelOt);
    // Only values actually read replace what is on the form.
    const read = (fields, parsed, current) => {
      const next = payloadToFields(fields, parsed);
      return Object.fromEntries(fields.map((f) => [f.key, next[f.key] !== '' ? next[f.key] : current[f.key]]));
    };
    setHeader((h) => read(OT_HEADER_FORM, data.header, h));
    setMaterial((m) => read(MATERIAL_FORM, data.materials[0], m));
    setReading(data);
    setFromLabel(true);
  }

  async function save() {
    setError('');
    const code = ot.trim();
    const m = fieldsToPayload(MATERIAL_FORM, material);
    if (!code) { setError('Informe o código da OT.'); return; }
    if (!warehouseId) { setError('Selecione um local na barra superior.'); return; }
    if (!existingOt && !header.service_order_type) { setError('Informe o tipo da ordem de serviço (PM11 ou PM12).'); return; }
    if (!m.material_code) { setError('Informe o código do material.'); return; }
    if (!Number.isInteger(m.quantity) || m.quantity <= 0) { setError('Informe a quantidade (número inteiro maior que zero).'); return; }
    setBusy(true);
    const res = await api.post('/sea/recebimentos', {
      warehouse_id: warehouseId,
      header: { ot_code: code, ...fieldsToPayload(OT_HEADER_FORM, header) },
      materials: [m],
      source: fromLabel ? 'ETIQUETA' : 'MANUAL',
      unrecognized: reading?.unrecognized || [],
    });
    setBusy(false);
    if (!res) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível registrar o recebimento.')); return; }
    onSaved(await res.json());
  }

  const duplicate = reading?.existing?.material && reading.existing.material !== 'NOVO';

  return (
    <Modal
      title={existingOt ? `Adicionar material à ordem (OT ${existingOt.ot})` : 'Novo recebimento de ordem'}
      onClose={onClose}
      size="wide"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
          {existingOt ? 'Confirmar material' : 'Confirmar cadastro'}
        </button>
      </>}
    >
      <div className="form-group">
        <label htmlFor="etq-text">Texto da etiqueta</label>
        <textarea
          id="etq-text" className="form-input" rows={6} style={{ fontFamily: 'var(--mono)' }}
          placeholder={'Cole aqui o texto da etiqueta, um campo por linha. Ex.:\nOT: 1003329915\nReserva: 0285365145 /02\nCódigo: 74165325'}
          value={text} onChange={(e) => setText(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
          <button type="button" className="btn" disabled={busy} onClick={interpret}>Interpretar etiqueta</button>
          <span className="settings-note" style={{ margin: 0 }}>
            A interpretação apenas preenche o formulário. Confira e corrija antes de confirmar.
          </span>
        </div>
      </div>

      {reading && (
        <div className="card" style={{ marginBottom: 12 }} role="status">
          {reading.pending.length === 0 && reading.warnings.length === 0 && reading.unrecognized.length === 0
            ? 'Todos os campos da etiqueta foram identificados.'
            : 'Leitura concluída com itens para conferência:'}
          {reading.pending.length > 0 && <div>Campos não identificados: marcados como <Pending /> abaixo.</div>}
          {reading.warnings.map((w) => <div key={w} className="form-error">{w}</div>)}
          {reading.unrecognized.length > 0 && (
            <div>
              Texto não reconhecido (será guardado na OT para conferência):
              <ul style={{ margin: '4px 0 0 18px' }}>{reading.unrecognized.map((u) => <li key={u} className="mono">{u}</li>)}</ul>
            </div>
          )}
          {duplicate && (
            <div className="form-error">
              {reading.existing.material === 'DUPLICADO'
                ? `Possível duplicidade: este material e lote já estão cadastrados na OT ${reading.existing.ot}.`
                : `Atenção: este material já está cadastrado na OT ${reading.existing.ot} com outro lote.`}
            </div>
          )}
        </div>
      )}

      <div className="section-title">Identificação do recebimento</div>
      <div className="form-group">
        <label htmlFor="etq-ot">Código da OT</label>
        <input id="etq-ot" className="form-input mono" value={ot} disabled={!!existingOt} onChange={(e) => setOt(e.target.value)} />
      </div>
      <FieldGrid fields={OT_HEADER_FORM} values={header} onChange={setHeader} idPrefix="etq-h" flagPending={!!reading} />
      {existingOt && (
        <p className="settings-note">
          Dados já cadastrados na OT não são sobrescritos: campos vazios são preenchidos e diferenças ficam registradas para conferência.
        </p>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>Material</div>
      <FieldGrid fields={MATERIAL_FORM} values={material} onChange={setMaterial} idPrefix="etq-m" flagPending={!!reading} />
      {error && <div className="form-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}

// Correct the header of a registered OT. Sends only what changed.
export function DadosOtModal({ ot, onClose, onSaved }) {
  const initial = payloadToFields(OT_HEADER_FORM, ot);
  const [header, setHeader] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setError('');
    const all = fieldsToPayload(OT_HEADER_FORM, header);
    const changes = Object.fromEntries(
      OT_HEADER_FORM.filter((f) => header[f.key] !== initial[f.key]).map((f) => [f.key, all[f.key]]),
    );
    if (Object.keys(changes).length === 0) { onClose(); return; }
    setBusy(true);
    const res = await api.put(`/sea/ots/${ot.po_id}/dados`, changes);
    setBusy(false);
    if (!res) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível salvar a correção.')); return; }
    onSaved();
  }

  return (
    <Modal
      title={`Corrigir dados da OT ${ot.ot}`}
      onClose={onClose}
      size="wide"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Salvar correção</button>
      </>}
    >
      <FieldGrid fields={OT_HEADER_FORM} values={header} onChange={setHeader} idPrefix="ot-d" flagPending />
      {error && <div className="form-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}

const MATERIAL_EDIT = MATERIAL_FORM.filter((f) => !['material_code', 'description'].includes(f.key));

// One material of an OT: what was registered, where it is, how much is
// left and every movement, without going back to the label.
export function MaterialOtModal({ ot, material, onClose, onChanged }) {
  const editable = ot.status !== 'CLOSED' && ot.status !== 'ARCHIVED';
  const initial = payloadToFields(MATERIAL_EDIT, { ...material, quantity: material.quantity_ordered });
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const url = `/sea/ots/${ot.po_id}/materiais/${material.po_line_id}`;

  async function send(request, fallback) {
    setError('');
    setBusy(true);
    const res = await request();
    setBusy(false);
    if (!res) return;
    if (!res.ok) { setError(await readError(res, fallback)); return; }
    onChanged();
  }

  function save() {
    const all = fieldsToPayload(MATERIAL_EDIT, form);
    const changes = Object.fromEntries(
      MATERIAL_EDIT.filter((f) => form[f.key] !== initial[f.key]).map((f) => [f.key, all[f.key]]),
    );
    if (Object.keys(changes).length === 0) { onClose(); return; }
    send(() => api.put(url, changes), 'Não foi possível salvar a correção.');
  }

  const unit = material.uom ? ` ${material.uom}` : '';
  return (
    <Modal
      title={`Material ${material.sku} — OT ${ot.ot}`}
      onClose={onClose}
      size="wide"
      footer={editable && <>
        {material.quantity_received === 0 && (
          <button type="button" className="btn btn-danger" disabled={busy} style={{ marginRight: 'auto' }}
            onClick={() => send(() => api.delete(url), 'Não foi possível remover o material.')}>
            Remover da OT
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>Fechar</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Salvar correção</button>
      </>}
    >
      <div className="detail-grid" style={{ marginBottom: 16 }}>
        <div><span className="detail-label">Código</span> <span className="mono">{material.sku}</span></div>
        <div><span className="detail-label">Descrição</span> {material.item_name}</div>
        <div><span className="detail-label">Lote</span> {material.lot_number ? <span className="mono">{material.lot_number}</span> : <Pending />}</div>
        <div><span className="detail-label">Vencimento</span> {material.expiry_date ? formatDate(material.expiry_date) : 'Não informado'}</div>
        <div><span className="detail-label">Prevista</span> {material.quantity_ordered}{unit}</div>
        <div><span className="detail-label">Recebida</span> {material.quantity_received}{unit}</div>
        <div><span className="detail-label">Em estoque</span> {material.quantity_in_stock}{unit}</div>
        <div><span className="detail-label">Disponível</span> {material.quantity_available}{unit}</div>
        <div><span className="detail-label">Retirada</span> {material.quantity_withdrawn}{unit}</div>
        <div><span className="detail-label">Status</span> <StatusTag status={material.status} /></div>
      </div>

      <div className="section-title">Localização</div>
      {material.locations.length === 0 ? <p className="settings-note">Sem saldo em estoque.</p> : (
        <table className="lines-table">
          <thead><tr><th>Endereço</th><th>Em estoque</th><th>Reservado</th><th>Disponível</th></tr></thead>
          <tbody>
            {material.locations.map((l) => (
              <tr key={l.bin_code}>
                <td className="mono">{l.bin_code}{!l.stored && ' (recebimento)'}</td>
                <td>{l.quantity_on_hand}</td><td>{l.quantity_allocated}</td><td>{l.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>Movimentações</div>
      {material.movements.length === 0 ? <p className="settings-note">Nenhuma movimentação ainda.</p> : (
        <table className="lines-table">
          <thead><tr><th>Tipo</th><th>Qtd.</th><th>Origem</th><th>Destino</th><th>Responsável</th><th>Data/hora</th></tr></thead>
          <tbody>
            {material.movements.map((m, i) => (
              <tr key={`${m.kind}-${m.moved_at}-${i}`}>
                <td>{MOVEMENT_LABELS[m.kind] || m.kind}</td><td>{m.quantity}</td>
                <td className="mono">{m.origin || '-'}</td><td>{m.destination || '-'}</td>
                <td>{m.responsible || '-'}</td><td>{formatDateTime(m.moved_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editable && (
        <>
          <div className="section-title" style={{ marginTop: 16 }}>Corrigir informações</div>
          <FieldGrid
            fields={MATERIAL_EDIT} values={form} onChange={setForm} idPrefix="mat-e"
            disabled={{ quantity: material.quantity_received > 0 }}
          />
          {material.quantity_received > 0 && (
            <p className="settings-note">A quantidade só pode ser corrigida antes do primeiro recebimento.</p>
          )}
        </>
      )}
      {error && <div className="form-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}
