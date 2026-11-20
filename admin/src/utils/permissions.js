export const EXPORT_CSV_KEY = 'export-csv';

export function canExportCsv(user) {
  if (user?.role === 'ADMIN') return true;
  return Array.isArray(user?.allowed_overrides) && user.allowed_overrides.includes(EXPORT_CSV_KEY);
}

// Usuário do terminal: só tem esta permissão e só vê o terminal.
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
