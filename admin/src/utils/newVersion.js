// Reload the panel when a newer build has been published.
//
// The panel is a single-page app: a tab left open keeps running the
// JavaScript it loaded, even after the server was updated, so the operator
// would keep seeing old screens. On navigation, the page asks the server
// for the current entry file name (it changes on every build) and reloads
// once when it differs from the one this tab is running.

const ENTRY = /assets\/index-[\w-]+\.js/;
const MIN_INTERVAL_MS = 30000;

let lastCheck = 0;

function runningEntry() {
  const script = document.querySelector('script[src*="assets/index-"]');
  return script ? (script.getAttribute('src').match(ENTRY) || [null])[0] : null;
}

export async function reloadIfNewVersion() {
  const current = runningEntry();
  // No hashed entry (dev server, tests): nothing to compare.
  if (!current) return;
  const now = Date.now();
  if (now - lastCheck < MIN_INTERVAL_MS) return;
  lastCheck = now;
  let html;
  try {
    const res = await fetch('/index.html', { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return;
    html = await res.text();
  } catch {
    return; // offline or server restarting: keep the current version
  }
  const published = (html.match(ENTRY) || [null])[0];
  if (published && published !== current) window.location.reload();
}
