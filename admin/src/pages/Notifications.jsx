import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';

// notification_webhooks admin surface. Operators
// configure per-warehouse Teams destinations that receive the
// backorder.* event family (opened / fulfillable / cancelled). The
// URL is Fernet-encrypted at rest and never returned in plaintext;
// the list shows a masked host preview. A "rotate URL" action lets
// operators swap the destination without round-tripping the
// secret back to the browser. "Test send" fires a sample
// backorder.opened adaptive card so the operator can verify the
// Teams channel renders before real events flow.
//
// The same surface also subscribes a channel to the webhook
// dispatcher's self-monitor (dispatcher.* alerts) -- a stuck
// delivery, dead-lettering, a subscription falling behind or
// auto-pausing. Those are NOT integration events; the dispatcher
// raises them and fans them out here so a delivery degradation pages
// the operator in minutes instead of going unnoticed.

const SUPPORTED_CHANNELS = [
  { value: 'teams', label: 'Microsoft Teams' },
];

// Grouped so the operator can tell business events apart from
// dispatcher ops alerts. Mirrors api/schemas/notification_webhooks.py
// ALLOWED_EVENT_TYPES; a value not in that backend allowlist is
// rejected at create/PATCH time.
const EVENT_TYPE_GROUPS = [
  {
    group: 'Eventos de pendência',
    options: [
      { value: 'backorder.opened',      label: 'backorder.opened',      desc: 'an item was shorted on an order' },
      { value: 'backorder.fulfillable', label: 'backorder.fulfillable', desc: 'a backorder is ready to ship' },
      { value: 'backorder.cancelled',   label: 'backorder.cancelled',   desc: 'a backorder was cancelled' },
    ],
  },
  {
    group: 'Alertas de saúde do dispatcher',
    options: [
      { value: 'dispatcher.delivery_stalled',     label: 'dispatcher.delivery_stalled',     desc: 'a webhook delivery is stuck in-flight' },
      { value: 'dispatcher.dlq_growth',           label: 'dispatcher.dlq_growth',           desc: 'events are dead-lettering' },
      { value: 'dispatcher.subscription_lagging', label: 'dispatcher.subscription_lagging', desc: 'a subscription is falling behind' },
      { value: 'dispatcher.subscription_paused',  label: 'dispatcher.subscription_paused',  desc: 'a subscription auto-paused' },
    ],
  },
];

const DEFAULT_EVENT_FILTER = ['backorder.opened', 'backorder.fulfillable'];


function EventFilterCheckboxes({ value, onChange, disabled = false }) {
  const set = new Set(value || []);
  const toggle = (optValue, checked) => {
    const next = new Set(set);
    if (checked) next.add(optValue); else next.delete(optValue);
    onChange([...next]);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {EVENT_TYPE_GROUPS.map((grp) => (
        <div key={grp.group} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>
            {grp.group}
          </div>
          {grp.options.map((opt) => (
            <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={set.has(opt.value)}
                disabled={disabled}
                onChange={(e) => toggle(opt.value, e.target.checked)}
              />
              <span className="mono">{opt.label}</span>
              {opt.desc && <span style={{ opacity: 0.55 }}>-- {opt.desc}</span>}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}


function TestSendOutcome({ outcome }) {
  if (!outcome) return null;
  const ok = outcome.delivered;
  return (
    <div
      role="status"
      style={{
        marginTop: 8,
        padding: '6px 10px',
        background: ok ? 'var(--success-bg, #e8f5e9)' : 'var(--danger-bg, #fdecea)',
        color: ok ? 'var(--success, #2e7d32)' : 'var(--danger, #c62828)',
        border: `1px solid ${ok ? 'var(--success, #2e7d32)' : 'var(--danger, #c62828)'}`,
        borderRadius: 4,
        fontSize: 12,
        whiteSpace: 'pre-wrap',
      }}
    >
      {ok
        ? `Entregue (status ${outcome.status_code || 200}).`
        : `Falha no envio: ${outcome.error_kind || 'unknown'}${outcome.status_code ? ` (status ${outcome.status_code})` : ''}${outcome.error_detail ? `\n${outcome.error_detail}` : ''}`}
    </div>
  );
}


export default function Notifications() {
  const { warehouseId } = useWarehouse();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [successBanner, setSuccessBanner] = useState('');

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    channel_kind: 'teams',
    url: '',
    event_filter: DEFAULT_EVENT_FILTER,
    enabled: true,
    secret: '',
  });
  const [createError, setCreateError] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [rotating, setRotating] = useState(null);
  const [rotateUrl, setRotateUrl] = useState('');
  const [rotateError, setRotateError] = useState('');
  const [rotateSubmitting, setRotateSubmitting] = useState(false);

  // Per-row test-send outcomes keyed by webhook_id so multiple
  // tests in flight do not blow away each other's status.
  const [testOutcomes, setTestOutcomes] = useState({});
  const [testInFlight, setTestInFlight] = useState({});

  const [deleting, setDeleting] = useState(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError('');
    const qs = new URLSearchParams();
    if (warehouseId) qs.set('warehouse_id', String(warehouseId));
    const res = await api.get(`/admin/notification-webhooks?${qs.toString()}`);
    if (res?.ok) {
      const data = await res.json();
      setRows(data.notification_webhooks || []);
    } else {
      setRows([]);
      setPageError('Falha ao carregar os webhooks de notificação.');
    }
    setLoading(false);
  }, [warehouseId]);

  useEffect(() => { load(); }, [load]);

  function flashSuccess(msg) {
    setSuccessBanner(msg);
    setTimeout(() => setSuccessBanner(''), 6000);
  }

  function openCreate() {
    setCreateForm({
      channel_kind: 'teams',
      url: '',
      event_filter: DEFAULT_EVENT_FILTER,
      enabled: true,
      secret: '',
    });
    setCreateError('');
    setCreating(true);
  }

  function closeCreate() {
    setCreating(false);
    setCreateError('');
    setCreateSubmitting(false);
  }

  async function submitCreate() {
    if (!warehouseId) {
      setCreateError('Escolha um armazém na barra superior primeiro.');
      return;
    }
    if (!createForm.url) {
      setCreateError('A URL é obrigatória.');
      return;
    }
    if (!createForm.event_filter || createForm.event_filter.length === 0) {
      setCreateError('Selecione pelo menos um tipo de evento.');
      return;
    }
    setCreateSubmitting(true);
    setCreateError('');
    const body = {
      warehouse_id: warehouseId,
      channel_kind: createForm.channel_kind,
      url: createForm.url,
      event_filter: createForm.event_filter,
      enabled: createForm.enabled,
    };
    if (createForm.secret) body.secret = createForm.secret;
    const res = await api.post('/admin/notification-webhooks', body);
    setCreateSubmitting(false);
    if (!res?.ok) {
      let data = null;
      try { data = await res?.json(); } catch (_) { /* non-JSON */ }
      setCreateError(data?.error || 'Falha ao criar webhook.');
      return;
    }
    closeCreate();
    flashSuccess('Webhook de notificação criado.');
    load();
  }

  async function togglEnabled(row) {
    const res = await api.patch(
      `/admin/notification-webhooks/${row.webhook_id}`,
      { enabled: !row.enabled },
    );
    if (!res?.ok) {
      let data = null;
      try { data = await res?.json(); } catch (_) { /* non-JSON */ }
      setPageError(data?.error || 'Falha ao alternar webhook.');
      return;
    }
    load();
  }

  function openRotate(row) {
    setRotating(row);
    setRotateUrl('');
    setRotateError('');
  }

  function closeRotate() {
    setRotating(null);
    setRotateUrl('');
    setRotateError('');
    setRotateSubmitting(false);
  }

  async function submitRotate() {
    if (!rotateUrl) {
      setRotateError('A nova URL é obrigatória.');
      return;
    }
    setRotateSubmitting(true);
    setRotateError('');
    const res = await api.post(
      `/admin/notification-webhooks/${rotating.webhook_id}/rotate-url`,
      { url: rotateUrl },
    );
    setRotateSubmitting(false);
    if (!res?.ok) {
      let data = null;
      try { data = await res?.json(); } catch (_) { /* non-JSON */ }
      setRotateError(data?.error || 'Falha ao trocar a URL.');
      return;
    }
    closeRotate();
    flashSuccess('URL do webhook trocada.');
    load();
  }

  async function testSend(row) {
    setTestInFlight((prev) => ({ ...prev, [row.webhook_id]: true }));
    setTestOutcomes((prev) => ({ ...prev, [row.webhook_id]: null }));
    const res = await api.post(
      `/admin/notification-webhooks/${row.webhook_id}/test-send`,
      {},
    );
    let outcome = null;
    try { outcome = await res?.json(); } catch (_) { /* non-JSON */ }
    setTestInFlight((prev) => ({ ...prev, [row.webhook_id]: false }));
    if (!res?.ok) {
      setTestOutcomes((prev) => ({
        ...prev,
        [row.webhook_id]: {
          delivered: false,
          error_kind: 'request_failed',
          error_detail: outcome?.error || 'falha na requisição',
        },
      }));
      return;
    }
    setTestOutcomes((prev) => ({ ...prev, [row.webhook_id]: outcome }));
  }

  function openDelete(row) {
    setDeleting(row);
  }

  function closeDelete() {
    setDeleting(null);
    setDeleteSubmitting(false);
  }

  async function submitDelete() {
    setDeleteSubmitting(true);
    const res = await api.delete(
      `/admin/notification-webhooks/${deleting.webhook_id}`,
    );
    setDeleteSubmitting(false);
    if (!res?.ok) {
      setPageError('Falha ao excluir webhook.');
      closeDelete();
      return;
    }
    closeDelete();
    flashSuccess('Webhook excluído.');
    load();
  }

  const columns = [
    { key: 'webhook_id', label: 'ID', mono: true },
    { key: 'channel_kind', label: 'Canal' },
    { key: 'host_preview', label: 'Host',
      render: (r) => r.host_preview
        ? <span className="mono" style={{ fontSize: 12 }}>{r.host_preview}</span>
        : <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>(falha ao descriptografar)</span>,
    },
    { key: 'event_filter', label: 'Eventos',
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {(r.event_filter || []).map((e) => (
            <span key={e} className="mono" style={{ fontSize: 11 }}>{e}</span>
          ))}
        </div>
      ),
    },
    { key: 'enabled', label: 'Ativado',
      render: (r) => (
        <label style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => { e.stopPropagation(); togglEnabled(r); }}
          />
          <span style={{ fontSize: 12 }}>{r.enabled ? 'Ligado' : 'Desligado'}</span>
        </label>
      ),
    },
    { key: 'created_at', label: 'Criado',
      render: (r) => r.created_at ? new Date(r.created_at).toLocaleString() : '-',
    },
    { key: 'actions', label: 'Ações',
      render: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm"
              onClick={() => testSend(r)}
              disabled={!!testInFlight[r.webhook_id]}
              title="Enviar um cartão de exemplo backorder.opened para verificar o canal"
            >
              {testInFlight[r.webhook_id] ? 'Enviando...' : 'Testar'}
            </button>
            <button className="btn btn-sm" onClick={() => openRotate(r)}>
              Trocar URL
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => openDelete(r)}>
              Excluir
            </button>
          </div>
          <TestSendOutcome outcome={testOutcomes[r.webhook_id]} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Notificações">
        <button
          className="btn btn-primary"
          onClick={openCreate}
          disabled={!warehouseId}
        >
          Novo webhook
        </button>
      </PageHeader>
      {!warehouseId && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Escolha um armazém na barra superior para gerenciar seus webhooks de notificação.
        </p>
      )}
      {successBanner && (
        <div
          role="status"
          style={{
            margin: '0 0 12px 0',
            padding: '8px 12px',
            background: 'var(--success-bg, #e8f5e9)',
            color: 'var(--success, #2e7d32)',
            border: '1px solid var(--success, #2e7d32)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {successBanner}
        </div>
      )}
      {pageError && (
        <div className="form-error" style={{ marginBottom: 12 }}>{pageError}</div>
      )}
      <div className="section">
        <DataTable
          rowKey="webhook_id"
          columns={columns}
          data={rows}
          loading={loading}
          emptyMessage="Nenhum webhook de notificação configurado para este armazém."
        />
      </div>

      {creating && (
        <Modal
          title="Novo webhook de notificação"
          onClose={closeCreate}
          footer={
            <>
              <button className="btn" onClick={closeCreate} disabled={createSubmitting}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={submitCreate}
                disabled={createSubmitting}
              >
                {createSubmitting ? 'Criando...' : 'Criar'}
              </button>
            </>
          }
        >
          {createError && (
            <div className="form-error" style={{ marginBottom: 12 }}>{createError}</div>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            A URL é criptografada e nunca é retornada pela API. O valor digitado aqui é a única chance de vê-lo -- guarde-o em outro lugar se precisar de cópia. "Trocar URL" depois substitui o valor criptografado, mas não expõe o anterior.
          </p>
          <div className="form-row">
            <div className="form-group">
              <label>Canal</label>
              <select
                className="form-select"
                value={createForm.channel_kind}
                onChange={(e) => setCreateForm({ ...createForm, channel_kind: e.target.value })}
              >
                {SUPPORTED_CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Ativado</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8 }}>
                <input
                  type="checkbox"
                  checked={createForm.enabled}
                  onChange={(e) => setCreateForm({ ...createForm, enabled: e.target.checked })}
                />
                <span style={{ fontSize: 13 }}>Receber eventos imediatamente</span>
              </label>
            </div>
          </div>
          <div className="form-group">
            <label>URL</label>
            <input
              className="form-input"
              type="url"
              placeholder="https://outlook.office.com/webhook/..."
              value={createForm.url}
              onChange={(e) => setCreateForm({ ...createForm, url: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Eventos</label>
            <EventFilterCheckboxes
              value={createForm.event_filter}
              onChange={(v) => setCreateForm({ ...createForm, event_filter: v })}
            />
          </div>
          <div className="form-group">
            <label>Segredo HMAC (opcional)</label>
            <input
              className="form-input"
              type="text"
              placeholder="Deixe em branco para webhooks de entrada do Teams."
              value={createForm.secret}
              onChange={(e) => setCreateForm({ ...createForm, secret: e.target.value })}
            />
          </div>
        </Modal>
      )}

      {rotating && (
        <Modal
          title={`Trocar URL do webhook nº${rotating.webhook_id}`}
          onClose={closeRotate}
          footer={
            <>
              <button className="btn" onClick={closeRotate} disabled={rotateSubmitting}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={submitRotate}
                disabled={rotateSubmitting}
              >
                {rotateSubmitting ? 'Trocando...' : 'Trocar'}
              </button>
            </>
          }
        >
          {rotateError && (
            <div className="form-error" style={{ marginBottom: 12 }}>{rotateError}</div>
          )}
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Substitui a URL criptografada deste registro. O valor anterior não pode ser recuperado pela interface; se precisar dele, obtenha-o com o administrador do Teams antes de trocar.
          </p>
          <div className="form-group">
            <label>Nova URL</label>
            <input
              className="form-input"
              type="url"
              value={rotateUrl}
              onChange={(e) => setRotateUrl(e.target.value)}
              placeholder="https://outlook.office.com/webhook/..."
            />
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal
          title={`Excluir webhook nº${deleting.webhook_id}?`}
          onClose={closeDelete}
          footer={
            <>
              <button className="btn" onClick={closeDelete} disabled={deleteSubmitting}>Cancelar</button>
              <button
                className="btn btn-danger"
                onClick={submitDelete}
                disabled={deleteSubmitting}
              >
                {deleteSubmitting ? 'Excluindo...' : 'Excluir'}
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13 }}>
            Os eventos de pendência deste armazém não chegarão mais a este destino. A fila integration_events não é afetada; um worker futuro poderia reenviá-los se você recriar o registro.
          </p>
        </Modal>
      )}
    </div>
  );
}
