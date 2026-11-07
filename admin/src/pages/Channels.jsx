import { useState, useEffect } from 'react';
import { api } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';

// Pipe C availability channels. Mirrors the Webhooks page: a list with
// per-channel publish stats, a create / edit modal, pause-resume, soft-delete,
// and a DLQ viewer for parked rows.

const STATUS_BADGE = {
  active: { label: 'active', color: 'var(--text-secondary)' },
  paused: { label: 'paused', color: '#c49100' },
  revoked: { label: 'revoked', color: 'var(--danger)' },
};

function Badge({ label, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 10,
      fontSize: 11, fontWeight: 600, color: '#fff', background: color,
    }}>{label}</span>
  );
}

const TRANSFORM_PLACEHOLDER =
  '{\n  "rename": { "sku": "seller_sku" },\n  "constants": { "fulfillment_channel": "AMAZON_NA" }\n}';

const splitCsv = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const splitCsvInts = (s) => splitCsv(s).map(Number).filter((n) => Number.isInteger(n));

function buildScope(f) {
  const scope = {};
  const skus = splitCsv(f.skus);
  const cats = splitCsv(f.categories);
  const whs = splitCsvInts(f.warehouse_ids);
  if (skus.length) scope.skus = skus;
  if (cats.length) scope.categories = cats;
  if (whs.length) scope.warehouse_ids = whs;
  return scope;
}

function emptyForm() {
  return {
    channel_id: '', display_name: '', delivery_url: '',
    skus: '', categories: '', warehouse_ids: '',
    transform: '',
    rate_limit_per_second: '10', batch_size: '100', debounce_seconds: '30',
  };
}

function rowToForm(row) {
  const scope = row.sku_scope || {};
  return {
    channel_id: row.channel_id,
    display_name: row.display_name,
    delivery_url: row.delivery_url,
    skus: (scope.skus || []).join(', '),
    categories: (scope.categories || []).join(', '),
    warehouse_ids: (scope.warehouse_ids || []).join(', '),
    transform: row.transform && Object.keys(row.transform).length
      ? JSON.stringify(row.transform, null, 2) : '',
    rate_limit_per_second: String(row.rate_limit_per_second),
    batch_size: String(row.batch_size),
    debounce_seconds: String(row.debounce_seconds),
  };
}

// Build the request body shared by create + edit. Returns [body, error].
function formToBody(f) {
  let transform = {};
  if (f.transform.trim()) {
    try { transform = JSON.parse(f.transform); }
    catch { return [null, 'A transformação deve ser um JSON válido.']; }
  }
  return [{
    display_name: f.display_name.trim(),
    delivery_url: f.delivery_url.trim(),
    sku_scope: buildScope(f),
    transform,
    rate_limit_per_second: Number(f.rate_limit_per_second),
    batch_size: Number(f.batch_size),
    debounce_seconds: Number(f.debounce_seconds),
  }, null];
}

function ChannelForm({ form, setForm, isEdit }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      {!isEdit && (
        <div className="form-group">
          <label>ID do canal</label>
          <input className="form-input mono" value={form.channel_id}
                 onChange={set('channel_id')} placeholder="amazon-fba" />
        </div>
      )}
      <div className="form-group">
        <label>Nome de exibição</label>
        <input className="form-input" value={form.display_name}
               onChange={set('display_name')} placeholder="Amazon FBA" />
      </div>
      <div className="form-group">
        <label>URL de entrega (destino)</label>
        <input className="form-input mono" value={form.delivery_url}
               onChange={set('delivery_url')} placeholder="https://sink.example.com/availability" />
      </div>
      <div className="form-group">
        <label>Escopo de SKU – skus (separados por vírgula, vazio = todos)</label>
        <input className="form-input" value={form.skus} onChange={set('skus')}
               placeholder="TST-001, TST-002" />
      </div>
      <div className="form-group">
        <label>Escopo de SKU – categorias</label>
        <input className="form-input" value={form.categories}
               onChange={set('categories')} placeholder="reels, waders" />
      </div>
      <div className="form-group">
        <label>Escopo de SKU – IDs de armazém (vazio = todos)</label>
        <input className="form-input" value={form.warehouse_ids}
               onChange={set('warehouse_ids')} placeholder="1, 2" />
      </div>
      <div className="form-group">
        <label>Transformação (JSON: renomear + constantes, vazio = nenhuma)</label>
        <textarea className="form-input mono" rows={5} value={form.transform}
                  onChange={set('transform')} placeholder={TRANSFORM_PLACEHOLDER} />
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Taxa (por seg)</label>
          <input className="form-input" type="number" value={form.rate_limit_per_second}
                 onChange={set('rate_limit_per_second')} />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Tamanho do lote</label>
          <input className="form-input" type="number" value={form.batch_size}
                 onChange={set('batch_size')} />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Debounce (seg)</label>
          <input className="form-input" type="number" value={form.debounce_seconds}
                 onChange={set('debounce_seconds')} />
        </div>
      </div>
    </>
  );
}

export default function Channels() {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [createError, setCreateError] = useState('');

  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState(emptyForm());
  const [editError, setEditError] = useState('');

  const [confirmDelete, setConfirmDelete] = useState(null);
  const [dlqChannel, setDlqChannel] = useState(null);
  const [dlqRows, setDlqRows] = useState([]);

  async function load() {
    setLoading(true);
    setPageError('');
    const res = await api.get('/admin/channels');
    if (res?.ok) {
      const data = await res.json();
      setChannels(data.channels || []);
    } else {
      setPageError('Não foi possível carregar os canais.');
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function submitCreate() {
    setCreateError('');
    const [body, err] = formToBody(form);
    if (err) { setCreateError(err); return; }
    body.channel_id = form.channel_id.trim();
    const res = await api.post('/admin/channels', body);
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setShowCreate(false); setForm(emptyForm()); load(); }
    else { setCreateError(data.detail || data.error || 'Falha ao criar.'); }
  }

  async function submitEdit() {
    setEditError('');
    const [body, err] = formToBody(editForm);
    if (err) { setEditError(err); return; }
    const res = await api.patch(`/admin/channels/${editing.channel_id}`, body);
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setEditing(null); load(); }
    else { setEditError(data.detail || data.error || 'Falha ao atualizar.'); }
  }

  async function setStatus(channel, status) {
    await api.patch(`/admin/channels/${channel.channel_id}`, { status });
    load();
  }

  async function doDelete() {
    await api.delete(`/admin/channels/${confirmDelete.channel_id}`);
    setConfirmDelete(null);
    load();
  }

  async function openDlq(channel) {
    setDlqChannel(channel);
    setDlqRows([]);
    const res = await api.get(`/admin/channels/${channel.channel_id}/dlq`);
    if (res?.ok) {
      const data = await res.json();
      setDlqRows(data.parked || []);
    }
  }

  const columns = [
    { key: 'channel_id', label: 'Canal', mono: true },
    { key: 'display_name', label: 'Nome' },
    {
      key: 'status', label: 'Status',
      render: (r) => {
        const b = STATUS_BADGE[r.status] || STATUS_BADGE.active;
        return <Badge label={b.label} color={b.color} />;
      },
    },
    { key: 'item_count', label: 'Materiais' },
    { key: 'dirty_count', label: 'Pendente' },
    {
      key: 'dlq_count', label: 'DLQ',
      render: (r) => (
        <span style={{ color: r.dlq_count ? 'var(--danger)' : 'inherit' }}>
          {r.dlq_count}
        </span>
      ),
    },
    {
      key: 'last_published_at', label: 'Última publicação',
      render: (r) => (r.last_published_at
        ? new Date(r.last_published_at).toLocaleString() : '—'),
    },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => {
            setEditing(r); setEditForm(rowToForm(r)); setEditError('');
          }}>Editar</button>
          {r.status === 'active' ? (
            <button className="btn btn-sm" onClick={() => setStatus(r, 'paused')}>Pausar</button>
          ) : (
            <button className="btn btn-sm" onClick={() => setStatus(r, 'active')}>Retomar</button>
          )}
          <button className="btn btn-sm" onClick={() => openDlq(r)}>DLQ</button>
          <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(r)}>
            Excluir
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Canais">
        <button className="btn btn-primary" onClick={() => {
          setForm(emptyForm()); setCreateError(''); setShowCreate(true);
        }}>Novo canal</button>
      </PageHeader>

      {pageError && <div className="form-error">{pageError}</div>}

      {loading ? (
        <p style={{ color: 'var(--text-secondary)' }}>Carregando…</p>
      ) : (
        <DataTable rowKey="channel_id" columns={columns} data={channels}
                   emptyMessage="Nenhum canal configurado ainda." />
      )}

      {showCreate && (
        <Modal title="Novo canal" onClose={() => setShowCreate(false)} footer={
          <>
            <button className="btn" onClick={() => setShowCreate(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={submitCreate}>Criar</button>
          </>
        }>
          {createError && <div className="form-error">{createError}</div>}
          <ChannelForm form={form} setForm={setForm} isEdit={false} />
        </Modal>
      )}

      {editing && (
        <Modal title={`Editar ${editing.channel_id}`} onClose={() => setEditing(null)} footer={
          <>
            <button className="btn" onClick={() => setEditing(null)}>Cancelar</button>
            <button className="btn btn-primary" onClick={submitEdit}>Salvar</button>
          </>
        }>
          {editError && <div className="form-error">{editError}</div>}
          <ChannelForm form={editForm} setForm={setEditForm} isEdit />
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Revogar canal" onClose={() => setConfirmDelete(null)} footer={
          <>
            <button className="btn" onClick={() => setConfirmDelete(null)}>Cancelar</button>
            <button className="btn btn-danger" onClick={doDelete}>Revogar</button>
          </>
        }>
          <p>
            Revogar <span className="mono">{confirmDelete.channel_id}</span>? O publicador para de enviar para ele; a configuração é mantida para registro.
          </p>
        </Modal>
      )}

      {dlqChannel && (
        <Modal title={`DLQ — ${dlqChannel.channel_id}`}
               onClose={() => setDlqChannel(null)} size="large">
          {dlqRows.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>Nenhuma linha retida.</p>
          ) : (
            <DataTable
              rowKey="item_id"
              columns={[
                { key: 'sku', label: 'SKU', mono: true },
                { key: 'available_qty', label: 'Disponível' },
                { key: 'attempt_count', label: 'Tentativas' },
                { key: 'last_error', label: 'Último erro' },
              ]}
              data={dlqRows}
              emptyMessage="Nenhuma linha retida."
            />
          )}
        </Modal>
      )}
    </div>
  );
}
