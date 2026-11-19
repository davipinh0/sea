import React, { useCallback, useRef, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { colors } from '../theme/styles';

// A ScrollView that reloads its screen when pulled down. Sometimes a
// change made elsewhere (a new request, a receipt) only shows on the next
// automatic refresh; pulling the screen fetches it at once.
// ``onRefresh`` may return a promise: the spinner stays until it ends.
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
      // Each screen shows its own load errors.
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
