import { useEffect, useRef } from 'react';

// Mantém a tela atualizada: logo após qualquer mudança feita neste navegador, de tempos em tempos
// enquanto a aba está visível e quando ela volta a ficar visível.

export const CHANGED_EVENT = 'sea:changed';
const DEFAULT_INTERVAL_MS = 10000;

export function announceChange() {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function useLiveRefresh(refresh, intervalMs = DEFAULT_INTERVAL_MS) {
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
