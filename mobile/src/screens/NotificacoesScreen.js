import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import client from '../api/client';
import ScreenHeader from '../components/ScreenHeader';
import { Button, Message, ui } from '../components/ui';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { KIND_LABEL, KIND_SCREEN, writeSeen } from '../notifications';
import { apiError } from '../utils/sea';
import { screenStyles } from '../theme/styles';
import RefreshScroll from '../components/RefreshScroll';

function when(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function NotificacoesScreen({ navigation }) {
  const [items, setItems] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const resp = await client.get('/api/sea/notificacoes?limit=50');
      const list = resp.data?.notifications || [];
      setItems(list);
      if (list[0]) writeSeen(list[0].notification_id);
    } catch (err) {
      setItems((current) => current || []);
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar as notificações.') });
    }
  }, []);
  useAutoRefresh(load);

  async function clearAll() {
    try {
      await client.post('/api/sea/notificacoes/limpar', {});
      setItems([]);
      setMessage(null);
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível limpar as notificações.') });
    }
  }

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="NOTIFICAÇÕES" onBack={() => navigation.goBack()} />
      <RefreshScroll onRefresh={load} style={screenStyles.content} contentContainerStyle={screenStyles.contentInner}>
        <Message message={message} />
        {items && items.length > 0 && <Button label="LIMPAR NOTIFICAÇÕES" secondary onPress={clearAll} style={{ marginBottom: 12 }} />}
        {items === null && <Text style={ui.empty}>Carregando…</Text>}
        {items && items.length === 0 && <Text style={ui.empty}>Nenhuma notificação.</Text>}
        {(items || []).map((n) => (
          <TouchableOpacity
            key={n.notification_id} style={ui.line} accessibilityLabel={n.title}
            onPress={() => navigation.navigate(KIND_SCREEN[n.kind] || 'Home')}
          >
            <Text style={{ flex: 1 }}>
              <Text style={ui.tag}>{KIND_LABEL[n.kind] || n.kind} · {n.warehouse_code}</Text>{'\n'}
              <Text style={ui.code}>{n.title}</Text>{'\n'}
              <Text style={ui.name}>{n.message}</Text>{'\n'}
              <Text style={ui.meta}>{when(n.created_at)}</Text>
            </Text>
          </TouchableOpacity>
        ))}
      </RefreshScroll>
    </SafeAreaView>
  );
}
