import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TextInput, StyleSheet } from 'react-native';
import client from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { Button, Card, ConfirmModal, Message, ui } from '../components/ui';
import { apiError, formatQuantity } from '../utils/sea';
import { colors, radii, screenStyles } from '../theme/styles';

// Fila de retirada (stock keeper). Requests of every location the user
// works in: start separating, mark as ready, or cancel with a reason. The
// employee confirms receipt at the terminal; the stock is only
// decremented there.

const OPEN = 'REQUESTED,PICKING,READY';
const STATUS = {
  REQUESTED: 'Aguardando separação',
  PICKING: 'Em separação',
  READY: 'Pronta, aguardando o funcionário',
};
const REFRESH_MS = 8000;

export default function RetiradaScreen({ navigation }) {
  const [queue, setQueue] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const resp = await client.get(`/api/sea/retiradas?status=${OPEN}`);
      // Oldest request first: it is the next one to separate.
      setQueue([...(resp.data?.withdrawals || [])].reverse());
    } catch (err) {
      setQueue((current) => current || []);
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar a fila de retirada.') });
    }
  }, []);

  // Keeps the queue fresh while the screen is open.
  useAutoRefresh(load, { intervalMs: REFRESH_MS, paused: !!cancelling });

  async function act(withdrawal, action, body, done) {
    setBusy(true);
    try {
      await client.post(`/api/sea/retiradas/${withdrawal.withdrawal_id}/${action}`, body || {});
      setMessage({ type: 'ok', text: done });
      await load();
      return true;
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível atualizar a retirada.') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmCancel() {
    if (!reason.trim()) { setMessage({ type: 'error', text: 'Informe o motivo do cancelamento.' }); return; }
    const target = cancelling;
    setCancelling(null);
    await act(target, 'cancelar', { reason: reason.trim() }, `Retirada nº ${target.withdrawal_id} cancelada.`);
    setReason('');
  }

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="RETIRADA" onBack={() => navigation.goBack()} />
      <ScrollView style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        <Message message={message} />
        {queue === null && <Text style={ui.empty}>Carregando…</Text>}
        {queue && queue.length === 0 && <Text style={ui.empty}>Nenhuma solicitação de retirada em aberto.</Text>}
        {(queue || []).map((w) => (
          <Card key={w.withdrawal_id} title={`Nº ${w.withdrawal_id} · ORDEM ${w.service_order_number || w.ot}`}>
            <Text style={ui.tag}>{STATUS[w.status] || w.status}</Text>
            <Text style={[ui.meta, { marginTop: 6 }]}>Solicitada por {w.requested_by_name || w.requested_by}</Text>
            {w.lines.map((l) => (
              <View key={l.inventory_id} style={ui.line}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.code}>{w.warehouse_code} · {l.bin_code}</Text>
                  <Text style={ui.name}>{l.sku} · {l.item_name}</Text>
                </View>
                <Text style={ui.code}>{formatQuantity(l.quantity, l.uom, l.pack_weight_kg)}</Text>
              </View>
            ))}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              {w.status === 'REQUESTED' && (
                <Button label="INICIAR SEPARAÇÃO" disabled={busy} style={{ flex: 2 }}
                  onPress={() => act(w, 'separar', null, `Separação da retirada nº ${w.withdrawal_id} iniciada.`)} />
              )}
              {w.status === 'PICKING' && (
                <Button label="PRONTA PARA ENTREGA" disabled={busy} style={{ flex: 2 }}
                  onPress={() => act(w, 'pronta', null, `Retirada nº ${w.withdrawal_id} pronta. O funcionário confirma no terminal.`)} />
              )}
              <Button label="CANCELAR" secondary disabled={busy} style={{ flex: 1 }} onPress={() => { setReason(''); setCancelling(w); }} />
            </View>
          </Card>
        ))}
      </ScrollView>

      <ConfirmModal
        visible={!!cancelling} title={`CANCELAR RETIRADA Nº ${cancelling?.withdrawal_id || ''}`} danger
        confirmLabel="CANCELAR RETIRADA" onConfirm={confirmCancel} onClose={() => setCancelling(null)}
        message="O material volta a ficar disponível. Informe o motivo (obrigatório):"
      >
        <TextInput
          style={styles.reason} value={reason} onChangeText={setReason} multiline accessibilityLabel="Motivo do cancelamento"
          placeholder="Motivo do cancelamento" placeholderTextColor={colors.textPlaceholder}
        />
      </ConfirmModal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  reason: {
    minHeight: 70, marginTop: 10, padding: 10, fontSize: 14, color: colors.textPrimary, textAlignVertical: 'top',
    backgroundColor: colors.inputBg, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input,
  },
});
