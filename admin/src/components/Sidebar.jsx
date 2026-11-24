import { NavLink, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useWarehouse } from '../warehouse.jsx';
import { RECEBIMENTO_CODE } from '../utils/sea.js';
import { isTerminalAccount } from '../utils/permissions.js';

// Cada item tem as permissões que o liberam. O menu só esconde; quem barra de verdade é a API.
const NAV = [
  {
    label: 'Operação',
    items: [
      { to: '/', label: 'Painel' },
      { to: '/estoque', label: 'Estoque', pageKeys: ['inventory', 'items', 'bins', 'audit-log'] },
      { to: '/recebimento', label: 'Recebimento', pageKeys: ['receiving', 'putaway', 'purchase-orders'], onlyAt: RECEBIMENTO_CODE },
      { to: '/retirada', label: 'Retirada', pageKeys: ['retirada', 'retirada-avaliar', 'retirada-fazer', 'terminal-retirada'] },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { to: '/users', label: 'Usuários', pageKeys: ['users'] },
      { to: '/settings', label: 'Configurações', pageKeys: ['settings'] },
      { to: '/cadastro-materiais', label: 'Cadastro de materiais', pageKeys: ['material-catalog'] },
      { to: '/imports', label: 'Importação de dados', pageKeys: ['imports'] },
    ],
  },
];

function canOpen(user, item) {
  if (isTerminalAccount(user)) return item.to === '/retirada';
  if (!item.pageKeys) return true;
  if (user?.role === 'ADMIN') return true;
  const allowed = user?.allowed_pages;
  return Array.isArray(allowed) && item.pageKeys.some((k) => allowed.includes(k));
}

export default function Sidebar() {
  const location = useLocation();
  const { user } = useAuth();
  const { warehouseId, warehouse } = useWarehouse();
  const [counts, setCounts] = useState({});
  useEffect(() => {
    if (!warehouseId) return;
    // Same silent treatment for the dashboard counts (sidebar badges).
    // /admin/dashboard is intentionally any-auth so this typically
    // succeeds, but a future tightening should not blow up the UI
    // with a modal on every page load.
    api.get(
      `/sea/painel?warehouse_id=${warehouseId}`,
      { silentPermissionDenied: true },
    ).then(async (res) => {
      if (!res || !res.ok) return;
      const data = await res.json();
      setCounts({
        '/recebimento': data.unreceived_ots ?? data.open_ots ?? 0,
        // Pedidos de todos os locais do usuário, não só do selecionado.
        '/retirada': data.pending_withdrawals_all ?? data.pending_withdrawals ?? 0,
      });
    });
  }, [location.pathname, warehouseId]);

  const navGroups = NAV
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canOpen(user, item)
        && (!item.onlyAt || warehouse?.warehouse_code === item.onlyAt)),
    }))
    .filter((group) => group.items.length > 0);

  // Per-section collapse, persisted so a hidden section stays hidden across
  // reloads. The header carries a caret; clicking it toggles its items.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sidebar.collapsed') || '{}');
    } catch {
      return {};
    }
  });
  function toggleGroup(label) {
    setCollapsed((c) => {
      const next = { ...c, [label]: !c[label] };
      try {
        localStorage.setItem('sidebar.collapsed', JSON.stringify(next));
      } catch {
        /* ignore quota / private-mode write failures */
      }
      return next;
    });
  }

  return (
    <nav className="sidebar">
      {navGroups.map((group) => {
        const isCollapsed = !!collapsed[group.label];
        return (
          <div key={group.label} className="sidebar-card">
            <div
              className="sidebar-group-label"
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              onClick={() => toggleGroup(group.label)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleGroup(group.label);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <span>{group.label}</span>
              <span style={{ fontSize: 10, opacity: 0.7 }} aria-hidden>
                {isCollapsed ? '▸' : '▾'}
              </span>
            </div>
            {!isCollapsed && group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `sidebar-link${isActive ? ' active' : ''}`
                }
              >
                <span>{item.label}</span>
                {counts[item.to] > 0 && (
                  <span className="sidebar-badge">{counts[item.to]}</span>
                )}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
