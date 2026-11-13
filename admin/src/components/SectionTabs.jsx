import { NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { canSee } from '../utils/permissions.js';

// Tab strip for a top-level SEA section (Estoque, Expedição). Sub-pages
// render as <Outlet /> children so each keeps its own header and state.
// Each tab is gated by an existing page_key: ADMIN sees every tab, a
// USER only the tabs whose key is in allowed_pages. Backend endpoints
// keep their own per-key permission checks.
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

  // A tab opened by URL without the permission goes back to the section
  // (which opens the first allowed tab or explains there is none).
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
