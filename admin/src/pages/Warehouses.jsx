import { useState, useEffect } from 'react';
import { api } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';

export default function Warehouses() {
  const [warehouses, setWarehouses] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => { loadWarehouses(); }, []);

  async function loadWarehouses() {
    const res = await api.get('/admin/warehouses');
    if (res?.ok) {
      const data = await res.json();
      setWarehouses(data.warehouses || []);
    }
  }

  function openCreate() {
    setEditId(null);
    setForm({});
    setError('');
    setShowModal(true);
  }

  function openEdit(wh) {
    setEditId(wh.warehouse_id);
    setForm({ warehouse_code: wh.warehouse_code, warehouse_name: wh.warehouse_name, address: wh.address, is_active: wh.is_active });
    setError('');
    setShowModal(true);
  }

  async function save() {
    setError('');
    if (!form.warehouse_name) { setError('O nome é obrigatório'); return; }
    if (!editId && !form.warehouse_code) { setError('O código é obrigatório'); return; }
    const res = editId
      ? await api.put(`/admin/warehouses/${editId}`, { warehouse_name: form.warehouse_name, address: form.address, is_active: form.is_active })
      : await api.post('/admin/warehouses', { warehouse_code: form.warehouse_code, warehouse_name: form.warehouse_name, address: form.address });
    if (res?.ok) {
      setShowModal(false);
      loadWarehouses();
    } else {
      const data = await res?.json();
      setError(data?.error || 'Falha ao salvar');
    }
  }

  async function deleteWarehouse(id) {
    setError('');
    const res = await api.delete(`/admin/warehouses/${id}`);
    if (res?.ok) {
      setConfirmDelete(null);
      loadWarehouses();
    } else {
      const data = await res?.json();
      setConfirmDelete(null);
      setError(data?.error || 'Falha ao excluir armazém');
    }
  }

  const columns = [
    { key: 'warehouse_code', label: 'Código', mono: true },
    { key: 'warehouse_name', label: 'Nome' },
    { key: 'address', label: 'Endereço postal' },
    { key: 'is_active', label: 'Ativo', render: (r) => r.is_active ? 'Sim' : 'Não' },
    { key: 'actions', label: '', render: (r) => (
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openEdit(r); }} aria-label="Editar" title="Editar">&#9998;</button>
        <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); setConfirmDelete(r); }} aria-label="Excluir" title="Excluir">&#128465;</button>
      </div>
    )},
  ];

  return (
    <div>
      <PageHeader title="Armazéns">
        <button className="btn btn-primary" onClick={openCreate}>Novo armazém</button>
      </PageHeader>

      {error && (
        <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>
      )}

      <DataTable rowKey="warehouse_id" columns={columns} data={warehouses} emptyMessage="Nenhum armazém encontrado" />

      {showModal && (
        <Modal
          title={editId ? 'Editar armazém' : 'Novo armazém'}
          onClose={() => setShowModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowModal(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={save}>Salvar</button>
            </>
          }
        >
          {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
          {!editId && (
            <div className="form-group">
              <label>Código</label>
              <input className="form-input" value={form.warehouse_code || ''} onChange={(e) => setForm({ ...form, warehouse_code: e.target.value })} />
            </div>
          )}
          <div className="form-group">
            <label>Nome</label>
            <input className="form-input" value={form.warehouse_name || ''} onChange={(e) => setForm({ ...form, warehouse_name: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Endereço postal</label>
            <input className="form-input" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          {editId && (
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.is_active === false} onChange={(e) => setForm({ ...form, is_active: !e.target.checked })} />
                Inativo
              </label>
            </div>
          )}
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="Confirmar exclusão"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancelar</button>
              <button className="btn btn-primary" style={{ background: 'var(--copper)' }} onClick={() => deleteWarehouse(confirmDelete.warehouse_id)}>Excluir</button>
            </>
          }
        >
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>Tem certeza? Isto exclui permanentemente o armazém. Não há como desfazer.</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>Para desativar um armazém temporariamente, use a caixa Inativo em Editar.</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>
            Armazém: <span className="mono">{confirmDelete.warehouse_code}</span> &mdash; {confirmDelete.warehouse_name}
          </p>
        </Modal>
      )}
    </div>
  );
}
