import { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';

const WarehouseContext = createContext(null);

export function WarehouseProvider({ children }) {
  const { user } = useAuth();
  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseIdState] = useState(() => {
    const saved = sessionStorage.getItem('sentry_warehouse_id');
    return saved ? Number(saved) : null;
  });

  useEffect(() => {
    if (!user) return;
    // SEA: every user needs the list of locations they can work in (the
    // selector drives every page). /sea/locais returns it for any logged-in
    // user; /admin/warehouses is only for those who administer locations.
    api.get('/sea/locais', { silentPermissionDenied: true }).then(async (res) => {
      if (!res?.ok) return;
      const data = await res.json();
      const list = data.warehouses || [];
      setWarehouses(list);
      // Auto-select first warehouse if none selected or saved one no longer exists
      if (list.length > 0) {
        const saved = sessionStorage.getItem('sentry_warehouse_id');
        const savedId = saved ? Number(saved) : null;
        const exists = list.some((w) => (w.warehouse_id || w.id) === savedId);
        if (!exists) {
          const firstId = list[0].warehouse_id || list[0].id;
          setWarehouseIdState(firstId);
          sessionStorage.setItem('sentry_warehouse_id', String(firstId));
        }
      }
    });
  }, [user]);

  function setWarehouseId(id) {
    setWarehouseIdState(id);
    sessionStorage.setItem('sentry_warehouse_id', String(id));
  }

  const warehouse = warehouses.find((w) => (w.warehouse_id || w.id) === warehouseId) || null;

  return (
    <WarehouseContext.Provider value={{ warehouses, warehouseId, warehouse, setWarehouseId }}>
      {children}
    </WarehouseContext.Provider>
  );
}

export function useWarehouse() {
  return useContext(WarehouseContext);
}
