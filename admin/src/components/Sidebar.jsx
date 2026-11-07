import { NavLink, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useWarehouse } from '../warehouse.jsx';

// Each NAV item carries a page_key matching api/constants.py
// ALL_PAGE_KEYS. Sidebar filters by the user's allowed_pages so a
// USER without the grant never sees the link (and the backend
// rejects direct URL hits via @require_admin_or_page_permission).
// Dashboard intentionally has no page_key: it is reachable by any
// authenticated user so the badges below populate.
const NAV = [
  {
    label: 'Operação',
    items: [
      { to: '/', label: 'Painel', pageKey: 'dashboard' },
      { to: '/inventory', label: 'Estoque', pageKey: 'inventory' },
      { to: '/cycle-counts', label: 'Contagens', pageKey: 'cycle-counts' },
      { to: '/count-approvals', label: 'Aprovações', pageKey: 'count-approvals' },
    ],
  },
  {
    label: 'Entrada',
    items: [
      { to: '/purchase-orders', label: 'Pedidos de compra', pageKey: 'purchase-orders' },
      { to: '/receiving', label: 'Recebimento', pageKey: 'receiving' },
      { to: '/putaway', label: 'Armazenagem', pageKey: 'putaway' },
    ],
  },
  {
    label: 'Saída',
    items: [
      { to: '/sales-orders', label: 'Pedidos de venda', pageKey: 'sales-orders' },
      { to: '/pos-activity', label: 'Atividade PDV' },
      { to: '/fraud', label: 'Fraude', pageKey: 'fraud' },
      // Partial-fulfill / backorders dashboard.
      { to: '/backorders', label: 'Pendências', pageKey: 'backorders' },
      { to: '/picking-tickets', label: 'Fichas de separação', pageKey: 'picking-tickets' },
      // Returns: RMA (the <orig>-RMA goods-in SOs) + Refunds (the <orig>-REFUND
      // credit memos) under one tabbed page. Reuses the sales-orders permission
      // -- the create-rma / receive-return / refund routes all gate on it.
      { to: '/returns', label: 'Devoluções', pageKey: 'sales-orders' },
      // Picking/Packing/Shipping are mobile-only: the admin-side
      // mirrors were retired. Supervisors use Sales Orders + Picking
      // Tickets here, and the handheld scanners drive the floor work.
      { to: '/picking-batches', label: 'Lotes de separação', pageKey: 'picking-batches' },
    ],
  },
  {
    label: 'Armazém',
    items: [
      // Day-to-day operational entries lead; the warehouse-layout
      // pages (Warehouses / Bins / Zones / Preferred Bins) collapse
      // into a single Data link with a tab strip.
      { to: '/items', label: 'Materiais', pageKey: 'items' },
      { to: '/vendors', label: 'Fornecedores', pageKey: 'vendors' },
      { to: '/adjustments', label: 'Ajustes de estoque', pageKey: 'adjustments' },
      { to: '/inter-warehouse-transfers', label: 'Transferências de estoque', pageKey: 'inter-warehouse-transfers' },
      { to: '/transfer-orders', label: 'Ordens de transferência', pageKey: 'transfer-orders' },
      { to: '/data', label: 'Dados', pageKeys: ['warehouses', 'bins', 'zones', 'preferred-bins'] },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { to: '/users', label: 'Usuários', pageKey: 'users' },
      { to: '/api-tokens', label: 'Tokens de API', pageKey: 'api-tokens' },
      { to: '/inbound', label: 'Atividade de entrada', pageKey: 'inbound' },
      { to: '/consumer-groups', label: 'Grupos de consumidores', pageKey: 'consumer-groups' },
      { to: '/webhooks', label: 'Webhooks', pageKey: 'webhooks' },
      { to: '/channels', label: 'Canais', pageKey: 'channels' },
      // v1.13.0 mig 064 notification_webhooks. Sibling to /webhooks
      // because both are outbound-delivery surfaces; this one carries
      // chat-channel destinations (Teams adaptive cards), the other
      // signed-envelope HTTP subscribers.
      { to: '/notifications', label: 'Notificações', pageKey: 'notifications' },
      { to: '/audit-log', label: 'Log de auditoria', pageKey: 'audit-log' },
      { to: '/imports', label: 'Importação', pageKey: 'imports' },
      { to: '/integrations', label: 'Integrações', pageKey: 'integrations' },
      { to: '/settings', label: 'Configurações', pageKey: 'settings' },
    ],
  },
];

export default function Sidebar() {
  const location = useLocation();
  const { user } = useAuth();
  const { warehouseId } = useWarehouse();
  const [counts, setCounts] = useState({});
  // The POS Activity tab is opt-in via the pos_activity_enabled setting
  // so non-POS deployments never see it. Default false: the entry is
  // hidden until an operator turns it on in Settings > POS. Silent on
  // permission denial so a USER without the settings grant just gets
  // the default (hidden) rather than a Permissions Error popup.
  const [posActivityEnabled, setPosActivityEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(
      '/admin/settings/pos_activity_enabled',
      { silentPermissionDenied: true },
    ).then(async (res) => {
      if (!res?.ok || cancelled) return;
      const data = await res.json();
      setPosActivityEnabled(data?.value === 'true');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!warehouseId) return;
    // Same silent treatment for the dashboard counts (sidebar badges).
    // /admin/dashboard is intentionally any-auth so this typically
    // succeeds, but a future tightening should not blow up the UI
    // with a modal on every page load.
    api.get(
      `/admin/dashboard?warehouse_id=${warehouseId}`,
      { silentPermissionDenied: true },
    ).then(async (res) => {
      if (!res || !res.ok) return;
      const data = await res.json();
      setCounts({
        '/receiving': data.open_pos || 0,
        '/putaway': data.pending_putaway || 0,
        '/count-approvals': data.pending_adjustments || 0,
        // /picking, /packing, /shipping badges were removed alongside
        // their retired nav entries; the throughput counts still live
        // on the Dashboard page itself.
        // v1.8.0 (#296): pending TO approvals scoped to the active
        // warehouse (source OR destination match). Falls back to 0
        // when the dashboard endpoint is the older shape.
        '/transfer-orders': data.pending_to_approvals || 0,
      });
    });
  }, [location.pathname, warehouseId]);

  const navGroups = posActivityEnabled
    ? NAV
    : NAV.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.to !== '/pos-activity'),
      }));

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
