import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, ScrollView, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import client from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ScreenHeader from '../components/ScreenHeader';
import { Button, Message, ui } from '../components/ui';
import { actionLabel, describeMovement, whenText } from '../utils/history';
import { apiError } from '../utils/sea';
import { colors, radii, screenStyles } from '../theme/styles';

// Histórico (administrators and users granted "Histórico"):
//   MOVIMENTAÇÕES - what happened in the selected location (stock moves);
//   LOG           - every action recorded by the SEA, all locations.

const TABS = [
  { key: 'mov', label: 'MOVIMENTAÇÕES' },
  { key: 'log', label: 'LOG' },
];

export default function HistoricoScreen({ navigation }) {
  const { warehouseId } = useAuth();
  const [tab, setTab] = useState('mov');
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (more) => {
    setBusy(true);
    try {
      if (tab === 'mov') {
        const before = more ? `&before=${more}` : '';
        const resp = await client.get(`/api/sea/historico?warehouse_id=${warehouseId}&limit=30${before}`);
        const rows = resp.data?.movements || [];
        setItems((current) => (more ? [...(current || []), ...rows] : rows));
        setNext(resp.data?.next_before || null);
      } else {
        const page = more || 1;
        const resp = await client.get(`/api/admin/audit-log?page=${page}&per_page=30`);
        const rows = (resp.data?.entries || []).map((e) => ({ ...e, user: e.user_id }));
        setItems((current) => (more ? [...(current || []), ...rows] : rows));
        setNext(resp.data && resp.data.page < resp.data.pages ? resp.data.page + 1 : null);
      }
      setMessage(null);
    } catch (err) {
      setItems((current) => current || []);
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar o histórico.') });
    } finally {
      setBusy(false);
    }
  }, [tab, warehouseId]);

  useEffect(() => {
    setItems(null);
    setNext(null);
    if (tab === 'log' || warehouseId) load();
  }, [tab, warehouseId, load]);

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="HISTÓRICO" onBack={() => navigation.goBack()} />
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView style={screenStyles.content} contentContainerStyle={screenStyles.contentInner}>
        <Message message={message} />
        {tab === 'mov' && !warehouseId && <Text style={ui.empty}>Selecione um local na tela inicial.</Text>}
        {items === null && (tab === 'log' || warehouseId) && <Text style={ui.empty}>Carregando…</Text>}
        {items && items.length === 0 && <Text style={ui.empty}>Nada registrado.</Text>}
        {(items || []).map((e) => {
          const detail = describeMovement(e);
          return (
            <View key={e.log_id} style={ui.line}>
              <Text style={{ flex: 1 }}>
                <Text style={ui.code}>{actionLabel(e.action_type)}</Text>
                {e.warehouse_code ? <Text style={ui.tag}>{`  ${e.warehouse_code}`}</Text> : null}{'\n'}
                {detail ? <Text style={ui.name}>{detail}{'\n'}</Text> : null}
                {e.entity_name ? <Text style={ui.name}>{e.entity_name}{'\n'}</Text> : null}
                <Text style={ui.meta}>{whenText(e.created_at)} · {e.user || '-'}</Text>
              </Text>
            </View>
          );
        })}
        {next && <Button label={busy ? 'CARREGANDO...' : 'CARREGAR MAIS'} secondary disabled={busy} onPress={() => load(next)} style={{ marginTop: 12 }} />}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginTop: 8, borderRadius: radii.small, borderWidth: 1, borderColor: colors.cardBorder, overflow: 'hidden' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: colors.cardBg },
  tabActive: { backgroundColor: colors.buttonBg },
  tabText: { fontSize: 13, fontWeight: '800', color: colors.textSecondary },
  tabTextActive: { color: colors.onAccent },
});
