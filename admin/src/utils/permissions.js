// Page-permission check shared by the SEA navigation (mirrors the API's
// require_admin_or_page_permission: ADMIN passes, USER needs the key).
export function canSee(user, pageKey) {
  if (!pageKey) return true;
  if (user?.role === 'ADMIN') return true;
  const allowed = user?.allowed_pages;
  return Array.isArray(allowed) && allowed.includes(pageKey);
}
