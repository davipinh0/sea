import { IDLE_MESSAGE, setLoginFlash } from './utils/sessionGuard.js';

const API_BASE = '/api';

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)sea_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const needsCsrf = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const csrfToken = needsCsrf ? getCsrfToken() : null;
  // Page permissions (mig 061): callers can pass silentPermissionDenied:true
  // to opt OUT of the global Permissions Error popup for background
  // fetches (sidebar badges, navshell settings probes). Without it
  // every USER landing on Dashboard would see the modal fire on
  // page mount before they did anything explicit.
  const { silentPermissionDenied = false, ...fetchOptions } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
    ...fetchOptions.headers,
  };
  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers,
    credentials: 'include',
  });
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/me')) {
    // SEA (mig 093): tell the login screen why the session ended.
    try {
      const body = await res.clone().json();
      if (/inatividade/i.test(body?.error || '')) setLoginFlash(IDLE_MESSAGE);
    } catch { /* non-JSON 401 */ }
    window.location.href = '/login';
    return;
  }
  // P6.1: surface page-permission rejections via a window event so
  // Layout can render a "Permissions Error" modal wherever the user
  // is. Response shape comes from @require_admin_or_page_permission
  // ({error: "Permission denied", page_key: "..."}). Peek at the body
  // without consuming the stream (clone first) so the caller can
  // still .json() the response.
  // SEA (mig 095): the phone release of a process ended; its gate closes.
  if (res.status === 403) {
    try {
      const peek = await res.clone().json();
      if (peek?.step_up_required) {
        window.dispatchEvent(new CustomEvent('sea:step-up', { detail: { purpose: peek.step_up_required } }));
      }
    } catch { /* non-JSON 403 */ }
  }
  if (res.status === 403 && !silentPermissionDenied) {
    try {
      const peek = await res.clone().json();
      if (peek?.error === 'Permission denied' && peek?.page_key) {
        window.dispatchEvent(new CustomEvent('sea:permission-denied', {
          detail: { page_key: peek.page_key, path },
        }));
      }
    } catch (_) { /* non-JSON 403 (legacy / unrelated) */ }
  }
  // Something changed on the server: open screens refresh (useLiveRefresh).
  if (needsCsrf && res.ok) window.dispatchEvent(new Event('sea:changed'));
  return res;
}

export const api = {
  get: (path, opts) => apiFetch(path, { ...(opts || {}) }),
  post: (path, body, opts) => apiFetch(path, { method: 'POST', body: JSON.stringify(body), ...(opts || {}) }),
  put: (path, body, opts) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body), ...(opts || {}) }),
  patch: (path, body, opts) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body), ...(opts || {}) }),
  delete: (path, opts) => apiFetch(path, { method: 'DELETE', ...(opts || {}) }),
};
