import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { catalogEntry } from '../utils/errorCatalog.js';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';

const STATUS_BADGE = {
  active: { label: 'active', color: 'var(--text-secondary)' },
  paused: { label: 'paused', color: '#c49100' },
  revoked: { label: 'revoked', color: 'var(--danger)' },
};

function Badge({ label, color }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 8px',
      borderRadius: 10,
      fontSize: 11,
      fontWeight: 600,
      color: '#fff',
      background: color,
    }}>
      {label}
    </span>
  );
}

// Mirrors the Tokens.jsx (#159) checkbox picker: the admin clicks
// boxes against the authoritative scope-catalog instead of typing
// slugs from memory. Inlined here rather than extracted because the
// renderLabel / keyOf shape is just different enough that a shared
// component would need three configuration props for each call site.
function ScopeCheckboxList({ options, value, onChange, renderLabel, keyOf }) {
  const selected = new Set(value);
  const allKeys = options.map(keyOf);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const selectAll = () => onChange(allKeys);
  const selectNone = () => onChange([]);
  const toggle = (k) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange(allKeys.filter((x) => next.has(x)));
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <button type="button" className="btn btn-sm" onClick={selectAll} disabled={allSelected}>
          Todos
        </button>
        <button type="button" className="btn btn-sm" onClick={selectNone} disabled={selected.size === 0}>
          Nenhum
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', alignSelf: 'center' }}>
          {selected.size} / {allKeys.length} selecionado(s)
        </span>
      </div>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: 8,
          maxHeight: 160,
          overflowY: 'auto',
        }}
      >
        {options.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Nenhuma opção disponível.</span>
        ) : (
          options.map((opt) => {
            const k = keyOf(opt);
            return (
              <label
                key={k}
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '2px 0' }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(k)}
                  onChange={() => toggle(k)}
                />
                {renderLabel(opt)}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange, hint }) {
  return (
    <div className="form-group">
      <label style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span className="mono" style={{ fontSize: 12 }}>{value}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
      {hint && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

const DLQ_LIMIT_OPTIONS = [25, 50, 100, 250];

const REPLAY_STATUS_OPTIONS = ['dlq', 'failed', 'succeeded'];

const EMPTY_REPLAY_FILTER = {
  status: 'dlq',
  event_type: '',
  warehouse_id: '',
  completed_at_from: '',
  completed_at_to: '',
};

function DlqPanel({ subscription, onClose }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [panelError, setPanelError] = useState('');
  const [showReplayBatch, setShowReplayBatch] = useState(false);
  const [replayFilter, setReplayFilter] = useState(EMPTY_REPLAY_FILTER);
  const [replayResult, setReplayResult] = useState(null);
  const [replayError, setReplayError] = useState(null);

  useEffect(() => { load(); }, [limit, offset]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    setPanelError('');
    const res = await api.get(
      `/admin/webhooks/${subscription.subscription_id}/dlq?limit=${limit}&offset=${offset}`,
    );
    if (res?.ok) {
      const data = await res.json();
      setRows(data.deliveries || []);
      setTotal(data.total || 0);
    } else {
      const body = await res?.json();
      setPanelError(body?.error || 'Falha ao carregar a DLQ');
    }
    setLoading(false);
  }

  async function replaySingle(deliveryId) {
    const res = await api.post(
      `/admin/webhooks/${subscription.subscription_id}/replay/${deliveryId}`,
      {},
    );
    const body = await res?.json();
    if (res?.ok) {
      load();
      return;
    }
    setPanelError(body?.detail || body?.error || 'Falha ao reenviar a entrega');
  }

  function buildReplayPayload(acknowledge) {
    const filter = { status: replayFilter.status };
    if (replayFilter.event_type.trim()) filter.event_type = replayFilter.event_type.trim();
    if (replayFilter.warehouse_id !== '' && replayFilter.warehouse_id !== null) {
      const wid = Number(replayFilter.warehouse_id);
      if (Number.isInteger(wid) && wid > 0) filter.warehouse_id = wid;
    }
    if (replayFilter.completed_at_from) {
      filter.completed_at_from = new Date(replayFilter.completed_at_from).toISOString();
    }
    if (replayFilter.completed_at_to) {
      filter.completed_at_to = new Date(replayFilter.completed_at_to).toISOString();
    }
    return { filter, acknowledge_large_replay: !!acknowledge };
  }

  async function submitReplayBatch(acknowledge = false) {
    setReplayError(null);
    setReplayResult(null);
    const res = await api.post(
      `/admin/webhooks/${subscription.subscription_id}/replay-batch`,
      buildReplayPayload(acknowledge),
    );
    const body = await res?.json();
    if (res?.ok) {
      setReplayResult({
        replayed_count: body.replayed_count ?? 0,
        impact_count: body.impact_count ?? 0,
      });
      load();
      return;
    }
    if (res?.status === 409 && body?.error === 'batch_size_above_hard_cap') {
      setReplayError({
        kind: 'hard_cap',
        impact_count: body.impact_count,
        hard_cap: body.hard_cap,
        detail: body.detail,
      });
      return;
    }
    if (res?.status === 429 && body?.error === 'replay_batch_throttled') {
      setReplayError({
        kind: 'throttled',
        seconds_until_retry: body.seconds_until_retry,
      });
      return;
    }
    setReplayError({ kind: 'other', detail: body?.detail || body?.error || 'Falha ao reenviar o lote' });
  }

  function closeReplayBatch() {
    setShowReplayBatch(false);
    setReplayFilter(EMPTY_REPLAY_FILTER);
    setReplayResult(null);
    setReplayError(null);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + limit, total);

  const dlqColumns = [
    { key: 'delivery_id', label: 'Entrega', render: (r) => <span className="mono">{r.delivery_id}</span> },
    { key: 'event_id', label: 'Evento', render: (r) => <span className="mono">{r.event_id ?? '-'}</span> },
    { key: 'event_type', label: 'Tipo', render: (r) => <span className="mono" style={{ fontSize: 12 }}>{r.event?.event_type || '-'}</span> },
    { key: 'attempt_number', label: 'Tentativa', render: (r) => r.attempt_number },
    { key: 'http_status', label: 'HTTP', render: (r) => r.http_status ?? '-' },
    { key: 'error_kind', label: 'Erro', render: (r) => <span className="mono" style={{ fontSize: 12 }}>{r.error_kind || '-'}</span> },
    {
      key: 'error_detail',
      label: 'Detalhe',
      render: (r) => {
        // Both columns now read from the server-owned catalog. The
        // hover tooltip enriches with the longer description from the
        // client-side mirror so the operator can hover for context
        // without opening the cross-subscription errors panel.
        const entry = catalogEntry(r.error_kind);
        const display = r.error_detail || entry.short_message;
        return (
          <span
            style={{ fontSize: 12, display: 'inline-block', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}
            title={entry.description}
          >
            {display}
          </span>
        );
      },
    },
    {
      key: 'completed_at',
      label: 'Concluído',
      render: (r) => r.completed_at ? new Date(r.completed_at).toLocaleString() : '-',
    },
    { key: 'gen', label: 'Ger.', render: (r) => r.secret_generation },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <button className="btn btn-sm" onClick={() => replaySingle(r.delivery_id)} title="Reenviar">
          Reenviar
        </button>
      ),
    },
  ];

  return (
    <Modal
      title={`DLQ - ${subscription.display_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Fechar</button>
        </>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13 }}>
          {loading ? 'Carregando…' : (total === 0 ? 'Nenhum registro na DLQ' : `${pageStart}-${pageEnd} de ${total}`)}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Tamanho da página</label>
          <select
            className="form-input"
            style={{ width: 80, padding: '2px 6px' }}
            value={limit}
            onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }}
          >
            {DLQ_LIMIT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button
            className="btn btn-sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Anterior
          </button>
          <button
            className="btn btn-sm"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Próxima
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowReplayBatch(true)}
            disabled={subscription.status === 'revoked'}
            title={subscription.status === 'revoked' ? 'A assinatura está revogada' : 'Reenviar lote'}
          >
            Reenviar lote
          </button>
        </div>
      </div>

      {panelError && <div className="form-error" style={{ marginBottom: 12 }}>{panelError}</div>}

      <DataTable
        rowKey="delivery_id"
        columns={dlqColumns}
        data={rows}
        emptyMessage={loading ? 'Carregando…' : 'Nenhum registro na DLQ para esta assinatura'}
      />

      {showReplayBatch && (
        <Modal
          title="Reenviar lote"
          onClose={closeReplayBatch}
          footer={
            <>
              <button className="btn" onClick={closeReplayBatch}>Fechar</button>
              {replayError?.kind === 'hard_cap' ? (
                <button
                  className="btn btn-primary"
                  style={{ background: 'var(--copper)' }}
                  onClick={() => submitReplayBatch(true)}
                >
                  Confirmar e reenviar {replayError.impact_count}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => submitReplayBatch(false)}
                  disabled={replayResult !== null}
                >
                  Reenviar entregas correspondentes
                </button>
              )}
            </>
          }
        >
          <div className="form-group">
            <label>Status</label>
            <select
              className="form-input"
              value={replayFilter.status}
              onChange={(e) => setReplayFilter({ ...replayFilter, status: e.target.value })}
            >
              {REPLAY_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              Origem que o lote lê. Padrão: dlq.
            </div>
          </div>

          <div className="form-group">
            <label>Tipo de evento (opcional)</label>
            <input
              className="form-input"
              value={replayFilter.event_type}
              onChange={(e) => setReplayFilter({ ...replayFilter, event_type: e.target.value })}
              placeholder="ship.confirmed"
            />
          </div>

          <div className="form-group">
            <label>ID do armazém (opcional)</label>
            <input
              className="form-input"
              type="number"
              min="1"
              value={replayFilter.warehouse_id}
              onChange={(e) => setReplayFilter({ ...replayFilter, warehouse_id: e.target.value })}
            />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Concluído de (opcional)</label>
              <input
                className="form-input"
                type="datetime-local"
                value={replayFilter.completed_at_from}
                onChange={(e) => setReplayFilter({ ...replayFilter, completed_at_from: e.target.value })}
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Concluído até (opcional)</label>
              <input
                className="form-input"
                type="datetime-local"
                value={replayFilter.completed_at_to}
                onChange={(e) => setReplayFilter({ ...replayFilter, completed_at_to: e.target.value })}
              />
            </div>
          </div>

          {replayError?.kind === 'hard_cap' && (
            <div className="form-error" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600 }}>
                Correspondentes {replayError.impact_count} entregas, acima do {replayError.hard_cap} limite máximo.
              </div>
              <div style={{ marginTop: 4, fontSize: 12 }}>{replayError.detail}</div>
            </div>
          )}
          {replayError?.kind === 'throttled' && (
            <div className="form-error" style={{ marginTop: 12 }}>
              Limite atingido. Tente novamente em {replayError.seconds_until_retry}s.
            </div>
          )}
          {replayError?.kind === 'other' && (
            <div className="form-error" style={{ marginTop: 12 }}>
              {replayError.detail}
            </div>
          )}
          {replayResult && (
            <div style={{ marginTop: 12, padding: 12, background: 'var(--surface-muted)', borderRadius: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                Reenviados {replayResult.replayed_count} entrega{replayResult.replayed_count === 1 ? 'y' : 'ies'}.
              </div>
              {replayResult.impact_count !== replayResult.replayed_count && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Impacto calculado pelo servidor: {replayResult.impact_count}.
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </Modal>
  );
}

const STATS_WINDOW_OPTIONS = ['1h', '6h', '24h', '7d'];

function formatMs(v) {
  if (v === null || v === undefined) return '-';
  return `${Math.round(v)} ms`;
}

function WebhookErrorsPanel({ webhooks, onClose }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [errorKinds, setErrorKinds] = useState([]);
  const [limit] = useState(50);
  const [offset, setErrorsOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [panelError, setPanelError] = useState('');
  const [filterSubscription, setFilterSubscription] = useState('');
  const [filterErrorKind, setFilterErrorKind] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setPanelError('');
      const qp = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (filterSubscription) qp.set('subscription_id', filterSubscription);
      if (filterErrorKind) qp.set('error_kind', filterErrorKind);
      if (filterFrom) qp.set('from', new Date(filterFrom).toISOString());
      if (filterTo) qp.set('to', new Date(filterTo).toISOString());
      const res = await api.get(`/admin/webhook-errors?${qp}`);
      if (cancelled) return;
      if (res?.ok) {
        const data = await res.json();
        setRows(data.deliveries || []);
        setTotal(data.total || 0);
        setErrorKinds(data.error_kinds || []);
      } else {
        const body = await res?.json();
        setPanelError(body?.error || 'Falha ao carregar os erros');
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [limit, offset, filterSubscription, filterErrorKind, filterFrom, filterTo]);

  function clearFilters() {
    setFilterSubscription('');
    setFilterErrorKind('');
    setFilterFrom('');
    setFilterTo('');
    setErrorsOffset(0);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + limit, total);

  return (
    <Modal
      title="Erros de webhook"
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Fechar</button>}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <select
          className="form-input"
          style={{ width: 200 }}
          value={filterSubscription}
          onChange={(e) => { setFilterSubscription(e.target.value); setErrorsOffset(0); }}
        >
          <option value="">Todas as assinaturas</option>
          {webhooks.map((w) => (
            <option key={w.subscription_id} value={w.subscription_id}>
              {w.display_name}
            </option>
          ))}
        </select>
        <select
          className="form-input"
          style={{ width: 160 }}
          value={filterErrorKind}
          onChange={(e) => { setFilterErrorKind(e.target.value); setErrorsOffset(0); }}
        >
          <option value="">Todos os tipos de erro</option>
          {errorKinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          type="datetime-local"
          className="form-input"
          style={{ width: 200 }}
          value={filterFrom}
          onChange={(e) => { setFilterFrom(e.target.value); setErrorsOffset(0); }}
          placeholder="De"
        />
        <input
          type="datetime-local"
          className="form-input"
          style={{ width: 200 }}
          value={filterTo}
          onChange={(e) => { setFilterTo(e.target.value); setErrorsOffset(0); }}
          placeholder="Até"
        />
        <button className="btn btn-sm" onClick={clearFilters}>Limpar</button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 13 }}>
          {loading ? 'Carregando…' : (total === 0 ? 'Nenhum erro encontrado' : `${pageStart}-${pageEnd} de ${total}`)}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-sm"
            disabled={offset === 0}
            onClick={() => setErrorsOffset(Math.max(0, offset - limit))}
          >
            Anterior
          </button>
          <button
            className="btn btn-sm"
            disabled={offset + limit >= total}
            onClick={() => setErrorsOffset(offset + limit)}
          >
            Próxima
          </button>
        </div>
      </div>

      {panelError && <div className="form-error" style={{ marginBottom: 12 }}>{panelError}</div>}

      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
            <th style={{ padding: 6 }}></th>
            <th style={{ padding: 6 }}>Assinatura</th>
            <th style={{ padding: 6 }}>Entrega</th>
            <th style={{ padding: 6 }}>Tipo</th>
            <th style={{ padding: 6 }}>HTTP</th>
            <th style={{ padding: 6 }}>Concluído</th>
            <th style={{ padding: 6 }}>Mensagem curta</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan="7" style={{ padding: 12, color: 'var(--text-secondary)' }}>
                Nenhum registro de erro correspondente.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const isExpanded = expandedId === r.delivery_id;
            return (
              <>
                <tr
                  key={r.delivery_id}
                  style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => setExpandedId(isExpanded ? null : r.delivery_id)}
                >
                  <td style={{ padding: 6 }}>{isExpanded ? '▼' : '▶'}</td>
                  <td style={{ padding: 6 }}>{r.subscription_display_name}</td>
                  <td style={{ padding: 6 }} className="mono">{r.delivery_id}</td>
                  <td style={{ padding: 6 }} className="mono">{r.error_kind}</td>
                  <td style={{ padding: 6 }} className="mono">{r.http_status ?? '-'}</td>
                  <td style={{ padding: 6 }}>{r.completed_at ? new Date(r.completed_at).toLocaleString() : '-'}</td>
                  <td style={{ padding: 6 }}>{r.short_message}</td>
                </tr>
                {isExpanded && (
                  <tr key={`${r.delivery_id}-detail`} style={{ background: 'var(--surface-muted)' }}>
                    <td colSpan="7" style={{ padding: 12 }}>
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                          O que aconteceu
                        </div>
                        <div style={{ fontSize: 13, marginTop: 2 }}>{r.description}</div>
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                          Dica de diagnóstico
                        </div>
                        <div style={{ fontSize: 13, marginTop: 2 }}>{r.triage_hint}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 24, fontSize: 12, color: 'var(--text-secondary)' }}>
                        <span>Conector: <span className="mono">{r.connector_id}</span></span>
                        <span>Evento: <span className="mono">{r.event_id ?? '-'}</span></span>
                        <span>Tentativa: {r.attempt_number}</span>
                        <span>Status: {r.status}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}

function StatsPanel({ subscription, onClose }) {
  const [window, setStatsWindow] = useState('24h');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [panelError, setPanelError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setPanelError('');
      const res = await api.get(
        `/admin/webhooks/${subscription.subscription_id}/stats?window=${window}`,
      );
      if (cancelled) return;
      if (res?.ok) {
        setStats(await res.json());
      } else {
        const body = await res?.json();
        setPanelError(body?.error || 'Falha ao carregar as estatísticas');
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [subscription.subscription_id, window]);

  const counters = [
    { label: 'Tentativas', key: 'attempts_total' },
    { label: 'Sucesso', key: 'succeeded' },
    { label: 'Falhou', key: 'failed' },
    { label: 'DLQ', key: 'dlq' },
    { label: 'Em andamento', key: 'in_flight' },
    { label: 'Pendente', key: 'pending' },
  ];

  return (
    <Modal
      title={`Estatísticas - ${subscription.display_name}`}
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Fechar</button>}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          O servidor mantém cache por 30s; troque o período para forçar nova leitura.
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {STATS_WINDOW_OPTIONS.map((w) => (
            <button
              key={w}
              className={`btn btn-sm${w === window ? ' btn-primary' : ''}`}
              onClick={() => setStatsWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {panelError && <div className="form-error" style={{ marginBottom: 12 }}>{panelError}</div>}

      {loading && !stats && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Carregando…</div>
      )}

      {stats && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            {counters.map((c) => (
              <div
                key={c.key}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: 12,
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  {c.label}
                </div>
                <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>
                  {stats[c.key] ?? 0}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Taxa de sucesso
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>
                {formatRate(stats.success_rate)}
              </div>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Atraso atual (eventos)
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>
                {stats.current_lag ?? 0}
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 12, marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>
              Tempo de resposta (somente sucessos)
            </div>
            <div style={{ display: 'flex', gap: 24 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>p50</div>
                <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                  {formatMs(stats.response_time_ms?.p50)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>p95</div>
                <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                  {formatMs(stats.response_time_ms?.p95)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>p99</div>
                <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                  {formatMs(stats.response_time_ms?.p99)}
                </div>
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 12, marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>
              Principais tipos de erro
            </div>
            {(stats.top_error_kinds || []).length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Nenhum erro no período.</div>
            ) : (
              <table style={{ width: '100%', fontSize: 13 }}>
                <tbody>
                  {stats.top_error_kinds.map((e) => (
                    <tr key={e.kind}>
                      <td className="mono">{e.kind}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{e.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Período {stats.window}. Gerado em {new Date(stats.generated_at * 1000).toLocaleString()}.
          </div>
        </>
      )}
    </Modal>
  );
}

const EMPTY_FORM = {
  display_name: '',
  connector_id: '',
  delivery_url: '',
  event_types: [],
  warehouse_ids: [],
  rate_limit_per_second: 50,
  pending_ceiling: 10000,
  dlq_ceiling: 1000,
  acknowledge_url_reuse: false,
};

function formatRate(rate) {
  if (rate === null || rate === undefined) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

export default function Webhooks() {
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [createError, setCreateError] = useState('');
  const [reveal, setReveal] = useState(null);
  const [revealAcked, setRevealAcked] = useState(false);
  const [urlReuseGate, setUrlReuseGate] = useState(null);
  const [connectors, setConnectors] = useState([]);
  const [scopeCatalog, setScopeCatalog] = useState({ event_types: [] });
  const [warehouses, setWarehouses] = useState([]);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [editError, setEditError] = useState('');
  const [confirmSoftDelete, setConfirmSoftDelete] = useState(null);
  const [confirmPurge, setConfirmPurge] = useState(null);
  const [purgeError, setPurgeError] = useState(null);
  const [confirmRotate, setConfirmRotate] = useState(null);
  const [dlqRow, setDlqRow] = useState(null);
  const [statsRow, setStatsRow] = useState(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const res = await api.get('/admin/webhooks');
    if (res?.ok) {
      const data = await res.json();
      setWebhooks(data.webhooks || []);
      setPageError('');
    } else {
      setPageError('Falha ao carregar os webhooks');
    }
    setLoading(false);
  }

  async function openCreate() {
    setForm(EMPTY_FORM);
    setCreateError('');
    setUrlReuseGate(null);
    setShowCreate(true);
    // Fire all three picker fetches in parallel; a missing list
    // renders the inner ScopeCheckboxList "No options available"
    // placeholder rather than blocking the modal.
    const [connRes, catalogRes, whRes] = await Promise.all([
      api.get('/admin/connector-registry'),
      api.get('/admin/scope-catalog'),
      api.get('/admin/warehouses', { silentPermissionDenied: true }),
    ]);
    if (connRes?.ok) {
      const data = await connRes.json();
      setConnectors(data.connectors || []);
    }
    if (catalogRes?.ok) {
      const data = await catalogRes.json();
      setScopeCatalog({ event_types: data.event_types || [] });
    }
    if (whRes?.ok) {
      const data = await whRes.json();
      setWarehouses(data.warehouses || []);
    }
  }

  function buildPayload() {
    // Only include filter keys the admin actually picked. The
    // dispatcher's strict-typed Pydantic model treats absent keys
    // as "no filter on this dimension"; sending an empty array
    // would mean "match nothing on this dimension" which is the
    // wrong default for an admin who simply did not check any boxes.
    const subscription_filter = {};
    if (form.event_types.length > 0) subscription_filter.event_types = form.event_types;
    if (form.warehouse_ids.length > 0) subscription_filter.warehouse_ids = form.warehouse_ids;
    return {
      connector_id: form.connector_id,
      display_name: form.display_name.trim(),
      delivery_url: form.delivery_url.trim(),
      subscription_filter,
      rate_limit_per_second: form.rate_limit_per_second,
      pending_ceiling: form.pending_ceiling,
      dlq_ceiling: form.dlq_ceiling,
      acknowledge_url_reuse: form.acknowledge_url_reuse,
    };
  }

  async function submitCreate() {
    setCreateError('');
    if (!form.display_name.trim()) { setCreateError('O nome de exibição é obrigatório'); return; }
    if (!form.connector_id) { setCreateError('O conector é obrigatório'); return; }
    if (!form.delivery_url.trim()) { setCreateError('A URL de entrega é obrigatória'); return; }
    const res = await api.post('/admin/webhooks', buildPayload());
    const body = await res?.json();
    if (res?.status === 409 && body?.error === 'url_reuse_tombstone') {
      // Server-side URL-reuse gate. Stash the tombstone_id so the
      // dedicated modal can surface the deletion history; on
      // confirm the create re-submits with acknowledge_url_reuse.
      setUrlReuseGate({ tombstone_id: body.tombstone_id, detail: body.detail });
      return;
    }
    if (res?.ok) {
      setShowCreate(false);
      setReveal({
        kind: 'issued',
        display_name: body.display_name,
        secret: body.secret,
        secret_generation: body.secret_generation,
      });
      setRevealAcked(false);
      load();
      return;
    }
    setCreateError(body?.error || 'Falha ao criar webhook');
  }

  async function confirmUrlReuse() {
    setForm((f) => ({ ...f, acknowledge_url_reuse: true }));
    setUrlReuseGate(null);
    // Re-submit immediately with the acknowledgement flag flipped
    // on. Building the payload directly here avoids a stale-closure
    // hazard if React batched the state update.
    const payload = { ...buildPayload(), acknowledge_url_reuse: true };
    const res = await api.post('/admin/webhooks', payload);
    const body = await res?.json();
    if (res?.ok) {
      setShowCreate(false);
      setReveal({
        kind: 'issued',
        display_name: body.display_name,
        secret: body.secret,
        secret_generation: body.secret_generation,
      });
      setRevealAcked(false);
      load();
    } else {
      setCreateError(body?.error || 'Falha ao criar webhook');
    }
  }

  async function copySecret() {
    if (!reveal?.secret) return;
    try {
      await navigator.clipboard.writeText(reveal.secret);
    } catch {
      /* clipboard API unavailable; the secret is still visible on-screen */
    }
  }

  async function openEdit(row) {
    setEditError('');
    const filter = row.subscription_filter || {};
    setEditing(row);
    setEditForm({
      display_name: row.display_name,
      delivery_url: row.delivery_url,
      event_types: filter.event_types || [],
      warehouse_ids: filter.warehouse_ids || [],
      rate_limit_per_second: row.rate_limit_per_second,
      pending_ceiling: row.pending_ceiling,
      dlq_ceiling: row.dlq_ceiling,
    });
    // Reuse the cached pickers when present; lazy-load if the
    // admin opens edit before ever opening create in this session.
    if (scopeCatalog.event_types.length === 0 || warehouses.length === 0) {
      const [catalogRes, whRes] = await Promise.all([
        api.get('/admin/scope-catalog'),
        api.get('/admin/warehouses', { silentPermissionDenied: true }),
      ]);
      if (catalogRes?.ok) {
        const data = await catalogRes.json();
        setScopeCatalog({ event_types: data.event_types || [] });
      }
      if (whRes?.ok) {
        const data = await whRes.json();
        setWarehouses(data.warehouses || []);
      }
    }
  }

  function closeEdit() {
    setEditing(null);
    setEditForm(null);
    setEditError('');
  }

  async function submitEdit() {
    if (!editing || !editForm) return;
    if (!editForm.display_name.trim()) { setEditError('O nome de exibição é obrigatório'); return; }
    if (!editForm.delivery_url.trim()) { setEditError('A URL de entrega é obrigatória'); return; }
    // PATCH accepts only the keys the admin actually mutated; sending
    // the full form is fine because the backend short-circuits when
    // the supplied value matches the persisted one (no audit row, no
    // pubsub publish).
    const subscription_filter = {};
    if (editForm.event_types.length > 0) subscription_filter.event_types = editForm.event_types;
    if (editForm.warehouse_ids.length > 0) subscription_filter.warehouse_ids = editForm.warehouse_ids;
    const payload = {
      display_name: editForm.display_name.trim(),
      delivery_url: editForm.delivery_url.trim(),
      subscription_filter,
      rate_limit_per_second: editForm.rate_limit_per_second,
      pending_ceiling: editForm.pending_ceiling,
      dlq_ceiling: editForm.dlq_ceiling,
    };
    const res = await api.patch(`/admin/webhooks/${editing.subscription_id}`, payload);
    const body = await res?.json();
    if (res?.ok) {
      closeEdit();
      load();
    } else {
      setEditError(body?.error || 'Falha ao atualizar webhook');
    }
  }

  async function togglePause(row) {
    const next = row.status === 'active' ? 'paused' : 'active';
    const res = await api.patch(`/admin/webhooks/${row.subscription_id}`, { status: next });
    if (res?.ok) {
      load();
    } else {
      const body = await res?.json();
      setPageError(body?.error || `Falha ao ${next === 'paused' ? 'pause' : 'resume'} webhook`);
    }
  }

  async function softDelete(row) {
    const res = await api.delete(`/admin/webhooks/${row.subscription_id}`);
    if (res?.ok) {
      setConfirmSoftDelete(null);
      load();
    } else {
      const body = await res?.json();
      setPageError(body?.error || 'Falha ao revogar webhook');
      setConfirmSoftDelete(null);
    }
  }

  async function rotateSecret(row) {
    const res = await api.post(`/admin/webhooks/${row.subscription_id}/rotate-secret`, {});
    const body = await res?.json();
    if (res?.ok) {
      setConfirmRotate(null);
      setReveal({
        kind: 'rotated',
        display_name: row.display_name,
        secret: body.secret,
        secret_generation: body.secret_generation,
      });
      setRevealAcked(false);
      load();
    } else {
      setConfirmRotate(null);
      setPageError(body?.detail || body?.error || 'Falha ao rotacionar o segredo');
    }
  }

  async function hardPurge(row) {
    setPurgeError(null);
    const res = await api.delete(`/admin/webhooks/${row.subscription_id}?purge=true`);
    const body = await res?.json();
    if (res?.ok) {
      setConfirmPurge(null);
      load();
      return;
    }
    if (res?.status === 409 && body?.error === 'live_deliveries_block_hard_delete') {
      // Surface the live count and detail in-place so the operator
      // can switch to soft-delete instead of dismissing the modal.
      setPurgeError({ live_count: body.live_count, detail: body.detail });
      return;
    }
    setPageError(body?.error || 'Falha ao expurgar webhook');
    setConfirmPurge(null);
  }

  const httpsValid = form.delivery_url.trim().toLowerCase().startsWith('https://');
  const httpAttempt = form.delivery_url.trim().toLowerCase().startsWith('http://');
  const editHttpAttempt = (editForm?.delivery_url || '').trim().toLowerCase().startsWith('http://');

  const columns = [
    { key: 'display_name', label: 'Nome' },
    { key: 'connector_id', label: 'Conector', render: (r) => <span className="mono">{r.connector_id}</span> },
    {
      key: 'status',
      label: 'Status',
      render: (r) => {
        const b = STATUS_BADGE[r.status];
        return b ? <Badge label={b.label} color={b.color} /> : r.status;
      },
    },
    {
      key: 'pause_reason',
      label: 'Motivo da pausa',
      render: (r) => r.pause_reason
        ? <span className="mono" style={{ fontSize: 12 }}>{r.pause_reason}</span>
        : <span style={{ color: 'var(--text-secondary)' }}>-</span>,
    },
    {
      key: 'success_rate_24h',
      label: 'Sucesso (24h)',
      render: (r) => formatRate(r.stats?.success_rate_24h),
    },
    {
      key: 'pending_count',
      label: 'Pendente',
      render: (r) => <span className="mono">{r.stats?.pending_count ?? 0}</span>,
    },
    {
      key: 'delivery_url',
      label: 'URL',
      render: (r) => (
        <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {r.delivery_url}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="btn btn-sm"
            onClick={(e) => { e.stopPropagation(); openEdit(r); }}
            disabled={r.status === 'revoked'}
            title="Editar"
          >
            Editar
          </button>
          <button
            className="btn btn-sm"
            onClick={(e) => { e.stopPropagation(); togglePause(r); }}
            disabled={r.status === 'revoked'}
            title={r.status === 'active' ? 'Pausar' : 'Retomar'}
          >
            {r.status === 'active' ? 'Pausar' : 'Retomar'}
          </button>
          <button
            className="btn btn-sm"
            onClick={(e) => { e.stopPropagation(); setConfirmRotate(r); }}
            disabled={r.status === 'revoked'}
            title="Rotacionar segredo"
          >
            Trocar
          </button>
          <button
            className="btn btn-sm"
            onClick={(e) => { e.stopPropagation(); setDlqRow(r); }}
            title="Visualizar DLQ + reenviar"
          >
            DLQ
          </button>
          <button
            className="btn btn-sm"
            onClick={(e) => { e.stopPropagation(); setStatsRow(r); }}
            title="Estatísticas"
          >
            Estatísticas
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={(e) => { e.stopPropagation(); setConfirmSoftDelete(r); }}
            disabled={r.status === 'revoked'}
            title="Revogar (exclusão lógica)"
          >
            Revogar
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={(e) => { e.stopPropagation(); setPurgeError(null); setConfirmPurge(r); }}
            title="Expurgar (exclusão definitiva + marcador)"
            aria-label="Expurgar"
          >
            &#128465;
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Webhooks">
        <button className="btn" onClick={() => setShowErrors(true)}>Ver erros</button>
        <button className="btn btn-primary" onClick={openCreate}>Novo webhook</button>
      </PageHeader>

      {pageError && <div className="form-error" style={{ marginBottom: 12 }}>{pageError}</div>}

      <DataTable
        rowKey="subscription_id"
        columns={columns}
        data={webhooks}
        emptyMessage={loading ? 'Carregando…' : 'Nenhuma assinatura de webhook ainda'}
      />

      {showCreate && (
        <Modal
          title="Nova assinatura de webhook"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowCreate(false)}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={submitCreate}
                disabled={!httpsValid && !httpAttempt}
              >
                Criar
              </button>
            </>
          }
        >
          {createError && <div className="form-error" style={{ marginBottom: 12 }}>{createError}</div>}

          <div className="form-group">
            <label>Nome de exibição</label>
            <input
              className="form-input"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              placeholder="fabric-prod"
            />
          </div>

          <div className="form-group">
            <label>Conector</label>
            <select
              className="form-input"
              value={form.connector_id}
              onChange={(e) => setForm({ ...form, connector_id: e.target.value })}
            >
              <option value="">Selecione um conector…</option>
              {connectors.map((c) => (
                <option key={c.connector_id} value={c.connector_id}>
                  {c.connector_id} - {c.display_name}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              Registre um novo conector em Grupos de consumidores para que ele apareça aqui.
            </div>
          </div>

          <div className="form-group">
            <label>URL de entrega</label>
            <input
              className="form-input"
              value={form.delivery_url}
              onChange={(e) => setForm({ ...form, delivery_url: e.target.value })}
              placeholder="https://example.com/webhooks/sentry"
            />
            {httpAttempt && (
              <div className="form-error" style={{ marginTop: 4, fontSize: 12 }}>
                http:// é rejeitado em produção. Use https:// ou defina SENTRY_ALLOW_HTTP_WEBHOOKS=true em dev / CI.
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Tipos de evento (filtro)</label>
            <ScopeCheckboxList
              options={scopeCatalog.event_types}
              value={form.event_types}
              onChange={(types) => setForm((f) => ({ ...f, event_types: types }))}
              keyOf={(t) => t}
              renderLabel={(t) => <span className="mono">{t}</span>}
            />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              Seleção vazia = todos os tipos de evento.
            </div>
          </div>

          <div className="form-group">
            <label>Armazéns (filtro)</label>
            <ScopeCheckboxList
              options={warehouses}
              value={form.warehouse_ids}
              onChange={(ids) => setForm((f) => ({ ...f, warehouse_ids: ids }))}
              keyOf={(w) => w.warehouse_id}
              renderLabel={(w) => (
                <span>
                  <span className="mono">{w.warehouse_code}</span>
                  {w.warehouse_name ? ` - ${w.warehouse_name}` : ''}
                </span>
              )}
            />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              Seleção vazia = todos os armazéns.
            </div>
          </div>

          <Slider
            label="Limite de taxa (req/seg)"
            min={1}
            max={100}
            step={1}
            value={form.rate_limit_per_second}
            onChange={(v) => setForm({ ...form, rate_limit_per_second: v })}
            hint="Token-bucket cap on POST throughput per subscription."
          />

          <Slider
            label="Limite de pendentes"
            min={100}
            max={100000}
            step={100}
            value={form.pending_ceiling}
            onChange={(v) => setForm({ ...form, pending_ceiling: v })}
            hint="Auto-pauses the subscription when pending+in_flight reaches this. Bounded by DISPATCHER_MAX_PENDING_HARD_CAP."
          />

          <Slider
            label="Limite da DLQ"
            min={10}
            max={10000}
            step={10}
            value={form.dlq_ceiling}
            onChange={(v) => setForm({ ...form, dlq_ceiling: v })}
            hint="Auto-pauses the subscription when DLQ depth reaches this. Bounded by DISPATCHER_MAX_DLQ_HARD_CAP."
          />
        </Modal>
      )}

      {urlReuseGate && (
        <Modal
          title="URL usada anteriormente"
          onClose={() => setUrlReuseGate(null)}
          footer={
            <>
              <button className="btn" onClick={() => setUrlReuseGate(null)}>Cancelar</button>
              <button
                className="btn btn-primary"
                style={{ background: 'var(--copper)' }}
                onClick={confirmUrlReuse}
              >
                Confirmar e criar
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600 }}>
            Esta URL de entrega estava associada a uma assinatura excluída anteriormente (marcador {urlReuseGate.tombstone_id}). O consumidor anterior pode ainda estar configurado para receber tráfego nesta URL.
          </p>
          <p style={{ fontSize: 13 }}>
            {urlReuseGate.detail}
          </p>
        </Modal>
      )}

      {reveal && (
        <Modal
          title={reveal.kind === 'rotated' ? 'Segredo do webhook rotacionado' : 'Segredo do webhook emitido'}
          onClose={() => { /* reveal modal must be explicitly acknowledged */ }}
          footer={
            <button
              className="btn btn-primary"
              onClick={() => setReveal(null)}
              disabled={!revealAcked}
              title={revealAcked ? 'Fechar' : 'Confirme que você salvou o segredo primeiro'}
            >
              Fechar
            </button>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600 }}>
            {reveal.display_name}: este segredo (geração {reveal.secret_generation}) é exibido uma única vez. Copie-o agora para o verificador HMAC do consumidor. O SEA armazena apenas a forma criptografada; se você perder este valor, será preciso gerar outro.
          </p>
          <div style={{
            background: 'var(--surface-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 12,
            marginTop: 12,
            wordBreak: 'break-all',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
          }}>
            {reveal.secret}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={copySecret}>Copiar para a área de transferência</button>
          </div>
          <div className="form-group" style={{ marginTop: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={revealAcked}
                onChange={(e) => setRevealAcked(e.target.checked)}
              />
              Salvei este segredo em um local seguro.
            </label>
          </div>
        </Modal>
      )}

      {editing && editForm && (
        <Modal
          title={`Editar ${editing.display_name}`}
          onClose={closeEdit}
          footer={
            <>
              <button className="btn" onClick={closeEdit}>Cancelar</button>
              <button className="btn btn-primary" onClick={submitEdit}>Salvar</button>
            </>
          }
        >
          {editError && <div className="form-error" style={{ marginBottom: 12 }}>{editError}</div>}

          <div className="form-group">
            <label>Conector</label>
            <input
              className="form-input mono"
              value={editing.connector_id}
              readOnly
              disabled
            />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              O conector é definido na criação. Recrie a assinatura para alterá-lo.
            </div>
          </div>

          <div className="form-group">
            <label>Nome de exibição</label>
            <input
              className="form-input"
              value={editForm.display_name}
              onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>URL de entrega</label>
            <input
              className="form-input"
              value={editForm.delivery_url}
              onChange={(e) => setEditForm({ ...editForm, delivery_url: e.target.value })}
            />
            {editHttpAttempt && (
              <div className="form-error" style={{ marginTop: 4, fontSize: 12 }}>
                http:// é rejeitado em produção. Use https:// ou defina SENTRY_ALLOW_HTTP_WEBHOOKS=true em dev / CI.
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              Alterar a URL força o encerramento da sessão do dispatcher e uma nova resolução DNS no próximo envio.
            </div>
          </div>

          <div className="form-group">
            <label>Tipos de evento (filtro)</label>
            <ScopeCheckboxList
              options={scopeCatalog.event_types}
              value={editForm.event_types}
              onChange={(types) => setEditForm({ ...editForm, event_types: types })}
              keyOf={(t) => t}
              renderLabel={(t) => <span className="mono">{t}</span>}
            />
          </div>

          <div className="form-group">
            <label>Armazéns (filtro)</label>
            <ScopeCheckboxList
              options={warehouses}
              value={editForm.warehouse_ids}
              onChange={(ids) => setEditForm({ ...editForm, warehouse_ids: ids })}
              keyOf={(w) => w.warehouse_id}
              renderLabel={(w) => (
                <span>
                  <span className="mono">{w.warehouse_code}</span>
                  {w.warehouse_name ? ` - ${w.warehouse_name}` : ''}
                </span>
              )}
            />
          </div>

          <Slider
            label="Limite de taxa (req/seg)"
            min={1}
            max={100}
            step={1}
            value={editForm.rate_limit_per_second}
            onChange={(v) => setEditForm({ ...editForm, rate_limit_per_second: v })}
          />

          <Slider
            label="Limite de pendentes"
            min={100}
            max={100000}
            step={100}
            value={editForm.pending_ceiling}
            onChange={(v) => setEditForm({ ...editForm, pending_ceiling: v })}
          />

          <Slider
            label="Limite da DLQ"
            min={10}
            max={10000}
            step={10}
            value={editForm.dlq_ceiling}
            onChange={(v) => setEditForm({ ...editForm, dlq_ceiling: v })}
          />
        </Modal>
      )}

      {dlqRow && (
        <DlqPanel
          subscription={dlqRow}
          onClose={() => { setDlqRow(null); load(); }}
        />
      )}

      {statsRow && (
        <StatsPanel
          subscription={statsRow}
          onClose={() => setStatsRow(null)}
        />
      )}

      {showErrors && (
        <WebhookErrorsPanel
          webhooks={webhooks}
          onClose={() => setShowErrors(false)}
        />
      )}

      {confirmRotate && (
        <Modal
          title="Rotacionar segredo do webhook"
          onClose={() => setConfirmRotate(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmRotate(null)}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={() => rotateSecret(confirmRotate)}
              >
                Trocar
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600 }}>
            Rotacionar o segredo HMAC de {confirmRotate.display_name}?
          </p>
          <p style={{ fontSize: 13 }}>
            O segredo atual é rebaixado para a geração 2 com uma janela de 24 horas de aceitação dupla. Os consumidores podem validar com qualquer geração até a janela expirar; o dispatcher assina os novos POSTs com a nova geração 1 imediatamente. O novo valor é exibido uma vez na próxima tela.
          </p>
          <p style={{ fontSize: 13, color: 'var(--copper)' }}>
            Uma segunda rotação em menos de 24 horas sobrescreve o segredo rebaixado e encurta a janela de transição para consumidores que ainda não adotaram o novo valor.
          </p>
        </Modal>
      )}

      {confirmSoftDelete && (
        <Modal
          title="Revogar webhook"
          onClose={() => setConfirmSoftDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmSoftDelete(null)}>Cancelar</button>
              <button
                className="btn btn-primary"
                style={{ background: 'var(--copper)' }}
                onClick={() => softDelete(confirmSoftDelete)}
              >
                Revogar
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600 }}>
            Revogar {confirmSoftDelete.display_name}? O envio para em segundos (expulsão via Redis pubsub); o registro continua na lista com status=revoked para que o histórico de webhook_deliveries mantenha a referência. Use Expurgar para remover o registro por completo após as entregas em andamento terminarem.
          </p>
        </Modal>
      )}

      {confirmPurge && (
        <Modal
          title="Expurgar webhook"
          onClose={() => setConfirmPurge(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmPurge(null)}>Cancelar</button>
              <button
                className="btn btn-primary"
                style={{ background: 'var(--danger)' }}
                onClick={() => hardPurge(confirmPurge)}
              >
                Expurgar
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>
            Excluir permanentemente {confirmPurge.display_name}?
          </p>
          <p style={{ fontSize: 13 }}>
            O registro é removido e um marcador é gravado. O próximo administrador que criar um webhook com a mesma URL de entrega ({confirmPurge.delivery_url}) verá o aviso de URL reutilizada. Recusado enquanto houver entregas pending ou in_flight referenciando esta assinatura.
          </p>
          {purgeError && (
            <div className="form-error" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600 }}>
                {purgeError.live_count} entrega ativa{purgeError.live_count === 1 ? 'y' : 'ies'} bloqueiam este expurgo.
              </div>
              <div style={{ marginTop: 4, fontSize: 12 }}>{purgeError.detail}</div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
