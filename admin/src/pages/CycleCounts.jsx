import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import StatusTag from '../components/StatusTag.jsx';

export default function CycleCounts() {
  const { warehouseId } = useWarehouse();
  const [counts, setCounts] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [bins, setBins] = useState([]);
  const [selectedBins, setSelectedBins] = useState([]);
  const [message, setMessage] = useState('');
  const [selectedCount, setSelectedCount] = useState(null);

  useEffect(() => {
    loadCounts();
  }, []);

  async function loadCounts() {
    const res = await api.get('/admin/cycle-counts');
    if (res?.ok) {
      const data = await res.json();
      setCounts(data.cycle_counts || []);
    }
  }

  async function openCreate() {
    const res = await api.get(`/admin/bins?warehouse_id=${warehouseId}`);
    if (res?.ok) {
      const data = await res.json();
      setBins(data.bins || []);
    }
    setSelectedBins([]);
    setShowCreate(true);
  }

  function toggleBin(id) {
    setSelectedBins((prev) =>
      prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]
    );
  }

  async function createCount() {
    if (selectedBins.length === 0) return;
    const res = await api.post('/inventory/cycle-count/create', {
      bin_ids: selectedBins,
      warehouse_id: warehouseId,
    });
    if (res?.ok) {
      setMessage('Contagem cíclica criada');
      setShowCreate(false);
      loadCounts();
    } else {
      const data = await res?.json();
      setMessage(data?.error || 'Falha ao criar contagem');
    }
  }

  const columns = [
    { key: 'count_id', label: 'ID', mono: true, render: (r) => `#${r.count_id}` },
    { key: 'bin_code', label: 'Endereço', mono: true },
    { key: 'status', label: 'Status', render: (r) => <StatusTag status={r.status} /> },
    { key: 'assigned_to', label: 'Atribuído a' },
    { key: 'lines', label: 'Materiais', render: (r) => r.lines?.length || 0 },
    { key: 'variance', label: 'Divergências', render: (r) => {
      const variances = (r.lines || []).filter((l) => l.variance && l.variance !== 0);
      return variances.length > 0
        ? <span style={{ color: 'var(--copper)', fontWeight: 600 }}>{variances.length}</span>
        : <span style={{ color: 'var(--text-secondary)' }}>0</span>;
    }},
    { key: 'created_at', label: 'Criado', mono: true, render: (r) => r.created_at ? new Date(r.created_at).toLocaleString() : '-' },
    { key: 'actions', label: '', render: (r) => (
      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setSelectedCount(r); }}>Ver</button>
    )},
  ];

  return (
    <div>
      <PageHeader title="Contagens cíclicas">
        <button className="btn btn-primary" onClick={openCreate}>Nova contagem</button>
      </PageHeader>

      {message && (
        <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--success)' }}>{message}</div>
      )}

      <DataTable rowKey="count_id" columns={columns} data={counts} emptyMessage="Nenhuma contagem cíclica encontrada" />

      {/* Create modal */}
      {showCreate && (
        <Modal
          title="Criar contagem cíclica"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowCreate(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={createCount} disabled={selectedBins.length === 0}>
                Criar contagem ({selectedBins.length} endereços)
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Selecione os endereços a contar:
          </p>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {bins.map((bin) => (
              <label key={bin.bin_id} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedBins.includes(bin.bin_id)}
                  onChange={() => toggleBin(bin.bin_id)}
                />
                <span className="mono">{bin.bin_code}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{bin.zone_name || ''}</span>
              </label>
            ))}
          </div>
        </Modal>
      )}

      {/* Detail modal */}
      {selectedCount && (
        <Modal
          title={`Contagem nº${selectedCount.count_id} - ${selectedCount.bin_code}`}
          onClose={() => setSelectedCount(null)}
          footer={<button className="btn" onClick={() => setSelectedCount(null)}>Fechar</button>}
        >
          <div style={{ marginBottom: 12 }}>
            <div className="detail-grid">
              <span className="detail-label">Status</span><span><StatusTag status={selectedCount.status} /></span>
              <span className="detail-label">Atribuído a</span><span>{selectedCount.assigned_to || '-'}</span>
              <span className="detail-label">Criado</span><span className="mono">{selectedCount.created_at ? new Date(selectedCount.created_at).toLocaleString() : '-'}</span>
              {selectedCount.completed_at && (
                <><span className="detail-label">Concluído</span><span className="mono">{new Date(selectedCount.completed_at).toLocaleString()}</span></>
              )}
            </div>
          </div>

          {selectedCount.lines?.length > 0 ? (
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>SKU</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>Material</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>Esperado</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>Contado</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>Divergência</th>
                </tr>
              </thead>
              <tbody>
                {selectedCount.lines.map((l) => {
                  const hasVariance = l.variance && l.variance !== 0;
                  return (
                    <tr key={l.count_line_id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="mono" style={{ padding: '6px 8px' }}>{l.sku}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{l.item_name}</td>
                      <td className="mono" style={{ padding: '6px 8px', textAlign: 'right' }}>{l.expected_quantity}</td>
                      <td className="mono" style={{ padding: '6px 8px', textAlign: 'right' }}>{l.counted_quantity ?? '-'}</td>
                      <td className="mono" style={{ padding: '6px 8px', textAlign: 'right', color: hasVariance ? 'var(--copper)' : 'var(--text-secondary)', fontWeight: hasVariance ? 600 : 400 }}>
                        {l.variance != null ? (l.variance > 0 ? `+${l.variance}` : l.variance) : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Nenhuma linha</p>
          )}
        </Modal>
      )}
    </div>
  );
}
