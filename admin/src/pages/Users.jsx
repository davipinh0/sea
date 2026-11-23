import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import DataTable from '../components/DataTable.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import UserAvatar from '../components/UserAvatar.jsx';
import UserPhotoField from '../components/UserPhotoField.jsx';
import LoginApprovalField from '../components/LoginApprovalField.jsx';
import { releaseOnPhone } from '../utils/phoneRelease.js';
import { readError } from '../utils/sea.js';

const ROLES = ['ADMIN', 'USER'];

export const ALL_FUNCTIONS = [
  { key: 'receive', label: 'Receber' },
  { key: 'putaway', label: 'Armazenagem' },
];

// As permissões só valem para usuários comuns; o administrador passa direto.
export const PAGE_GROUPS = [
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
      { key: 'retirada', label: 'Solicitar retirada (terminal)' },
      { key: 'retirada-avaliar', label: 'Avaliar retirada (aprovar ou negar)' },
      { key: 'retirada-fazer', label: 'Fazer retirada (aceitar e separar)' },
      { key: 'terminal-retirada', label: 'Terminal de retirada (usuário só do terminal, sem outras permissões)' },
    ],
  },
  {
    label: 'Sistema',
    pages: [
      { key: 'users', label: 'Usuários' },
      { key: 'settings', label: 'Configurações' },
      { key: 'material-catalog', label: 'Cadastro de materiais' },
      { key: 'imports', label: 'Importação de dados' },
    ],
  },
  {
    label: 'Permissões extras',
    isOverride: true,
    pages: [
      { key: 'export-csv', label: 'Exportar CSV' },
    ],
  },
];

// Mesmas regras da API (auth_service.validate_password).
const PASSWORD_RULES = 'A senha precisa ter pelo menos 8 caracteres, com ao menos uma letra e um número.';

function passwordProblem(password) {
  if (password.trim().toLowerCase() === 'admin') return "A senha não pode ser 'admin'.";
  if (password.length < 8) return `Senha muito fraca: tem ${password.length} caractere(s) e precisa de pelo menos 8.`;
  if (!/\p{L}/u.test(password)) return 'Senha muito fraca: falta pelo menos uma letra.';
  if (!/\d/.test(password)) return 'Senha muito fraca: falta pelo menos um número.';
  return null;
}

function userFormProblems(form, { creating, pagePermissions = [] }) {
  const problems = {};
  const text = (v) => (v || '').trim();
  if (creating && !text(form.username)) problems.username = 'Informe o nome de usuário.';
  else if (creating && /\s/.test(text(form.username))) problems.username = 'O nome de usuário não pode ter espaços.';
  if (!text(form.full_name)) problems.full_name = 'Informe o nome completo.';
  if (text(form.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text(form.email))) {
    problems.email = 'E-mail inválido. Use o formato nome@empresa.com.';
  }
  const password = form.password || '';
  if (creating && !password) problems.password = `Informe a senha. ${PASSWORD_RULES}`;
  else if (password && passwordProblem(password)) problems.password = passwordProblem(password);
  if (!(form.warehouse_ids || []).length) problems.warehouses = 'Selecione pelo menos um local.';
  if (form.role !== 'ADMIN' && !pagePermissions.length && !(form.allowed_functions || []).length) {
    problems.access = 'Selecione pelo menos uma página do painel ou um módulo do app: sem isso o usuário entra e não vê nada.';
  }
  return problems;
}

const FIELD_LABELS = {
  username: 'Usuário', full_name: 'Nome completo', email: 'E-mail', password: 'Senha',
  warehouses: 'Locais', access: 'Acessos',
};
const API_FIELDS = { username: 'username', full_name: 'full_name', email: 'email', password: 'password', warehouse_ids: 'warehouses', role: 'role' };
const API_PASSWORD_ERRORS = {
  "Password cannot be 'admin'": "A senha não pode ser 'admin'.",
  'Password must be at least 8 characters': 'Senha muito fraca: precisa de pelo menos 8 caracteres.',
  'Password must contain at least one letter': 'Senha muito fraca: falta pelo menos uma letra.',
  'Password must contain at least one digit': 'Senha muito fraca: falta pelo menos um número.',
};

function apiProblems(data) {
  const error = data?.error;
  if (API_PASSWORD_ERRORS[error]) return { password: API_PASSWORD_ERRORS[error] };
  if (typeof error === 'string' && error.startsWith('Nome de usuário duplicado')) {
    return { username: 'Já existe um usuário com esse nome. Escolha outro.' };
  }
  if (typeof error === 'string' && error.startsWith('E-mail já cadastrado')) {
    return { email: 'Esse e-mail já está cadastrado para outro usuário.' };
  }
  if (error === 'validation_error' && Array.isArray(data.details)) {
    const problems = {};
    for (const d of data.details) {
      const field = API_FIELDS[d.loc?.[0]];
      if (field && FIELD_LABELS[field]) problems[field] = `O campo ${FIELD_LABELS[field]} está vazio ou com valor inválido.`;
    }
    if (Object.keys(problems).length) return problems;
  }
  return { form: typeof error === 'string' && error !== 'validation_error' ? error : 'Não foi possível salvar. Confira os campos e tente novamente.' };
}

function FieldError({ message }) {
  return message ? <div className="form-error" role="alert">{message}</div> : null;
}

const ALL_PAGE_KEYS = PAGE_GROUPS.flatMap((g) => g.pages.map((p) => p.key));

export default function Users() {
  const { user: currentUser, refreshUser } = useAuth();
  const isAdmin = currentUser?.role === 'ADMIN';
  // Quem não é administrador gerencia só usuários comuns e não mexe nas próprias permissões (a
  // API também recusa).
  const canManage = (u) => isAdmin || u?.role !== 'ADMIN';
  const [users, setUsers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const ownPermissionsLocked = !isAdmin && editId === currentUser?.user_id;
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [problems, setProblems] = useState({});
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
    setProblems({});
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
    setProblems({});
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
    const found = userFormProblems(form, { creating: !editId, pagePermissions });
    setProblems(found);
    if (Object.keys(found).length) return;
    // UpdateUserRequest does not accept `username` (the user_id is in the
    // URL path, and V-017 extras=forbid rejects unknown fields). Only
    // include it on the create path where CreateUserRequest expects it.
    const body = {
      full_name: (form.full_name || '').trim(),
      role: isAdmin ? form.role : 'USER',
      warehouse_ids: form.warehouse_ids || [],
      allowed_functions: form.allowed_functions || [],
      // Texto vazio apaga o e-mail na edição; no cadastro, em branco não é enviado.
      email: (form.email || '').trim(),
      web_login_approval: !!form.web_login_approval,
    };
    if (!editId && !body.email) delete body.email;
    if (!editId) {
      body.username = (form.username || '').trim();
      body.password = form.password;
    } else if (form.password) {
      body.password = form.password;
    }
    const res = editId
      ? await api.put(`/admin/users/${editId}`, body)
      : await api.post('/admin/users', body);
    if (!res) return;
    if (!res.ok) {
      const refused = apiProblems(await res.json().catch(() => null));
      setProblems(refused);
      return;
    }
    // Persist per-page grants in a follow-up PUT. The endpoint is a
    // no-op for ADMIN targets (server bypasses the table), so calling
    // it unconditionally is safe. Resolve the user_id from the
    // create response when we just minted a new row.
    const userPayload = await res.json().catch(() => null);
    const savedUserId = editId || userPayload?.user_id;
    if (savedUserId && !ownPermissionsLocked) {
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
  // Excluir pede a confirmação no celular de quem exclui, a cada exclusão.
  const [deleteMsg, setDeleteMsg] = useState('');
  const [deleteLeft, setDeleteLeft] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const deleteCancelled = useRef(false);

  async function deleteUser(id) {
    if (id === currentUser?.user_id) { setError('Você não pode excluir a si mesmo'); return; }
    setDeleteMsg('');
    setDeleteLeft(null);
    setShowDeleteConfirm(id);
  }

  function closeDelete() {
    deleteCancelled.current = true;
    setShowDeleteConfirm(null);
    setDeleteLeft(null);
    setDeleting(false);
  }

  async function confirmDeleteUser() {
    const id = showDeleteConfirm;
    deleteCancelled.current = false;
    setDeleteMsg('');
    setDeleting(true);
    let res = await api.delete(`/admin/users/${id}`);
    const peek = res?.status === 403 ? await res.clone().json().catch(() => ({})) : {};
    if (peek.step_up_required) {
      try {
        await releaseOnPhone('exclusao-usuario', { onWaiting: setDeleteLeft, isCancelled: () => deleteCancelled.current });
      } catch (err) {
        if (!deleteCancelled.current) { setDeleteMsg(err.message); setDeleteLeft(null); setDeleting(false); }
        return;
      }
      setDeleteLeft(null);
      res = await api.delete(`/admin/users/${id}`);
    }
    setDeleting(false);
    if (!res) return;
    if (res.ok) {
      setShowDeleteConfirm(null);
      loadUsers();
      return;
    }
    setDeleteMsg(await readError(res, 'Não foi possível excluir o usuário.'));
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

  function photoChanged(version) {
    setForm((current) => ({ ...current, photo_version: version }));
    setUsers((list) => list.map((u) => (u.user_id === editId ? { ...u, photo_version: version } : u)));
    if (editId === currentUser?.user_id) refreshUser();
  }

  const columns = [
    { key: 'photo', label: '', render: (r) => (
      <UserAvatar userId={r.user_id} version={r.photo_version} name={r.full_name || r.username} size={30} />
    )},
    { key: 'username', label: 'Usuário', mono: true },
    { key: 'full_name', label: 'Nome completo' },
    { key: 'email', label: 'E-mail', render: (r) => r.email || '-' },
    { key: 'role', label: 'Função' },
    { key: 'warehouse_ids', label: 'Locais', render: (r) => warehouseCodes(r.warehouse_ids) },
    { key: 'actions', label: '', render: (r) => (
      canManage(r) ? (
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openEdit(r); }} aria-label="Editar" title="Editar">&#9998;</button>
        {r.user_id !== currentUser?.user_id && (
          <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); deleteUser(r.user_id); }} aria-label="Excluir" title="Excluir">&#128465;</button>
        )}
      </div>
      ) : <span className="settings-note" title="Só um administrador altera outro administrador">Administrador</span>
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
          {Object.keys(problems).length > 0 && (
            <div className="form-problems" role="alert">
              <strong>O usuário não foi salvo. Corrija:</strong>
              <ul>
                {Object.entries(problems).map(([field, message]) => (
                  <li key={field}>{FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ` : ''}{message}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="user-username">Usuário *</label>
              <input id="user-username" className={`form-input${problems.username ? ' input-invalid' : ''}`} disabled={!!editId} value={form.username || ''} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              <FieldError message={problems.username} />
            </div>
            <div className="form-group">
              <label htmlFor="user-full-name">Nome completo *</label>
              <input id="user-full-name" className={`form-input${problems.full_name ? ' input-invalid' : ''}`} value={form.full_name || ''} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
              <FieldError message={problems.full_name} />
            </div>
            <div className="form-group">
              <label htmlFor="user-email">E-mail corporativo</label>
              <input id="user-email" className={`form-input${problems.email ? ' input-invalid' : ''}`} type="email" value={form.email || ''} placeholder="nome@empresa.com"
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <FieldError message={problems.email} />
              <div className="settings-note">Serve para entrar no terminal de retirada. Administradores recebem neste e-mail os avisos de retirada, recebimento e armazenamento.</div>
            </div>
          </div>
          {isAdmin && editId && (
            <UserPhotoField userId={editId} name={form.full_name || form.username} version={form.photo_version} onChanged={photoChanged} />
          )}
          {isAdmin && !editId && (
            <div className="settings-note" style={{ marginBottom: 12 }}>A foto é colocada depois de salvar: abra o usuário de novo para escolher a foto.</div>
          )}
          <div className="form-group">
            <label htmlFor="user-password">{editId ? 'Nova senha (deixe em branco para manter a atual)' : 'Senha *'}</label>
            <input id="user-password" className={`form-input${problems.password ? ' input-invalid' : ''}`} type="password" value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <div className="settings-note">{PASSWORD_RULES}</div>
            <FieldError message={problems.password} />
          </div>
          <LoginApprovalField
            userId={editId} enabled={form.web_login_approval}
            onToggle={(value) => setForm({ ...form, web_login_approval: value })}
          />
          {isAdmin && (
            <div className="form-group">
              <label htmlFor="user-role">Função</label>
              <select id="user-role" className="form-select" value={form.role || ''} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label>Locais *</label>
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
            <FieldError message={problems.warehouses} />
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
              <FieldError message={problems.access} />
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
            {ownPermissionsLocked ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
                As suas próprias permissões só podem ser mudadas por um administrador.
              </p>
            ) : form.role === 'ADMIN' ? (
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
        <Modal title="Excluir usuário" onClose={closeDelete}
          footer={
            <>
              <button className="btn" onClick={closeDelete}>Cancelar</button>
              <button className="btn btn-danger" disabled={deleting} onClick={confirmDeleteUser}>{deleting ? 'Aguardando…' : 'Excluir'}</button>
            </>
          }
        >
          <p style={{ fontSize: 14, marginBottom: 8 }}>
            Excluir <strong>{users.find((u) => u.user_id === showDeleteConfirm)?.full_name || users.find((u) => u.user_id === showDeleteConfirm)?.username}</strong>? Esta ação não pode ser desfeita.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>O acesso do usuário é removido. O histórico (recebimentos, retiradas e log) continua, com o nome dele.</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Por segurança, a exclusão é confirmada no app SEA do seu celular, com a digital ou a senha do celular.</p>
          {deleteLeft !== null && (
            <div className="login-approval" role="status">
              <p>Abra o app SEA no seu celular e toque em <strong>SIM, SOU EU</strong>.</p>
              <p className="login-approval-time">Tempo restante: {Math.floor(deleteLeft / 60)}:{String(deleteLeft % 60).padStart(2, '0')}</p>
            </div>
          )}
          {deleteMsg && <div className="form-error" role="alert">{deleteMsg}</div>}
        </Modal>
      )}
    </div>
  );
}
