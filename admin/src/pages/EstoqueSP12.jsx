import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import StatusTag from '../components/StatusTag.jsx';
import { OtDetailModal, OtTypeTag } from '../components/sea.jsx';
import { formatDateTime, readError } from '../utils/sea.js';
import { useLiveRefresh } from '../utils/useLiveRefresh.js';

// Estoque SP12: total stock of the sector, an address map (shelves A, B,
// C... by level) and the list of PM11 / PM12 transfer orders with where
// each one is stored. Read-only: movements happen in Expedição/Retirada.

const OT_STATUSES = ['', 'OPEN', 'PARTIAL', 'RECEIVED', 'CLOSED'];
const OT_STATUS_LABELS = {
  '': 'Todos os status', OPEN: 'Aberta', PARTIAL: 'Recebimento parcial', RECEIVED: 'Recebida', CLOSED: 'Fechada',
};

function shelvesFrom(bins) {
  const storage = bins.filter((b) => !b.staging);
  const byAisle = new Map();
  for (const b of storage) {
    const key = b.aisle || b.bin_code.replace(/\d+$/, '') || '-';
    if (!byAisle.has(key)) byAisle.set(key, []);
    byAisle.get(key).push(b);
  }
  for (const list of byAisle.values()) {
    // Top level first, like looking at the shelf.
    list.sort((a, b) => Number(b.level ?? 0) - Number(a.level ?? 0) || a.bin_code.localeCompare(b.bin_code));
  }
  return [...byAisle.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function Slot({ bin, selected, onSelect }) {
  const orders = [...new Set(bin.contents.map((c) => c.order_number).filter(Boolean))];
  return (
    <button type="button" className={`sea-slot${selected ? ' selected' : ''}`} onClick={() => onSelect(bin)}>
      <div className="sea-slot-head">
        <span className="sea-slot-code">{bin.bin_code}</span>
        <span>{!bin.is_active && <span className="tag tag-gray">Inativo</span>}</span>
      </div>
      <div className="sea-slot-meta">
        {bin.units > 0 ? `${bin.units} un.` : 'Vazio'}
        {orders.length > 0 && ` · ${orders.length === 1 ? 'Ordem' : 'Ordens'} ${orders.join(', ')}`}
      </div>
    </button>
  );
}

export default function EstoqueSP12() {
  const { warehouseId } = useWarehouse();
  const [estoque, setEstoque] = useState(null);
  const [ots, setOts] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);

  // Bumping ``tick`` re-runs both fetches (Atualizar button and auto-refresh).
  const [tick, setTick] = useState(0);
  useLiveRefresh(() => setTick((n) => n + 1));

  useEffect(() => {
    if (!warehouseId) return undefined;
    let cancelled = false;
    api.get(`/sea/estoque?warehouse_id=${warehouseId}`).then(async (res) => {
      if (cancelled || !res) return;
      if (!res.ok) {
        const msg = await readError(res, 'Não foi possível carregar o estoque.');
        if (!cancelled) setError(msg);
        return;
      }
      const json = await res.json();
      if (!cancelled) { setError(''); setEstoque(json); }
    });
    return () => { cancelled = true; };
  }, [warehouseId, tick]);

  useEffect(() => {
    if (!warehouseId) return undefined;
    let cancelled = false;
    const params = new URLSearchParams({ warehouse_id: warehouseId });
    if (typeFilter) params.set('order_type', typeFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (search) params.set('q', search);
    // One row per order (PM11 / PM12); the OT is a reference column.
    api.get(`/sea/ordens?${params}`).then(async (res) => {
      if (cancelled || !res?.ok) return;
      const json = await res.json();
      if (!cancelled) setOts(json.orders || []);
    });
    return () => { cancelled = true; };
  }, [warehouseId, typeFilter, statusFilter, search, tick]);

  const shelves = useMemo(() => (estoque ? shelvesFrom(estoque.bins) : []), [estoque]);
  const staging = useMemo(() => (estoque ? estoque.bins.filter((b) => b.staging) : []), [estoque]);
  const selectedBin = selected && estoque ? estoque.bins.find((b) => b.bin_id === selected) : null;

  const otColumns = [
    { key: 'order_number', label: 'Ordem', mono: true },
    { key: 'order_type', label: 'Tipo', render: (r) => <OtTypeTag type={r.order_type} />, csvValue: (r) => r.order_type },
    // mig 098: an order that arrived may belong to an OT still waiting for other materials.
    { key: 'status', label: 'Status', render: (r) => (
      <>
        <StatusTag status={r.status} />
        {r.ot_status === 'PARTIAL' && r.status !== 'PARTIAL' && (
          <div className="settings-note" style={{ marginTop: 2 }}>OT {r.ot} em recebimento parcial: falta(m) {r.ot_pending_materials} material(is)</div>
        )}
      </>
    ), csvValue: (r) => r.status },
    { key: 'qty_ordered', label: 'Prevista' },
    { key: 'qty_received', label: 'Recebida' },
    { key: 'qty_staging', label: 'Aguard. armazenagem' },
    { key: 'qty_stored', label: 'Armazenada' },
    { key: 'qty_withdrawn', label: 'Retirada' },
    { key: 'bins', label: 'Endereço', mono: true, render: (r) => r.bins || '-' },
    { key: 'received_at', label: 'Recebida em', render: (r) => formatDateTime(r.received_at) },
    { key: 'ot', label: 'OT', mono: true },
  ];

  if (!warehouseId) return <p style={{ padding: 24 }}>Selecione um local na barra superior.</p>;

  return (
    <div>
      <PageHeader title="Visão Geral do Estoque">
        <button type="button" className="btn btn-sm" onClick={() => setTick((n) => n + 1)}>Atualizar</button>
      </PageHeader>
      {error && <div className="form-error">{error}</div>}

      {estoque && (
        <div className="sea-kpis">
          <div className="sea-kpi"><div className="sea-kpi-value">{estoque.totals.stored_units}</div><div className="sea-kpi-label">Unidades armazenadas</div></div>
          <div className="sea-kpi"><div className="sea-kpi-value">{estoque.totals.staging_units}</div><div className="sea-kpi-label">Aguardando armazenagem</div></div>
          <div className="sea-kpi"><div className="sea-kpi-value">{estoque.totals.occupied_bins}/{estoque.totals.storage_bins}</div><div className="sea-kpi-label">Endereços ocupados</div></div>
          <div className="sea-kpi"><div className="sea-kpi-value">{ots.filter((o) => o.qty_stored > 0).length}</div><div className="sea-kpi-label">Ordens armazenadas</div></div>
        </div>
      )}

      <div className="section-title">Endereços</div>
      <div className="sea-shelves">
        {shelves.map(([aisle, bins]) => (
          <div key={aisle} className="sea-shelf">
            <div className="sea-shelf-title">Prateleira {aisle}</div>
            {bins.map((b) => (
              <Slot key={b.bin_id} bin={b} selected={selected === b.bin_id} onSelect={(bin) => setSelected(bin.bin_id)} />
            ))}
          </div>
        ))}
        {staging.map((b) => (
          <div key={b.bin_id} className="sea-shelf">
            <div className="sea-shelf-title">Área de recebimento</div>
            <Slot bin={b} selected={selected === b.bin_id} onSelect={(bin) => setSelected(bin.bin_id)} />
          </div>
        ))}
        {estoque && shelves.length === 0 && <p className="settings-note">Nenhum endereço de armazenagem cadastrado neste local.</p>}
      </div>

      {selectedBin && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Conteúdo de {selectedBin.bin_code}</div>
          {selectedBin.contents.length === 0 ? <p className="settings-note">Endereço vazio.</p> : (
            <table className="lines-table">
              <thead><tr><th>Ordem</th><th>Tipo</th><th>Código</th><th>Descrição</th><th>Em estoque</th><th>Reservado</th><th>Disponível</th><th>OT</th></tr></thead>
              <tbody>
                {selectedBin.contents.map((c) => (
                  <tr key={c.inventory_id}>
                    <td className="mono">{c.order_number || '-'}</td>
                    <td><OtTypeTag type={c.order_type} /></td>
                    <td className="mono">{c.sku}</td><td>{c.item_name}</td>
                    <td>{c.quantity_on_hand}</td><td>{c.quantity_allocated}</td><td>{c.available}</td>
                    <td className="mono">{c.ot ? <a href="#" onClick={(e) => { e.preventDefault(); setDetail(c.ot); }}>{c.ot}</a> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="section-title">Ordens (PM11 e PM12)</div>
      <div className="filter-bar">
        <select className="form-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Tipo de ordem">
          <option value="">PM11 e PM12</option>
          <option value="PM11">Somente PM11</option>
          <option value="PM12">Somente PM12</option>
        </select>
        <select className="form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status da ordem">
          {OT_STATUSES.map((s) => <option key={s} value={s}>{OT_STATUS_LABELS[s]}</option>)}
        </select>
        <input className="form-input" placeholder="Buscar por ordem ou OT" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <DataTable
        columns={otColumns}
        data={ots}
        rowKey="row_id"
        onRowClick={(r) => setDetail(r.ot)}
        emptyMessage="Nenhuma ordem encontrada."
      />

      {detail && <OtDetailModal code={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
