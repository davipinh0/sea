import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TextInput, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthContext';
import client from '../api/client';
import ScreenHeader from '../components/ScreenHeader';
import { Card, Message, ui } from '../components/ui';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { apiError } from '../utils/sea';
import { colors, radii, screenStyles } from '../theme/styles';

// Estoque: what is in each address of the selected location (read-only).
// The filter looks at address, material code, description and OT.

export default function EstoqueScreen({ navigation }) {
  const { warehouseId } = useAuth();
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    if (!warehouseId) return;
    try {
      const resp = await client.get(`/api/sea/estoque?warehouse_id=${warehouseId}`);
      setData(resp.data);
      setMessage(null);
    } catch (err) {
      setData((current) => current || { bins: [], totals: {} });
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar o estoque.') });
    }
  }, [warehouseId]);
  useAutoRefresh(load);

  const wanted = filter.trim().toUpperCase();
  const bins = (data?.bins || [])
    .map((b) => ({
      ...b,
      shown: !wanted || b.bin_code.toUpperCase().includes(wanted)
        ? b.contents
        : b.contents.filter((c) => `${c.sku} ${c.item_name} ${c.ot || ''}`.toUpperCase().includes(wanted)),
    }))
    .filter((b) => (wanted ? b.shown.length > 0 || b.bin_code.toUpperCase().includes(wanted) : true));

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="ESTOQUE" onBack={() => navigation.goBack()} />
      <ScrollView style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        <Message message={message} />
        <TextInput
          style={styles.filter} value={filter} onChangeText={setFilter} autoCapitalize="characters" autoCorrect={false}
          placeholder="Filtrar por endereço, material ou OT" placeholderTextColor={colors.textPlaceholder}
          accessibilityLabel="Filtrar o estoque"
        />
        {data === null && <Text style={ui.empty}>Carregando…</Text>}
        {data && (
          <Text style={[ui.meta, { marginBottom: 10 }]}>
            {data.totals?.stored_units ?? 0} armazenado(s) · {data.totals?.staging_units ?? 0} aguardando armazenagem
          </Text>
        )}
        {data && bins.length === 0 && <Text style={ui.empty}>Nada encontrado.</Text>}
        {bins.map((b) => (
          <Card key={b.bin_id} title={`${b.bin_code}${b.staging ? ' · ÁREA DE RECEBIMENTO' : ''}`}>
            {b.shown.length === 0 && <Text style={ui.meta}>Vazio</Text>}
            {b.shown.map((c) => (
              <View key={c.inventory_id} style={ui.line}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.code}>{c.sku}</Text>
                  <Text style={ui.name}>{c.item_name}</Text>
                  <Text style={ui.meta}>OT {c.ot || '-'}{c.quantity_allocated > 0 ? ` · ${c.quantity_allocated} reservado(s)` : ''}</Text>
                </View>
                <Text style={ui.code}>{c.quantity_on_hand}</Text>
              </View>
            ))}
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  filter: {
    minHeight: 48, paddingHorizontal: 12, marginBottom: 10, fontSize: 15, color: colors.textPrimary,
    backgroundColor: colors.inputBg, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input,
  },
});
