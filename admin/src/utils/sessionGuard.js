// SEA (mig 093): the panel session belongs to the open tab.
//
// * A tab that was not open when the user signed in (new tab, browser
//   reopened, restored tab) does not inherit the session: unless another
//   open panel tab vouches for it, the session is ended and the login
//   screen shows.
// * "Sair" in one tab signs every panel tab out.
// * Without mouse/keyboard use for IDLE_LIMIT_MS the session is ended.
//   While the user is active, a light keep-alive tells the server the
//   panel is in use (the server ends idle web sessions on its own too).

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

// Does another open panel tab hold the session? Resolves false when no tab
// answers within ``timeoutMs`` (or the browser has no BroadcastChannel).
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

// Answer other tabs while this one holds the session; ``onLogout`` runs
// when another tab signs out. Returns the cleanup function.
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

// Calls ``onIdle`` after ``limitMs`` without user input and ``onKeepAlive``
// at most once per ``checkMs`` while the user is active. Returns stop().
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
