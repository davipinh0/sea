import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

// Mantém a tela atualizada: ao abrir, a cada ``intervalMs`` enquanto ela está na frente e quando o
// app volta do segundo plano. ``paused`` segura (por exemplo, com um formulário aberto).

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
