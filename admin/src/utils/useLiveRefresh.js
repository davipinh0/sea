import { useEffect, useRef } from 'react';

// Keeps a screen up to date without the operator leaving and coming back.
// ``refresh`` runs:
//   * right after any change made in this browser (api.js announces every
//     successful POST / PUT / DELETE with the ``sea:changed`` event);
//   * every ``intervalMs`` while the tab is visible, to pick up what other
//     people changed (a receipt, a storage, a withdrawal);
//   * when the tab becomes visible again.

export const CHANGED_EVENT = 'sea:changed';
const DEFAULT_INTERVAL_MS = 10000;

export function announceChange() {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function useLiveRefresh(refresh, intervalMs = DEFAULT_INTERVAL_MS) {
  // Always call the latest closure without re-binding the listeners.
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);

  useEffect(() => {
    const run = () => { if (!document.hidden) latest.current(); };
    const timer = setInterval(run, intervalMs);
    window.addEventListener(CHANGED_EVENT, run);
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CHANGED_EVENT, run);
      document.removeEventListener('visibilitychange', run);
    };
  }, [intervalMs]);
}
