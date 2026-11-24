// A sessão do painel pertence à aba aberta:
// - uma aba que não estava aberta no login (nova, restaurada, navegador reaberto) só herda a sessão
// se outra aba do painel confirmar;
// - aba duplicada pelo navegador não herda: ela copia a identificação da original, que responde que
// essa identificação já é dela;
// - "Sair" numa aba sai de todas;
// - sem uso por IDLE_LIMIT_MS a sessão termina (o servidor também encerra as inativas).

export const TAB_KEY = 'sea_tab_session';
export const FLASH_KEY = 'login_flash_message';
export const IDLE_LIMIT_MS = 15 * 60 * 1000;
export const IDLE_MESSAGE = 'Sua sessão foi encerrada por inatividade. Entre novamente.';
export const ANOTHER_TAB_MESSAGE = 'O SEA já está aberto em outra aba. Continue nela; se entrar aqui, a outra aba será desconectada.';
export const TAKEOVER_MESSAGE = 'O SEA foi aberto em outra aba e esta foi desconectada. O painel funciona em uma aba por vez.';
export const DUPLICATE_MESSAGE = 'Esta aba é uma cópia de outra aba do painel e foi bloqueada. Continue na aba original ou entre novamente aqui.';
const CHANNEL = 'sea-auth';
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'];

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// Cada aba guarda uma identificação própria. Duplicar a aba copia o sessionStorage, e com ele a
// identificação; é assim que a cópia é reconhecida.
export function tabId() {
  return storage()?.getItem(TAB_KEY) || null;
}

export function hasTabSession() {
  return !!tabId();
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function markTabSession() {
  if (!hasTabSession()) storage()?.setItem(TAB_KEY, newId());
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

// Outra aba aberta já usa esta identificação? Então esta é uma cópia.
export function isDuplicateTab(timeoutMs = 400) {
  const id = tabId();
  const channel = openChannel();
  if (!id || !channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      channel.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.onmessage = (event) => {
      if (event.data?.type === 'owned' && event.data.id === id) done(true);
    };
    channel.postMessage({ type: 'owner', id });
  });
}

export function listenOtherTabs({ onLogout, onTakeover = onLogout }) {
  const channel = openChannel();
  if (!channel) return () => {};
  channel.onmessage = (event) => {
    if (event.data?.type === 'who' && hasTabSession()) channel.postMessage({ type: 'alive' });
    if (event.data?.type === 'owner' && event.data.id && event.data.id === tabId()) {
      channel.postMessage({ type: 'owned', id: event.data.id });
    }
    if (event.data?.type === 'logout') onLogout();
    if (event.data?.type === 'takeover' && hasTabSession()) onTakeover();
  };
  return () => channel.close();
}

// Esta aba entrou: as outras abas do painel são desconectadas (uma aba por vez).
export function announceTakeover() {
  const channel = openChannel();
  if (!channel) return;
  channel.postMessage({ type: 'takeover' });
  channel.close();
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
