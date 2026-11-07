import { useState, useEffect } from 'react';
import { api } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';

// Rotation badges computed server-side, rendered client-side.
const ROTATION_BADGE = {
  none: null,
  recommended: { label: 'rotação recomendada', color: '#c49100' },
  overdue: { label: 'rotação atrasada', color: 'var(--danger)' },
};

const STATUS_BADGE = {
  active: { label: 'active', color: 'var(--text-secondary)' },
  revoked: { label: 'revoked', color: 'var(--danger)' },
  expired: { label: 'expired', color: 'var(--danger)' },
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

function renderCsv(list) {
  if (!list || list.length === 0) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  return <span className="mono" style={{ fontSize: 12 }}>{list.join(', ')}</span>;
}

// #159: reusable checkbox picker used by the three token-scope
// fields on the create modal. `options` is the pool the admin can
// pick from (from /admin/scope-catalog or /admin/warehouses);
// `value` is the currently-selected array; `onChange` receives the
// new array. "All" / "None" buttons are inline so the common case
// (grant everything / deny everything) is a single click.
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

const EMPTY_FORM = {
  token_name: '',
  warehouse_ids: [],
  event_types: [],
  endpoints: [],
  // v1.7.0 Pipe B inbound scope dimensions. source_system is a single
  // select (one allowlist row per token); inbound_resources mirrors
  // the event_types / endpoints checkbox shape; mapping_override is
  // a single capability flag.
  source_system: '',
  inbound_resources: [],
  mapping_override: false,
  advancedMode: false,
  advancedWarehouseIds: '',
  advancedEventTypes: '',
  advancedEndpoints: '',
};

export default function Tokens() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [createError, setCreateError] = useState('');
  const [reveal, setReveal] = useState(null);
  const [revealAcked, setRevealAcked] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pageError, setPageError] = useState('');
  // #159: scope-picker data. Fetched on modal open so fresh
  // deployments without a cached catalog still get correct
  // checkbox options. Empty defaults render "No options" placeholders
  // rather than blowing up before the fetch returns.
  const [scopeCatalog, setScopeCatalog] = useState({
    event_types: [],
    endpoints: [],
    inbound_resources: [],
    source_systems: [],
  });
  const [warehouses, setWarehouses] = useState([]);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const res = await api.get('/admin/tokens');
    if (res?.ok) {
      const data = await res.json();
      setTokens(data.tokens || []);
      setPageError('');
    } else {
      setPageError('Falha ao carregar os tokens');
    }
    setLoading(false);
  }

  async function openCreate() {
    setForm(EMPTY_FORM);
    setCreateError('');
    setShowCreate(true);
    // Fire both fetches in parallel; either failing falls back to an
    // empty list in the respective checkbox component.
    const [catalogRes, warehousesRes] = await Promise.all([
      api.get('/admin/scope-catalog'),
      api.get('/admin/warehouses', { silentPermissionDenied: true }),
    ]);
    if (catalogRes?.ok) {
      const data = await catalogRes.json();
      setScopeCatalog({
        event_types: data.event_types || [],
        endpoints: data.endpoints || [],
        inbound_resources: data.inbound_resources || [],
        source_systems: data.source_systems || [],
      });
    }
    if (warehousesRes?.ok) {
      const data = await warehousesRes.json();
      setWarehouses(data.warehouses || []);
    }
  }

  function parseCsv(raw) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  function toggleAdvanced() {
    // When toggling on: seed the advanced text inputs from the
    // current checkbox selections so the admin does not lose work.
    // When toggling off: parse the text back into the checkbox
    // selections for the same reason. Either way, the two
    // representations stay in sync at toggle-time even if the
    // admin edits them in the other mode afterwards.
    setForm((f) => {
      if (!f.advancedMode) {
        return {
          ...f,
          advancedMode: true,
          advancedWarehouseIds: f.warehouse_ids.join(', '),
          advancedEventTypes: f.event_types.join(', '),
          advancedEndpoints: f.endpoints.join(', '),
        };
      }
      const wh_ids = parseCsv(f.advancedWarehouseIds).map(Number).filter(Number.isFinite);
      return {
        ...f,
        advancedMode: false,
        warehouse_ids: wh_ids,
        event_types: parseCsv(f.advancedEventTypes),
        endpoints: parseCsv(f.advancedEndpoints),
      };
    });
  }

  async function submitCreate() {
    setCreateError('');
    if (!form.token_name.trim()) { setCreateError('O nome é obrigatório'); return; }

    // #159: in advanced mode, parse text inputs at submit time so
    // the admin can tweak right up to the Create click. In
    // checkbox mode, the arrays are already maintained in form state.
    let wh_ids;
    let event_types;
    let endpoints;
    if (form.advancedMode) {
      wh_ids = parseCsv(form.advancedWarehouseIds).map(s => Number(s)).filter(n => Number.isInteger(n) && n > 0);
      if (form.advancedWarehouseIds.trim() && wh_ids.length === 0) {
        setCreateError('Os IDs de armazém devem ser inteiros positivos separados por vírgula');
        return;
      }
      event_types = parseCsv(form.advancedEventTypes);
      endpoints = parseCsv(form.advancedEndpoints);
    } else {
      wh_ids = form.warehouse_ids;
      event_types = form.event_types;
      endpoints = form.endpoints;
    }

    // v1.7.0 Pipe B: at least one direction must be set. Either
    // endpoints (outbound, v1.5 shape) OR source_system + inbound_resources
    // (inbound). Both is valid (connector-framework shape at v1.9).
    const hasOutbound = endpoints.length > 0;
    const hasInbound = !!form.source_system && form.inbound_resources.length > 0;
    if (!hasOutbound && !hasInbound) {
      setCreateError(
        'É necessária pelo menos uma direção: Endpoints (saída) ' +
        'ou Sistema de origem + Recursos de entrada (entrada).'
      );
      return;
    }
    if (!!form.source_system !== form.inbound_resources.length > 0) {
      // XOR: half-configured inbound is rejected by the server too.
      setCreateError(
        'Sistema de origem e Recursos de entrada devem ser definidos juntos; ' +
        'deixe ambos vazios para um token só de saída.'
      );
      return;
    }
    if (form.mapping_override && form.inbound_resources.length === 0) {
      setCreateError(
        'A capacidade mapping_override só se aplica a tokens de entrada.'
      );
      return;
    }
    const payload = {
      token_name: form.token_name.trim(),
      warehouse_ids: wh_ids,
      event_types,
      endpoints,
      source_system: form.source_system || null,
      inbound_resources: form.inbound_resources,
      mapping_override: form.mapping_override,
    };
    const res = await api.post('/admin/tokens', payload);
    const body = await res?.json();
    if (res?.ok) {
      setShowCreate(false);
      setReveal({ kind: 'issued', token: body.token, token_name: body.token_name });
      setRevealAcked(false);
      load();
    } else {
      setCreateError(body?.error || 'Falha ao criar token');
    }
  }

  async function rotate(row) {
    const res = await api.post(`/admin/tokens/${row.token_id}/rotate`, {});
    const body = await res?.json();
    if (res?.ok) {
      setReveal({ kind: 'rotated', token: body.token, token_name: row.token_name });
      setRevealAcked(false);
      load();
    } else {
      setPageError(body?.error || 'Falha na rotação');
    }
  }

  async function revoke(row) {
    const res = await api.post(`/admin/tokens/${row.token_id}/revoke`, {});
    if (res?.ok) {
      setConfirmRevoke(null);
      load();
    } else {
      const body = await res?.json();
      setPageError(body?.error || 'Falha ao revogar');
      setConfirmRevoke(null);
    }
  }

  async function del(row) {
    const res = await api.delete(`/admin/tokens/${row.token_id}`);
    if (res?.ok) {
      setConfirmDelete(null);
      load();
    } else {
      const body = await res?.json();
      setPageError(body?.error || 'Falha ao excluir');
      setConfirmDelete(null);
    }
  }

  async function copyToken() {
    if (!reveal?.token) return;
    // Clipboard API may be unavailable (older iOS, http:// dev origins).
    // The raw value is still visible on-screen; the copy button just
    // becomes inert rather than raising.
    try {
      await navigator.clipboard.writeText(reveal.token);
    } catch {
      /* noop */
    }
  }

  const columns = [
    { key: 'token_name', label: 'Nome' },
    {
      key: 'status',
      label: 'Status',
      render: (r) => {
        const b = STATUS_BADGE[r.status];
        return b ? <Badge label={b.label} color={b.color} /> : r.status;
      },
    },
    {
      key: 'rotation_status',
      label: 'Rotação',
      render: (r) => {
        const b = ROTATION_BADGE[r.rotation_status];
        if (!b) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
        return <Badge label={b.label} color={b.color} />;
      },
    },
    { key: 'warehouse_ids', label: 'Armazéns', render: (r) => renderCsv(r.warehouse_ids) },
    { key: 'event_types', label: 'Tipos de evento', render: (r) => renderCsv(r.event_types) },
    { key: 'endpoints', label: 'Endpoints', render: (r) => renderCsv(r.endpoints) },
    {
      key: 'source_system',
      label: 'Origem',
      render: (r) =>
        r.source_system
          ? <span className="mono" style={{ fontSize: 12 }}>{r.source_system}</span>
          : <span style={{ color: 'var(--text-secondary)' }}>—</span>,
    },
    { key: 'inbound_resources', label: 'Entrada', render: (r) => renderCsv(r.inbound_resources) },
    {
      key: 'expires_at',
      label: 'Expira',
      render: (r) => r.expires_at ? new Date(r.expires_at).toLocaleDateString() : '—',
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); rotate(r); }}
                  disabled={r.status !== 'active'} title="Trocar">↻</button>
          <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); setConfirmRevoke(r); }}
                  disabled={r.status !== 'active'} title="Revogar">⊘</button>
          <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); setConfirmDelete(r); }}
                  aria-label="Excluir" title="Excluir">&#128465;</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Tokens de API">
        <button className="btn btn-primary" onClick={openCreate}>Novo token</button>
      </PageHeader>

      {pageError && <div className="form-error" style={{ marginBottom: 12 }}>{pageError}</div>}

      <DataTable
        rowKey="token_id"
        columns={columns}
        data={tokens}
        emptyMessage={loading ? 'Carregando…' : 'Nenhum token de API emitido ainda'}
      />

      {showCreate && (
        <Modal
          title="Novo token de API"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowCreate(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={submitCreate}>Criar</button>
            </>
          }
        >
          {createError && <div className="form-error" style={{ marginBottom: 12 }}>{createError}</div>}
          <div className="form-group">
            <label>Nome</label>
            <input
              className="form-input"
              value={form.token_name}
              onChange={(e) => setForm({ ...form, token_name: e.target.value })}
              placeholder="fabric-prod"
            />
          </div>

          {/* #159: default (checkbox-driven) path. Hidden when the
              admin opens the Advanced disclosure below. */}
          {!form.advancedMode && (
            <>
              <div className="form-group">
                <label>Armazéns</label>
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
                  Seleção vazia nega acesso a todos os armazéns.
                </div>
              </div>
              <div className="form-group">
                <label>Tipos de evento</label>
                <ScopeCheckboxList
                  options={scopeCatalog.event_types}
                  value={form.event_types}
                  onChange={(types) => setForm((f) => ({ ...f, event_types: types }))}
                  keyOf={(t) => t}
                  renderLabel={(t) => <span className="mono">{t}</span>}
                />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Seleção vazia nega todos os event_type.
                </div>
              </div>
              <div className="form-group">
                <label>Endpoints</label>
                <ScopeCheckboxList
                  options={scopeCatalog.endpoints}
                  value={form.endpoints}
                  onChange={(slugs) => setForm((f) => ({ ...f, endpoints: slugs }))}
                  keyOf={(s) => s}
                  renderLabel={(s) => <span className="mono">{s}</span>}
                />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Rotas v1 de saída. Deixe vazio para um token só de entrada.
                </div>
              </div>

              {/* v1.7.0 Pipe B inbound scope. Source-system dropdown is
                  populated from inbound_source_systems_allowlist via
                  /admin/scope-catalog; admins cannot type a value the
                  FK would reject. */}
              <div className="form-group" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <label htmlFor="token-source-system">Sistema de origem (entrada)</label>
                <select
                  id="token-source-system"
                  aria-label="Sistema de origem"
                  className="form-input"
                  value={form.source_system}
                  onChange={(e) => setForm((f) => ({ ...f, source_system: e.target.value }))}
                >
                  <option value="">— Nenhum (token só de saída) —</option>
                  {scopeCatalog.source_systems.map((s) => (
                    <option key={s.source_system} value={s.source_system}>
                      {s.source_system} ({s.kind})
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Obrigatório para tokens de entrada. Novas entradas são criadas pelo script SQL do operador em docs/runbooks/inbound-source-systems.md.
                </div>
              </div>
              <div className="form-group">
                <label>Recursos de entrada</label>
                <ScopeCheckboxList
                  options={scopeCatalog.inbound_resources}
                  value={form.inbound_resources}
                  onChange={(rs) => setForm((f) => ({ ...f, inbound_resources: rs }))}
                  keyOf={(s) => s}
                  renderLabel={(s) => <span className="mono">{s}</span>}
                />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Escopo de recursos de entrada. Obrigatório quando o sistema de origem é definido. Seleção vazia nega todos os recursos de entrada.
                </div>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.mapping_override}
                    onChange={(e) => setForm((f) => ({ ...f, mapping_override: e.target.checked }))}
                  />
                  <span>Permitir mapping_overrides (flag de capacidade)</span>
                </label>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Reservado para a v1.7.1. Conceder esta capacidade não tem efeito na v1.7.0; requisições com mapping_overrides retornam 403 de qualquer forma.
                </div>
              </div>
            </>
          )}

          {/* #159: advanced escape hatch. Collapsed by default so
              the common case stays checkbox-driven. Shown when the
              admin needs to paste a scope from docs or scripting. */}
          <div className="form-group" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.advancedMode}
                onChange={toggleAdvanced}
                aria-label="Avançado: colar valores separados por vírgula"
              />
              <span style={{ fontSize: 13 }}>Avançado: colar valores separados por vírgula</span>
            </label>
          </div>
          {form.advancedMode && (
            <>
              <div className="form-group">
                <label>IDs de armazém</label>
                <input
                  className="form-input"
                  value={form.advancedWarehouseIds}
                  onChange={(e) => setForm({ ...form, advancedWarehouseIds: e.target.value })}
                  placeholder="1, 2"
                />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  IDs inteiros separados por vírgula. Vazio = sem acesso a armazéns.
                </div>
              </div>
              <div className="form-group">
                <label>Tipos de evento</label>
                <input
                  className="form-input"
                  value={form.advancedEventTypes}
                  onChange={(e) => setForm({ ...form, advancedEventTypes: e.target.value })}
                  placeholder="receipt.completed, ship.confirmed"
                />
              </div>
              <div className="form-group">
                <label>Endpoints</label>
                <input
                  className="form-input"
                  value={form.advancedEndpoints}
                  onChange={(e) => setForm({ ...form, advancedEndpoints: e.target.value })}
                  placeholder="events.poll, snapshot.inventory"
                />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Obrigatório. Slugs separados por vírgula; o token só acessa as rotas v1 listadas.
                </div>
              </div>
            </>
          )}
        </Modal>
      )}

      {reveal && (
        <Modal
          title={reveal.kind === 'issued' ? 'Token emitido' : 'Token rotacionado'}
          onClose={() => { /* reveal modal must be explicitly acknowledged */ }}
          footer={
            <button
              className="btn btn-primary"
              onClick={() => setReveal(null)}
              disabled={!revealAcked}
              title={revealAcked ? 'Fechar' : 'Confirme que você salvou o token primeiro'}
            >
              Fechar
            </button>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600 }}>
            {reveal.token_name}: este valor é exibido uma única vez. Copie-o agora para a configuração do seu conector. O SEA armazena apenas o hash; se você perder este valor, será preciso gerar outro.
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
            {reveal.token}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={copyToken}>Copiar para a área de transferência</button>
          </div>
          <div className="form-group" style={{ marginTop: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={revealAcked}
                onChange={(e) => setRevealAcked(e.target.checked)}
              />
              Salvei este token em um local seguro.
            </label>
          </div>
        </Modal>
      )}

      {confirmRevoke && (
        <Modal
          title="Revogar token"
          onClose={() => setConfirmRevoke(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmRevoke(null)}>Cancelar</button>
              <button className="btn btn-primary" style={{ background: 'var(--copper)' }}
                      onClick={() => revoke(confirmRevoke)}>Revogar</button>
            </>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600 }}>
            Revogar {confirmRevoke.token_name}? O token deixa de autenticar em segundos em todos os workers da API (expulsão via Redis pubsub); o cache de 60 segundos é a garantia se o canal pubsub estiver indisponível. O registro continua na lista com status=revoked; exclua-o separadamente quando quiser removê-lo.
          </p>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="Excluir token"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancelar</button>
              <button className="btn btn-primary" style={{ background: 'var(--copper)' }}
                      onClick={() => del(confirmDelete)}>Excluir</button>
            </>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>
            Excluir permanentemente {confirmDelete.token_name}? Isto remove o registro por completo. Prefira Revogar se só precisa bloquear o acesso; registros revogados preservam a trilha de auditoria.
          </p>
        </Modal>
      )}
    </div>
  );
}
