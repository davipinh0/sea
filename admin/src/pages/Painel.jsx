import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { actionLabel, formatDateTime, readError } from '../utils/sea.js';
import { useLiveRefresh } from '../utils/useLiveRefresh.js';

// Painel: operational overview of the SP12 sector. KPI tiles link to the
// tab where the work happens; the activity feed reads the audit log.

const REFRESH_MS = 30000;
// "Ocultar" is a choice of this browser; "Limpar" is kept by the API.
const HIDDEN_KEY = 'sea_painel_movimentacoes_ocultas';

function readHidden() {
  try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}

function describe(entry) {
  const d = entry.details || {};
  const parts = [];
  // OT numbers may already start with "OT-": do not repeat the prefix.
  const order = d.ot || d.po_number || d.lot_number;
  if (order) parts.push(/^OT/i.test(order) ? order : `OT ${order}`);
  if (d.sku) parts.push(d.sku);
  if (d.quantity) parts.push(`${d.quantity} un.`);
  if (d.to_bin_code) parts.push(`→ ${d.to_bin_code}`);
  if (d.employee_name) parts.push(`para ${d.employee_name}`);
  if (d.reason) parts.push(`motivo: ${d.reason}`);
  return parts.join(' · ');
}

function Kpi({ to, value, label, alert }) {
  return (
    <Link to={to} className={`sea-kpi${alert ? ' is-alert' : ''}`}>
      <div className="sea-kpi-value">{value}</div>
      <div className="sea-kpi-label">{label}</div>
    </Link>
  );
}

export default function Painel() {
  const { warehouseId, warehouse } = useWarehouse();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  // Bumping ``tick`` re-runs the fetch (Atualizar button and auto-refresh).
  const [tick, setTick] = useState(0);
  const [hidden, setHidden] = useState(readHidden);
  const [busy, setBusy] = useState(false);

  function toggleHidden() {
    const next = !hidden;
    setHidden(next);
    try { localStorage.setItem(HIDDEN_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  }

  // mig 094: "Limpar" restarts this user's list; the history keeps it all.
  async function changeList(action) {
    setBusy(true);
    const res = await api.post(`/sea/painel/movimentacoes/${action}`, {});
    setBusy(false);
    if (res?.ok) setTick((n) => n + 1);
    else setError(await readError(res, 'Não foi possível alterar a lista.'));
  }

  useEffect(() => {
    if (!warehouseId) return undefined;
    let cancelled = false;
    api.get(`/sea/painel?warehouse_id=${warehouseId}`, { silentPermissionDenied: true }).then(async (res) => {
      if (cancelled || !res) return;
      if (!res.ok) {
        const msg = await readError(res, 'Não foi possível carregar o painel.');
        if (!cancelled) setError(msg);
        return;
      }
      const json = await res.json();
      if (!cancelled) { setError(''); setData(json); }
    });
    return () => { cancelled = true; };
  }, [warehouseId, tick]);

  useLiveRefresh(() => setTick((n) => n + 1), REFRESH_MS);

  if (!warehouseId) return <p style={{ padding: 24 }}>Selecione um local na barra superior.</p>;

  const ots = data?.ots || {};
  const count = (type, statuses) => statuses.reduce((acc, s) => acc + (ots[type]?.[s] || 0), 0);
  const w = data?.withdrawals || {};

  return (
    <div>
      <PageHeader title={warehouse ? `Painel · ${warehouse.warehouse_code} - ${warehouse.warehouse_name}` : 'Painel'}>
        <button type="button" className="btn btn-sm" onClick={() => setTick((n) => n + 1)}>Atualizar</button>
      </PageHeader>
      {error && <div className="form-error">{error}</div>}
      {data && (
        <>
          <div className="section-title">Recebimento e armazenagem</div>
          <div className="sea-kpis">
            <Kpi to="/expedicao/recebimento" value={count('PM11', ['OPEN', 'PARTIAL']) + count('PM12', ['OPEN', 'PARTIAL'])} label="Ordens a receber" />
            <Kpi to="/expedicao/armazenagem" value={data.staging_units} label={`Unidades aguardando armazenagem (${data.staging_ots} ordem(ns))`} alert={data.staging_units > 0} />
            <Kpi to="/estoque/sp12" value={data.stored_units} label="Unidades armazenadas" />
            <Kpi to="/estoque/sp12" value={`${data.occupied_bins}/${data.storage_bins}`} label="Endereços ocupados" />
          </div>

          <div className="section-title">Retirada</div>
          <div className="sea-kpis">
            <Kpi to="/retirada" value={w.REQUESTED || 0} label="Aguardando avaliação" alert={(w.REQUESTED || 0) > 0} />
            <Kpi to="/retirada" value={w.APPROVED || 0} label="Aprovadas, aguardando quem faça" alert={(w.APPROVED || 0) > 0} />
            <Kpi to="/retirada" value={w.PICKING || 0} label="Em separação" />
            <Kpi to="/retirada" value={w.READY || 0} label="Prontas, aguardando a confirmação no terminal" />
            <Kpi to="/retirada" value={w.DELIVERED || 0} label="Entregues hoje" />
          </div>

          {data.recent && (
          <>
          <div className="section-title sea-section-actions">
            <span>Últimas movimentações</span>
            <span>
              <button type="button" className="btn btn-sm" onClick={toggleHidden}>{hidden ? 'Mostrar' : 'Ocultar'}</button>
              {!hidden && (
                <button type="button" className="btn btn-sm" disabled={busy || data.recent.length === 0} onClick={() => changeList('limpar')}>Limpar</button>
              )}
            </span>
          </div>
          {!hidden && data.recent_cleared_at && (
            <p className="settings-note">
              Lista limpa em {formatDateTime(data.recent_cleared_at)} (só para você; o histórico continua completo).{' '}
              <button type="button" className="btn-link" disabled={busy} onClick={() => changeList('restaurar')}>Mostrar tudo de novo</button>
            </p>
          )}
          {hidden ? null : data.recent.length === 0 ? <p className="settings-note">Nenhuma movimentação registrada.</p> : (
            <table className="lines-table">
              <thead><tr><th>Data/hora</th><th>Operação</th><th>Detalhe</th><th>Responsável</th></tr></thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.log_id}>
                    <td>{formatDateTime(r.created_at)}</td>
                    <td>{actionLabel(r.action_type)}</td>
                    <td>{describe(r)}</td>
                    <td>{r.user}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={{ marginTop: 8 }}><Link to="/estoque/historico">Ver histórico completo →</Link></p>
          </>
          )}
        </>
      )}
    </div>
  );
}
