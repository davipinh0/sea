import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import TopBar from './TopBar.jsx';
import Sidebar from './Sidebar.jsx';
import Modal from './Modal.jsx';
import { useAuth } from '../auth.jsx';
import { reloadIfNewVersion } from '../utils/newVersion.js';

const PERM_POPUP_COOLDOWN_MS = 5000;

const SECTIONS = ['/estoque', '/expedicao'];

const PAGE_LABELS = {
  inventory: 'Estoque > Visão Geral', items: 'Estoque > Materiais', bins: 'Estoque > Endereços',
  zones: 'Estoque > Endereços', 'audit-log': 'Estoque > Histórico',
  receiving: 'Expedição > Recebimento de Ordem', putaway: 'Expedição > Armazenagem',
  'purchase-orders': 'Expedição > Ordens', retirada: 'Retirada', 'retirada-avaliar': 'Retirada',
  'retirada-fazer': 'Retirada', users: 'Sistema > Usuários',
  settings: 'Sistema > Configurações', imports: 'Sistema > Importação de dados',
  'material-catalog': 'Sistema > Cadastro de materiais',
  warehouses: 'Sistema > Configurações',
};

export default function Layout() {
  const { user } = useAuth();
  // Uma aba aberta antes de uma atualização mostraria telas antigas: recarrega uma vez quando o
  // servidor tem versão nova.
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => { reloadIfNewVersion(); }, [pathname]);
  // Page permissions (mig 061): catch global permission-denied events from
  // api.js and surface a "Permissions Error" modal. Lives on Layout so
  // it covers every page reached through the admin shell.
  //
  // Two debouncers keep the modal from spamming a USER browsing pages
  // they have partial access to:
  //   1. Don't replace an already-open modal - the operator dismisses
  //      one at a time; piling new ones underneath is confusing.
  //   2. After dismiss, suppress further popups for COOLDOWN_MS so a
  //      page that fires several permission_denied calls during mount
  //      shows the modal once total, not once per call.
  const [permError, setPermError] = useState(null);
  const dismissedAt = useRef(0);

  useEffect(() => {
    function onPermDenied(evt) {
      const now = Date.now();
      if (now - dismissedAt.current < PERM_POPUP_COOLDOWN_MS) return;
      // Functional setter so we read the latest state without listing
      // permError as a deps dependency (which would re-bind the listener
      // every render).
      setPermError((current) => current || (evt.detail || { page_key: null }));
    }
    window.addEventListener('sea:permission-denied', onPermDenied);
    return () => window.removeEventListener('sea:permission-denied', onPermDenied);
  }, []);

  function dismissPermError() {
    dismissedAt.current = Date.now();
    setPermError(null);
    const section = SECTIONS.find((s) => pathname === s || pathname.startsWith(`${s}/`));
    navigate(section || '/', { replace: true });
  }

  // When the user is stuck in a forced-change flow the only available
  // actions are the change-password form and logout, so drop the sidebar
  // entirely and widen the main column.
  const forced = !!user?.must_change_password;
  return (
    <div className={`app-layout${forced ? ' forced-change' : ''}`}>
      <TopBar forced={forced} />
      {!forced && <Sidebar />}
      <main className="content">
        <Outlet />
      </main>
      {permError && (
        <Modal
          title="Erro de permissão"
          onClose={dismissPermError}
          footer={
            <button className="btn btn-primary" onClick={dismissPermError}>
              OK
            </button>
          }
        >
          <p style={{ fontSize: 14, marginBottom: 12 }}>
            Você não tem permissão para acessar este recurso.
          </p>
          {permError.page_key && (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
              Página: {PAGE_LABELS[permError.page_key] || permError.page_key}
            </p>
          )}
          <p style={{ fontSize: 13 }}>
            Contate um administrador se precisar de acesso.
          </p>
        </Modal>
      )}
    </div>
  );
}
