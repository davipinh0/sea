import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Layout from './components/Layout.jsx';
import SectionTabs from './components/SectionTabs.jsx';
import { canSee, isTerminalAccount, TERMINAL_PAGE } from './utils/permissions.js';
import { useWarehouse } from './warehouse.jsx';
import { EXPEDICAO_CODE } from './utils/sea.js';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Painel from './pages/Painel.jsx';
import EstoqueSP12 from './pages/EstoqueSP12.jsx';
import Items from './pages/Items.jsx';
import Bins from './pages/Bins.jsx';
import AuditLog from './pages/AuditLog.jsx';
import RecebimentoOT from './pages/RecebimentoOT.jsx';
import BaseSap from './pages/BaseSap.jsx';
import ArmazenagemSP12 from './pages/ArmazenagemSP12.jsx';
import PurchaseOrders from './pages/PurchaseOrders.jsx';
import Retirada from './pages/Retirada.jsx';
import ProcessGate from './components/ProcessGate.jsx';
import TerminalRetirada from './pages/TerminalRetirada.jsx';
import TerminalInicio from './pages/TerminalInicio.jsx';
import Users from './pages/Users.jsx';
import Settings from './pages/Settings.jsx';
import Imports from './pages/Imports.jsx';
import CadastroMateriais from './pages/CadastroMateriais.jsx';

// As sub-páginas mantêm a permissão dos seus endpoints.
const ESTOQUE_TABS = [
  { to: 'sp12', label: 'Visão Geral', pageKey: 'inventory' },
  { to: 'materiais', label: 'Materiais', pageKey: 'items' },
  { to: 'enderecos', label: 'Endereços', pageKey: 'bins' },
  { to: 'historico', label: 'Histórico', pageKey: 'audit-log' },
];

const EXPEDICAO_TABS = [
  { to: 'recebimento', label: 'Recebimento de Ordem', pageKey: 'receiving' },
  { to: 'armazenagem', label: 'Armazenagem', pageKey: 'putaway' },
  { to: 'ots', label: 'Ordens', pageKey: 'purchase-orders' },
  { to: 'base-sap', label: 'SAP', pageKey: 'receiving' },
];

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  // Forced password change: block everything except the change-password
  // page until the server-side flag clears. The /api/auth/me response is
  // the source of truth; flipping the admin UI client-side would not
  // actually let the user past the middleware's 403 anyway.
  if (user.must_change_password && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (isTerminalAccount(user) && !TERMINAL_PATHS.has(location.pathname)) {
    return <Navigate to="/retirada" replace />;
  }
  return children;
}

const TERMINAL_PATHS = new Set(['/retirada', '/retirada/terminal', '/change-password']);

function RetiradaPage() {
  const { user } = useAuth();
  if (isTerminalAccount(user)) return <TerminalInicio />;
  return (
    <RequirePage pageKeys={WITHDRAWAL_PAGES}>
      <ProcessGate purpose="retirada" label="Retirada"><Retirada /></ProcessGate>
    </RequirePage>
  );
}

// Página aberta pela URL sem permissão volta ao Painel (a API recusaria de qualquer jeito). A
// Expedição só existe no local Expedição.
function OnlyAtExpedicao({ children }) {
  const { warehouse } = useWarehouse();
  if (warehouse && warehouse.warehouse_code !== EXPEDICAO_CODE) return <Navigate to="/" replace />;
  return children;
}

function RequirePage({ pageKey, pageKeys, children }) {
  const { user } = useAuth();
  const keys = pageKeys || [pageKey];
  return keys.some((key) => canSee(user, key)) ? children : <Navigate to="/" replace />;
}

const WITHDRAWAL_PAGES = ['retirada', 'retirada-avaliar', 'retirada-fazer'];

function page(element, fallbackMessage) {
  return <ErrorBoundary fallbackMessage={fallbackMessage}>{element}</ErrorBoundary>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Terminal em tela cheia, sem o menu do painel. Abre com o usuário do terminal ou um
         administrador.
      */}
      <Route
        path="/retirada/terminal"
        element={page(
          <ProtectedRoute><RequirePage pageKey={TERMINAL_PAGE}><TerminalRetirada /></RequirePage></ProtectedRoute>,
          'Não foi possível carregar o terminal de retirada.',
        )}
      />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/change-password" element={page(<ChangePassword />, 'Não foi possível carregar a troca de senha.')} />
        <Route path="/" element={page(<Painel />, 'Não foi possível carregar o painel.')} />

        <Route path="/estoque" element={page(<SectionTabs basePath="/estoque" tabs={ESTOQUE_TABS} />, 'Não foi possível carregar o estoque.')}>
          <Route path="sp12" element={<EstoqueSP12 />} />
          <Route path="materiais" element={<Items />} />
          <Route path="enderecos" element={<Bins />} />
          <Route path="historico" element={<AuditLog />} />
        </Route>

        <Route path="/expedicao" element={page(<OnlyAtExpedicao><SectionTabs basePath="/expedicao" tabs={EXPEDICAO_TABS} /></OnlyAtExpedicao>, 'Não foi possível carregar a expedição.')}>
          <Route path="recebimento" element={<ProcessGate purpose="recebimento" label="Recebimento"><RecebimentoOT /></ProcessGate>} />
          <Route path="armazenagem" element={<ProcessGate purpose="armazenagem" label="Armazenagem"><ArmazenagemSP12 /></ProcessGate>} />
          <Route path="ots" element={<PurchaseOrders />} />
          <Route path="base-sap" element={<BaseSap />} />
        </Route>

        <Route path="/retirada" element={page(<RetiradaPage />, 'Não foi possível carregar a retirada.')} />

        <Route path="/users" element={page(<RequirePage pageKey="users"><Users /></RequirePage>, 'Não foi possível carregar os usuários.')} />
        <Route path="/settings" element={page(<RequirePage pageKey="settings"><Settings /></RequirePage>, 'Não foi possível carregar as configurações.')} />
        <Route path="/cadastro-materiais" element={page(<RequirePage pageKey="material-catalog"><CadastroMateriais /></RequirePage>, 'Não foi possível carregar o cadastro de materiais.')} />
        <Route path="/imports" element={page(<RequirePage pageKey="imports"><Imports /></RequirePage>, 'Não foi possível carregar a importação.')} />

        {/* Endereços antigos que ainda levam a algum lugar. */}
        <Route path="/inventory" element={<Navigate to="/estoque/sp12" replace />} />
        <Route path="/items" element={<Navigate to="/estoque/materiais" replace />} />
        <Route path="/bins" element={<Navigate to="/estoque/enderecos" replace />} />
        <Route path="/audit-log" element={<Navigate to="/estoque/historico" replace />} />
        <Route path="/receiving" element={<Navigate to="/expedicao/recebimento" replace />} />
        <Route path="/putaway" element={<Navigate to="/expedicao/armazenagem" replace />} />
        <Route path="/purchase-orders" element={<Navigate to="/expedicao/ots" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
