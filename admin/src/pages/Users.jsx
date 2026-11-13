import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';

const ROLES = ['ADMIN', 'USER'];

// Mobile app modules used by SEA (Expedição area): receiving and
// put-away. The other Sentry handheld modules are not part of SEA.
const ALL_FUNCTIONS = [
  { key: 'receive', label: 'Receber' },
  { key: 'putaway', label: 'Armazenagem' },
];

// Web page grants, grouped like the SEA menu. Keys match
// api/constants.py ALL_PAGE_KEYS. ADMIN users bypass the permission
// table server-side, so these only matter for USER accounts.
const PAGE_GROUPS = [
  {
    label: 'Estoque',
    pages: [
      { key: 'inventory', label: 'Visão Geral' },
      { key: 'items', label: 'Materiais' },
      { key: 'bins', label: 'Endereços' },
      { key: 'audit-log', label: 'Histórico' },
    ],
  },
  {
    label: 'Expedição',
    pages: [
      { key: 'receiving', label: 'Recebimento de Ordem' },
      { key: 'putaway', label: 'Armazenagem' },
      { key: 'purchase-orders', label: 'Ordens' },
    ],
  },
  {
    label: 'Retirada',
    pages: [
      { key: 'retirada', label: 'Fila de retirada e terminal' },
    ],
  },
  {
    label: 'Sistema',
    pages: [
      { key: 'users', label: 'Usuários' },
      { key: 'settings', label: 'Configurações' },
      { key: 'imports', label: 'Importação de dados' },
    ],
  },
];

const ALL_PAGE_KEYS = PAGE_GROUPS.flatMap((g) => g.pages.map((p) => p.key));

export default function Users() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  // mig 061: per-page web-admin grants. Edited inline alongside
  // the rest of the user form and saved via a follow-up PUT once the
  // user record itself lands.
  const [pagePermissions, setPagePermissions] = useState([]);

  useEffect(() => {
    loadUsers();
    loadWarehouses();
  }, []);

  async function loadUsers() {
    const res = await api.get('/admin/users');
    if (res?.ok) {
      const data = await res.json();
      setUsers(data.users || []);
    }
  }

  async function loadWarehouses() {
    const res = await api.get('/admin/warehouses', { silentPermissionDenied: true });
    if (res?.ok) {
      const data = await res.json();
      setWarehouses(data.warehouses || []);
    }
  }

  function openCreate() {
    setEditId(null);
    setForm({ role: 'USER', warehouse_ids: [], allowed_functions: [], is_active: true });
    setPagePermissions([]);
    setError('');
    setShowModal(true);
  }

  async function openEdit(user) {
    setEditId(user.user_id);
    setForm({
      ...user,
      password: '',
      warehouse_ids: user.warehouse_ids || [],
      allowed_functions: user.allowed_functions || [],
    });
    setError('');
    setShowModal(true);
    // Fetch the user's existing per-page grants so the modal can
    // populate the checkboxes. ADMINs return is_full_access=true
    // with the entire catalog, which we surface as "all checked".
    const res = await api.get(`/admin/users/${user.user_id}/permissions`);
    if (res?.ok) {
      const data = await res.json();
      setPagePermissions(data.page_keys || []);
    } else {
      setPagePermissions([]);
    }
  }

  function togglePagePermission(pageKey) {
    setPagePermissions((prev) => (
      prev.includes(pageKey)
        ? prev.filter((k) => k !== pageKey)
        : [...prev, pageKey]
    ));
  }

  function selectAllPagesInGroup(group) {
    setPagePermissions((prev) => {
      const next = new Set(prev);
      group.pages.forEach((p) => next.add(p.key));
      return Array.from(next);
    });
  }

  function clearPagesInGroup(group) {
    const groupKeys = new Set(group.pages.map((p) => p.key));
    setPagePermissions((prev) => prev.filter((k) => !groupKeys.has(k)));
  }

  function selectAllPages() {
    setPagePermissions([...ALL_PAGE_KEYS]);
  }

  function clearAllPages() {
    setPagePermissions([]);
  }

  async function save() {
    setError('');
    // UpdateUserRequest does not accept `username` (the user_id is in the
    // URL path, and V-017 extras=forbid rejects unknown fields). Only
    // include it on the create path where CreateUserRequest expects it.
    const body = {
      full_name: form.full_name,
      role: form.role,
      warehouse_ids: form.warehouse_ids || [],
      allowed_functions: form.allowed_functions || [],
      // Empty string clears the e-mail on edit; omitted on create when blank.
      email: (form.email || '').trim(),
    };
    if (!editId && !body.email) delete body.email;
    if (!editId) {
      body.username = form.username;
      body.password = form.password;
    } else if (form.password) {
      body.password = form.password;
    }
    const res = editId
      ? await api.put(`/admin/users/${editId}`, body)
      : await api.post('/admin/users', body);
    if (!res?.ok) {
      const data = await res?.json();
      setError(data?.error || 'Falha ao salvar');
      return;
    }
    // Persist per-page grants in a follow-up PUT. The endpoint is a
    // no-op for ADMIN targets (server bypasses the table), so calling
    // it unconditionally is safe. Resolve the user_id from the
    // create response when we just minted a new row.
    const userPayload = await res.json().catch(() => null);
    const savedUserId = editId || userPayload?.user_id;
    if (savedUserId) {
      const permRes = await api.put(
        `/admin/users/${savedUserId}/permissions`,
        { page_keys: pagePermissions },
      );
      if (!permRes?.ok) {
        const permData = await permRes?.json();
        setError(
          permData?.error || 'Usuário salvo, mas houve falha ao salvar as permissões de página',
        );
        return;
      }
    }
    setShowModal(false);
    loadUsers();
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null);

  async function deleteUser(id) {
    if (id === currentUser?.user_id) { setError('Você não pode excluir a si mesmo'); return; }
    setShowDeleteConfirm(id);
  }

  async function confirmDeleteUser() {
    const id = showDeleteConfirm;
    setShowDeleteConfirm(null);
    const res = await api.delete(`/admin/users/${id}`);
    if (res?.ok) {
      loadUsers();
    } else {
      const data = await res?.json();
      setError(data?.error || 'Falha ao excluir usuário');
    }
  }

  function toggleWarehouse(whId) {
    const ids = form.warehouse_ids || [];
    if (ids.includes(whId)) {
      setForm({ ...form, warehouse_ids: ids.filter((id) => id !== whId) });
    } else {
      setForm({ ...form, warehouse_ids: [...ids, whId] });
    }
  }

  function toggleFunction(fn) {
    const fns = form.allowed_functions || [];
    if (fns.includes(fn)) {
      setForm({ ...form, allowed_functions: fns.filter((f) => f !== fn) });
    } else {
      setForm({ ...form, allowed_functions: [...fns, fn] });
    }
  }

  function selectAllWarehouses() {
    setForm({
      ...form,
      warehouse_ids: warehouses.map((wh) => wh.warehouse_id),
    });
  }

  function clearWarehouses() {
    setForm({ ...form, warehouse_ids: [] });
  }

  function selectAllFunctions() {
    setForm({
      ...form,
      allowed_functions: ALL_FUNCTIONS.map((fn) => fn.key),
    });
  }

  function clearFunctions() {
    setForm({ ...form, allowed_functions: [] });
  }

  function warehouseCodes(warehouseIds) {
    if (!warehouseIds || warehouseIds.length === 0) return '-';
    return warehouseIds
      .map((id) => {
        const wh = warehouses.find((w) => w.warehouse_id === id);
        return wh ? wh.warehouse_code : id;
      })
      .join(', ');
  }

  const columns = [
    { key: 'username', label: 'Usuário', mono: true },
    { key: 'full_name', label: 'Nome completo' },
    { key: 'email', label: 'E-mail', render: (r) => r.email || '-' },
    { key: 'role', label: 'Função' },
    { key: 'warehouse_ids', label: 'Locais', render: (r) => warehouseCodes(r.warehouse_ids) },
    { key: 'actions', label: '', render: (r) => (
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openEdit(r); }} aria-label="Editar" title="Editar">&#9998;</button>
        {r.user_id !== currentUser?.user_id && (
          <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); deleteUser(r.user_id); }} aria-label="Excluir" title="Excluir">&#128465;</button>
        )}
      </div>
    )},
  ];

  return (
    <div>
      <PageHeader title="Usuários">
        <button className="btn btn-primary" onClick={openCreate}>Novo usuário</button>
      </PageHeader>
      <DataTable rowKey="user_id" columns={columns} data={users} emptyMessage="Nenhum usuário encontrado" />

      {showModal && (
        <Modal title={editId ? 'Editar usuário' : 'Novo usuário'} onClose={() => setShowModal(false)}
          size="wide"
          footer={
            <>
              <button className="btn" onClick={() => setShowModal(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={save}>Salvar</button>
            </>
          }
        >
          {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="form-row">
            <div className="form-group">
              <label>Usuário</label>
              <input className="form-input" value={form.username || ''} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Nome completo</label>
              <input className="form-input" value={form.full_name || ''} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="user-email">E-mail corporativo</label>
              <input id="user-email" className="form-input" type="email" value={form.email || ''} placeholder="nome@empresa.com"
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <div className="settings-note">Serve para entrar no terminal de retirada. Administradores recebem neste e-mail os avisos de retirada, recebimento e armazenamento.</div>
            </div>
          </div>
          <div className="form-group">
            <label>{editId ? 'Nova senha (deixe em branco para manter a atual)' : 'Senha'}</label>
            <input className="form-input" type="password" value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Função</label>
            <select className="form-select" value={form.role || ''} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="form-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label>Locais</label>
              {warehouses.length > 0 && (
                <span style={{ fontSize: 12 }}>
                  <button
                    type="button"
                    onClick={selectAllWarehouses}
                    style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                  >
                    Selecionar todos
                  </button>
                  <span style={{ color: 'var(--text-tertiary)', margin: '0 6px' }}>/</span>
                  <button
                    type="button"
                    onClick={clearWarehouses}
                    style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                  >
                    Limpar
                  </button>
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
              {warehouses.map((wh) => (
                <label key={wh.warehouse_id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(form.warehouse_ids || []).includes(wh.warehouse_id)}
                    onChange={() => toggleWarehouse(wh.warehouse_id)}
                  />
                  <span className="mono">{wh.warehouse_code}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{wh.warehouse_name}</span>
                </label>
              ))}
              {warehouses.length === 0 && <span style={{ color: 'var(--text-secondary)' }}>Nenhum local encontrado</span>}
            </div>
          </div>
          <div className="form-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label>Acesso aos módulos do app móvel</label>
              <span style={{ fontSize: 12 }}>
                <button
                  type="button"
                  onClick={selectAllFunctions}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                >
                  Selecionar todos
                </button>
                <span style={{ color: 'var(--text-tertiary)', margin: '0 6px' }}>/</span>
                <button
                  type="button"
                  onClick={clearFunctions}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                >
                  Limpar
                </button>
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '8px 0' }}>
              {ALL_FUNCTIONS.map((fn) => (
                <label key={fn.key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 100 }}>
                  <input
                    type="checkbox"
                    checked={(form.allowed_functions || []).includes(fn.key)}
                    onChange={() => toggleFunction(fn.key)}
                  />
                  {fn.label}
                </label>
              ))}
            </div>
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label>Acesso às páginas do painel web</label>
              <span style={{ fontSize: 12 }}>
                <button
                  type="button"
                  onClick={selectAllPages}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                >
                  Selecionar todos
                </button>
                <span style={{ color: 'var(--text-tertiary)', margin: '0 6px' }}>/</span>
                <button
                  type="button"
                  onClick={clearAllPages}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                >
                  Limpar
                </button>
              </span>
            </div>
            {form.role === 'ADMIN' ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
                A função ADMIN ignora as permissões de página - acesso total a todas as páginas do painel web.
              </p>
            ) : (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 12, padding: '8px 0',
              }}>
                {PAGE_GROUPS.map((group) => {
                  const groupKeys = new Set(group.pages.map((p) => p.key));
                  const grantedCount = pagePermissions.filter((k) => groupKeys.has(k)).length;
                  // The Overrides card carries an accent border so it
                  // reads as a grant of authority, not a page-access
                  // toggle. Granting an override is a different mental
                  // model from picking which pages a USER can open.
                  const cardStyle = group.isOverride
                    ? { padding: 10, borderLeft: '3px solid var(--copper)' }
                    : { padding: 10 };
                  return (
                    <div key={group.label} className="card" style={cardStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: group.isOverride ? 'var(--copper)' : undefined }}>
                          {group.label}
                        </strong>
                        <span style={{ fontSize: 11 }}>
                          <button
                            type="button"
                            onClick={() => selectAllPagesInGroup(group)}
                            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11 }}
                          >
                            Todos
                          </button>
                          <span style={{ color: 'var(--text-tertiary)', margin: '0 4px' }}>/</span>
                          <button
                            type="button"
                            onClick={() => clearPagesInGroup(group)}
                            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11 }}
                          >
                            Nenhum
                          </button>
                        </span>
                      </div>
                      {group.pages.map((p) => (
                        <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer', fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={pagePermissions.includes(p.key)}
                            onChange={() => togglePagePermission(p.key)}
                          />
                          {p.label}
                        </label>
                      ))}
                      {grantedCount > 0 && grantedCount < group.pages.length && (
                        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
                          {grantedCount} / {group.pages.length}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Modal>
      )}

      {showDeleteConfirm && (
        <Modal title="Excluir usuário" onClose={() => setShowDeleteConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setShowDeleteConfirm(null)}>Cancelar</button>
              <button className="btn btn-danger" onClick={confirmDeleteUser}>Excluir</button>
            </>
          }
        >
          <p style={{ fontSize: 14, marginBottom: 8 }}>Tem certeza? Esta ação não pode ser desfeita.</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>O usuário e todos os dados associados serão excluídos permanentemente.</p>
        </Modal>
      )}
    </div>
  );
}
