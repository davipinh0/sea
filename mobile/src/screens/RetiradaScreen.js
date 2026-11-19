import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import client from '../api/client';
import { confirmIdentity } from '../auth/confirmIdentity';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { Button, Card, ConfirmModal, Message, ui } from '../components/ui';
import { apiError, formatQuantity, withdrawalActions } from '../utils/sea';
import { colors, radii, screenStyles } from '../theme/styles';
import RefreshScroll from '../components/RefreshScroll';

// Fila de retirada. Requests of every location the user works in (mig 096):
// the evaluator approves or denies; someone with "Fazer retirada" accepts
// an approved request, separates it and marks it ready. Every step asks
// for the fingerprint or the phone's PIN. The employee confirms receipt at
// the terminal; the stock is only decremented there.

const OPEN = 'REQUESTED,APPROVED,PICKING,READY';
const STATUS = {
  REQUESTED: 'Aguardando avaliação',
  APPROVED: 'Aprovada, aguardando quem faça',
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
  // 'cancel' or 'deny': both ask for the reason.
  const [mode, setMode] = useState('cancel');
  const [me, setMe] = useState(null);

  const load = useCallback(async () => {
    try {
      const [resp, meResp] = await Promise.all([
        client.get(`/api/sea/retiradas?status=${OPEN}`), client.get('/api/auth/me'),
      ]);
      setMe(meResp.data);
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
    const problem = await confirmIdentity('Confirme para continuar a retirada');
    if (problem) { setMessage({ type: 'error', text: problem }); return false; }
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
    if (!reason.trim()) { setMessage({ type: 'error', text: 'Informe o motivo.' }); return; }
    const target = cancelling;
    setCancelling(null);
    if (mode === 'deny') {
      await act(target, 'avaliar', { approve: false, note: reason.trim() }, `Retirada nº ${target.withdrawal_id} negada.`);
    } else {
      await act(target, 'cancelar', { reason: reason.trim() }, `Retirada nº ${target.withdrawal_id} cancelada.`);
    }
    setReason('');
  }

  function askReason(w, nextMode) {
    setReason('');
    setMode(nextMode);
    setCancelling(w);
  }

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="RETIRADA" onBack={() => navigation.goBack()} />
      <RefreshScroll onRefresh={load} style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        <Message message={message} />
        {queue === null && <Text style={ui.empty}>Carregando…</Text>}
        {queue && queue.length === 0 && <Text style={ui.empty}>Nenhuma solicitação de retirada em aberto.</Text>}
        {(queue || []).map((w) => (
          <Card key={w.withdrawal_id} title={`Nº ${w.withdrawal_id} · ${(w.orders || []).length > 1 ? 'ORDENS' : 'ORDEM'} ${(w.orders || []).join(', ') || w.ot}`}>
            <Text style={ui.tag}>{STATUS[w.status] || w.status}</Text>
            <Text style={[ui.meta, { marginTop: 6 }]}>Solicitada por {w.requester_email ? `${w.requester_email} (terminal)` : (w.requested_by_name || w.requested_by)}</Text>
            {w.picked_by ? <Text style={ui.meta}>Aceita por {w.picked_by_name || w.picked_by}</Text> : null}
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
              {withdrawalActions(w, me).map((a) => (
                <Button key={a.label} label={a.label} disabled={busy} danger={a.deny} style={{ flex: 2 }}
                  onPress={() => (a.deny ? askReason(w, 'deny') : act(w, a.action, a.body, a.done))} />
              ))}
              <Button label="CANCELAR" secondary disabled={busy} style={{ flex: 1 }} onPress={() => askReason(w, 'cancel')} />
            </View>
          </Card>
        ))}
      </RefreshScroll>

      <ConfirmModal
        visible={!!cancelling} title={`${mode === 'deny' ? 'NEGAR' : 'CANCELAR'} RETIRADA Nº ${cancelling?.withdrawal_id || ''}`} danger
        confirmLabel={mode === 'deny' ? 'NEGAR RETIRADA' : 'CANCELAR RETIRADA'} onConfirm={confirmCancel} onClose={() => setCancelling(null)}
        message="O material volta a ficar disponível. Informe o motivo (obrigatório):"
      >
        <TextInput
          style={styles.reason} value={reason} onChangeText={setReason} multiline accessibilityLabel="Motivo"
          placeholder="Motivo" placeholderTextColor={colors.textPlaceholder}
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
