import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

// Keeps a screen current without leaving and coming back: ``refresh``
// runs when the screen opens, every ``intervalMs`` while it is on top and
// the app is in use, and when the app returns from the background.
// ``paused`` holds it (e.g. while the operator fills in a form).

export default function useAutoRefresh(refresh, { intervalMs = 8000, paused = false } = {}) {
  const latest = useRef(refresh);
  const pausedRef = useRef(paused);
  useEffect(() => { latest.current = refresh; }, [refresh]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useFocusEffect(useCallback(() => {
    latest.current();
    const run = () => { if (!pausedRef.current && AppState.currentState === 'active') latest.current(); };
    const timer = setInterval(run, intervalMs);
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') run(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [intervalMs]));
}
