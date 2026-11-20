import React, { useCallback, useRef, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { colors } from '../theme/styles';

// Recarrega a tela ao puxar para baixo. Às vezes uma mudança feita em outro lugar só apareceria na
// próxima atualização automática.
export default function RefreshScroll({ onRefresh, children, ...props }) {
  const [refreshing, setRefreshing] = useState(false);
  const running = useRef(false);

  const pull = useCallback(async () => {
    if (running.current || !onRefresh) return;
    running.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // Cada tela mostra os próprios erros de carregamento.
    } finally {
      running.current = false;
      setRefreshing(false);
    }
  }, [onRefresh]);

  return (
    <ScrollView
      {...props}
      refreshControl={(
        <RefreshControl
          refreshing={refreshing} onRefresh={pull}
          colors={[colors.copper]} tintColor={colors.copper}
          title="Atualizando…" titleColor={colors.textMuted}
        />
      )}
    >
      {children}
    </ScrollView>
  );
}
