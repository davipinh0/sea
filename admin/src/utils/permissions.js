// "Exportar CSV" buttons: ADMIN, or a USER holding the export-csv grant
// (api/constants.py OVERRIDE_EXPORT_CSV, set in Sistema > Usuários).
export const EXPORT_CSV_KEY = 'export-csv';

export function canExportCsv(user) {
  if (user?.role === 'ADMIN') return true;
  return Array.isArray(user?.allowed_overrides) && user.allowed_overrides.includes(EXPORT_CSV_KEY);
}

// Page-permission check shared by the SEA navigation (mirrors the API's
// require_admin_or_page_permission: ADMIN passes, USER needs the key).
// SEA (mig 098): the account of the withdrawal terminal. It holds this
// permission only and sees nothing but the terminal.
export const TERMINAL_PAGE = 'terminal-retirada';

export function isTerminalAccount(user) {
  return user?.role !== 'ADMIN' && Array.isArray(user?.allowed_pages)
    && user.allowed_pages.includes(TERMINAL_PAGE);
}

export function canSee(user, pageKey) {
  if (!pageKey) return true;
  if (user?.role === 'ADMIN') return true;
  const allowed = user?.allowed_pages;
  return Array.isArray(allowed) && allowed.includes(pageKey);
}
