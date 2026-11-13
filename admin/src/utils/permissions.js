// "Exportar CSV" buttons: ADMIN, or a USER holding the export-csv grant
// (api/constants.py OVERRIDE_EXPORT_CSV, set in Sistema > Usuários).
export const EXPORT_CSV_KEY = 'export-csv';

export function canExportCsv(user) {
  if (user?.role === 'ADMIN') return true;
  return Array.isArray(user?.allowed_overrides) && user.allowed_overrides.includes(EXPORT_CSV_KEY);
}

// Page-permission check shared by the SEA navigation (mirrors the API's
// require_admin_or_page_permission: ADMIN passes, USER needs the key).
export function canSee(user, pageKey) {
  if (!pageKey) return true;
  if (user?.role === 'ADMIN') return true;
  const allowed = user?.allowed_pages;
  return Array.isArray(allowed) && allowed.includes(pageKey);
}
