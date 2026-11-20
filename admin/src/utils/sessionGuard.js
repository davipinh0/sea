// A sessão do painel pertence à aba aberta:
// - uma aba que não estava aberta no login (nova, restaurada, navegador reaberto) só herda a sessão
// se outra aba do painel confirmar;
// - "Sair" numa aba sai de todas;
// - sem uso por IDLE_LIMIT_MS a sessão termina (o servidor também encerra as inativas).

export const TAB_KEY = 'sea_tab_session';
export const FLASH_KEY = 'login_flash_message';
export const IDLE_LIMIT_MS = 15 * 60 * 1000;
export const IDLE_MESSAGE = 'Sua sessão foi encerrada por inatividade. Entre novamente.';
const CHANNEL = 'sea-auth';
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'];

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function hasTabSession() {
  return storage()?.getItem(TAB_KEY) === '1';
}

export function markTabSession() {
  storage()?.setItem(TAB_KEY, '1');
}

export function clearTabSession() {
  storage()?.removeItem(TAB_KEY);
}

export function setLoginFlash(message) {
  storage()?.setItem(FLASH_KEY, message);
}

function openChannel() {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
}

export function askOtherTabs(timeoutMs = 400) {
  const channel = openChannel();
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      channel.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.onmessage = (event) => {
      if (event.data?.type === 'alive') done(true);
    };
    channel.postMessage({ type: 'who' });
  });
}

export function listenOtherTabs({ onLogout }) {
  const channel = openChannel();
  if (!channel) return () => {};
  channel.onmessage = (event) => {
    if (event.data?.type === 'who' && hasTabSession()) channel.postMessage({ type: 'alive' });
    if (event.data?.type === 'logout') onLogout();
  };
  return () => channel.close();
}

export function announceLogout() {
  const channel = openChannel();
  if (!channel) return;
  channel.postMessage({ type: 'logout' });
  channel.close();
}

export function watchIdle({ onIdle, onKeepAlive, limitMs = IDLE_LIMIT_MS, checkMs = 60000, now = () => Date.now() }) {
  let lastInput = now();
  let lastKeepAlive = lastInput;
  const touch = () => { lastInput = now(); };
  ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, touch, { passive: true }));
  const timer = setInterval(() => {
    const t = now();
    if (t - lastInput >= limitMs) {
      stop();
      onIdle();
    } else if (lastInput > lastKeepAlive) {
      lastKeepAlive = t;
      onKeepAlive?.();
    }
  }, checkMs);
  function stop() {
    clearInterval(timer);
    ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, touch));
  }
  return stop;
}
