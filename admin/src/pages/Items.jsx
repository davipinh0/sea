import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';

const FILTER_OPTIONS = [
  { label: 'Ativo', value: 'active' },
  { label: 'Arquivados', value: 'archived' },
  { label: 'Todos', value: 'all' },
];

export default function Items() {
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [filter, setFilter] = useState('active');
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');

  // Debounce typed search and guard against out-of-order responses.
  // Each run owns an AbortController; the cleanup cancels a pending
  // debounce timer (rapid typing) AND aborts an in-flight request (a
  // superseded query), so only the latest query's response reaches
  // setItems. Without this, slow broad-prefix queries (e.g. "1" matches
  // 23k items) resolve late and overwrite the narrow result, leaving
  // stale "floater" rows from earlier keystrokes. Page/filter changes
  // are discrete clicks, so they fire immediately (no debounce delay).
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => loadItems(controller.signal), search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [page, search, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // signal is supplied by the debounced effect so a superseded query
  // aborts mid-flight. The mutation handlers (save/delete/archive) call
  // loadItems() with no signal and refetch unconditionally.
  async function loadItems(signal) {
    const params = new URLSearchParams({ page, per_page: 50 });
    if (search) params.set('q', search);
    if (filter === 'active') params.set('active', 'true');
    else if (filter === 'archived') params.set('active', 'false');
    let res;
    try {
      res = await api.get(`/admin/items?${params}`, { signal });
    } catch (err) {
      if (err?.name === 'AbortError') return; // superseded by a newer query
      throw err;
    }
    if (res?.ok) {
      const data = await res.json();
      const mapped = (data.items || []).map((item) => ({
        ...item,
        id: item.id || item.item_id,
      }));
      setItems(mapped);
      setPagination({ page: data.page, pages: data.pages, total: data.total, per_page: data.per_page });
    }
  }

  async function viewItem(item) {
    const res = await api.get(`/admin/items/${item.id}`);
    if (res?.ok) {
      const data = await res.json();
      const itemData = data.item || data;
      setDetail({
        ...itemData,
        id: itemData.id || itemData.item_id,
        inventory: data.inventory || itemData.inventory || [],
        preferred_bins: data.preferred_bins || itemData.preferred_bins || [],
      });
    }
  }

  function openCreate() {
    setEditId(null);
    setForm({ is_active: true });
    setError('');
    setShowModal(true);
  }

  function openEdit(item) {
    setEditId(item.id || item.item_id);
    setForm({ ...item, id: item.id || item.item_id });
    setError('');
    setShowModal(true);
  }

  async function save() {
    setError('');
    const body = {
      sku: form.sku,
      item_name: form.item_name,
      upc: form.upc || null,
      mpn: form.mpn || null,
      category: form.category || null,
      weight_lbs: (form.weight_lbs || form.weight) ? Number(form.weight_lbs || form.weight) : null,
      default_bin_id: form.default_bin_id ? Number(form.default_bin_id) : null,
    };
    const res = editId
      ? await api.put(`/admin/items/${editId}`, body)
      : await api.post('/admin/items', body);
    if (res?.ok) {
      setShowModal(false);
      setDetail(null);
      loadItems();
    } else {
      const data = await res?.json();
      setError(data?.error || 'Falha ao salvar');
    }
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null);

  async function deleteItem(id) {
    setShowDeleteConfirm(id);
  }

  async function confirmDeleteItem() {
    const id = showDeleteConfirm;
    setShowDeleteConfirm(null);
    const res = await api.delete(`/admin/items/${id}`);
    if (res?.ok) {
      setDetail(null);
      setShowModal(false);
      loadItems();
    } else {
      const data = await res?.json();
      setError(data?.error || 'Falha ao excluir material');
    }
  }

  async function toggleArchive(item) {
    const res = await api.post(`/admin/items/${item.id}/archive`);
    if (res?.ok) {
      setDetail(null);
      loadItems();
    } else {
      const data = await res?.json();
      setError(data?.error || 'Falha ao atualizar material');
    }
  }

  const columns = [
    { key: 'sku', label: 'SKU', mono: true },
    { key: 'item_name', label: 'Nome do material' },
    { key: 'upc', label: 'UPC', mono: true, render: (r) => r.upc || '-' },
    { key: 'mpn', label: 'MPN', mono: true, render: (r) => r.mpn || '-' },
    { key: 'default_bin_code', label: 'Endereço padrão', mono: true, render: (r) => r.default_bin_code || '\u2013' },
    { key: 'category', label: 'Categoria', render: (r) => r.category || '-' },
    { key: 'weight_lbs', label: 'Peso', render: (r) => r.weight_lbs ? `${r.weight_lbs} lb` : '-' },
    { key: 'is_active', label: 'Ativo', render: (r) => r.is_active ? 'Sim' : 'Não' },
    { key: 'actions', label: '', render: (r) => (
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openEdit(r); }} aria-label="Editar" title="Editar">&#9998;</button>
        <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); deleteItem(r.id || r.item_id); }} aria-label="Excluir" title="Excluir">&#128465;</button>
      </div>
    )},
  ];

  const invCols = [
    { key: 'bin_code', label: 'Endereço', mono: true },
    { key: 'quantity_on_hand', label: 'Em estoque' },
    { key: 'quantity_allocated', label: 'Alocado' },
  ];

  return (
    <div>
      <PageHeader title="Materiais">
        <button className="btn btn-primary" onClick={openCreate}>Novo material</button>
      </PageHeader>
      <div className="filter-bar">
        <input className="form-input" placeholder="Buscar por SKU, nome, UPC ou MPN..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <select
          className="form-select"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(1); }}
          style={{ width: 'auto', minWidth: 120 }}
        >
          {FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <DataTable rowKey="item_id" columns={columns} data={items} pagination={pagination} onPageChange={setPage} onRowClick={viewItem} />

      {detail && !showModal && (
        <Modal title={detail.item_name || detail.sku} onClose={() => setDetail(null)}
          footer={<button className="btn" onClick={() => setDetail(null)}>Fechar</button>}
        >
          <div className="detail-grid">
            <span className="detail-label">SKU</span><span className="mono">{detail.sku}</span>
            <span className="detail-label">UPC</span><span className="mono">{detail.upc || '-'}</span>
            <span className="detail-label">MPN</span><span className="mono">{detail.mpn || '-'}</span>
            <span className="detail-label">Categoria</span><span>{detail.category || '-'}</span>
            <span className="detail-label">Peso</span><span>{(detail.weight_lbs || detail.weight) ? `${detail.weight_lbs || detail.weight} lb` : '-'}</span>
            <span className="detail-label">Ativo</span><span>{detail.is_active ? 'Sim' : 'Não'}</span>
          </div>
          {detail.preferred_bins && detail.preferred_bins.length > 0 && (
            <>
              <div className="section-title">Endereços preferenciais</div>
              <DataTable rowKey="preferred_bin_id" columns={[
                { key: 'bin_code', label: 'Endereço', mono: true },
                { key: 'zone_name', label: 'Zona' },
                { key: 'priority', label: 'Prioridade' },
              ]} data={detail.preferred_bins} />
            </>
          )}
          {detail.inventory && detail.inventory.length > 0 && (
            <>
              <div className="section-title">Localizações no estoque</div>
              <DataTable rowKey="inventory_id" columns={invCols} data={detail.inventory} />
            </>
          )}
        </Modal>
      )}

      {showModal && (
        <Modal title={editId ? 'Editar material' : 'Novo material'} onClose={() => setShowModal(false)}
          footer={
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {editId && (
                  <button className="btn btn-sm" onClick={() => toggleArchive(form)}>
                    {form.is_active ? 'Arquivar' : 'Restaurar'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn" onClick={() => setShowModal(false)}>Cancelar</button>
                <button className="btn btn-primary" onClick={save}>Salvar</button>
              </div>
            </div>
          }
        >
          {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="form-row">
            <div className="form-group">
              <label>SKU</label>
              <input className="form-input" value={form.sku || ''} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </div>
            <div className="form-group">
              <label>UPC</label>
              <input className="form-input" value={form.upc || ''} onChange={(e) => setForm({ ...form, upc: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>MPN</label>
            <input className="form-input" value={form.mpn || ''} onChange={(e) => setForm({ ...form, mpn: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Nome do material</label>
            <input className="form-input" value={form.item_name || ''} onChange={(e) => setForm({ ...form, item_name: e.target.value })} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Categoria</label>
              <input className="form-input" value={form.category || ''} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Peso (lb)</label>
              <input className="form-input" type="number" step="0.01" value={form.weight_lbs ?? form.weight ?? ''} onChange={(e) => setForm({ ...form, weight_lbs: e.target.value, weight: e.target.value })} />
            </div>
          </div>
        </Modal>
      )}

      {showDeleteConfirm && (
        <Modal title="Excluir material" onClose={() => setShowDeleteConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setShowDeleteConfirm(null)}>Cancelar</button>
              <button className="btn btn-danger" onClick={confirmDeleteItem}>Excluir</button>
            </>
          }
        >
          <p style={{ fontSize: 14, marginBottom: 8 }}>Tem certeza? Esta ação não pode ser desfeita.</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>O material e todos os dados associados serão excluídos permanentemente.</p>
        </Modal>
      )}
    </div>
  );
}
