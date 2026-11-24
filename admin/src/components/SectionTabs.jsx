import { NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { canSee } from '../utils/permissions.js';

// Abas de uma seção (Estoque, Recebimento). Cada aba depende de uma permissão; a API confere de novo.
export default function SectionTabs({ basePath, tabs, emptyMessage }) {
  const { user } = useAuth();
  const location = useLocation();
  const visibleTabs = tabs.filter((t) => canSee(user, t.pageKey));

  const atRoot = location.pathname === basePath || location.pathname === `${basePath}/`;
  if (atRoot) {
    if (visibleTabs.length === 0) {
      return (
        <div style={{ padding: 24, color: 'var(--text-secondary)' }}>
          {emptyMessage || 'Nenhuma página desta seção liberada para sua conta.'}
        </div>
      );
    }
    return <Navigate to={visibleTabs[0].to} replace />;
  }

  // Aba aberta pela URL sem permissão volta para a seção.
  const current = tabs.find((t) => location.pathname.startsWith(`${basePath}/${t.to}`));
  if (current && !canSee(user, current.pageKey)) return <Navigate to={basePath} replace />;

  return (
    <div>
      <div className="data-tabs" role="tablist">
        {visibleTabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            role="tab"
            className={({ isActive }) => `data-tab${isActive ? ' active' : ''}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
