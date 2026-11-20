// Uma aba deixada aberta continua rodando o JavaScript antigo depois de uma atualização. Ao
// navegar, a página compara o arquivo de entrada atual com o dela e recarrega uma vez se mudou.

const ENTRY = /assets\/index-[\w-]+\.js/;
const MIN_INTERVAL_MS = 30000;

let lastCheck = 0;

function runningEntry() {
  const script = document.querySelector('script[src*="assets/index-"]');
  return script ? (script.getAttribute('src').match(ENTRY) || [null])[0] : null;
}

export async function reloadIfNewVersion() {
  const current = runningEntry();
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
