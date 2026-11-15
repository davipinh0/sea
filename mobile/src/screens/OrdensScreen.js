import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthContext';
import client from '../api/client';
import ScreenHeader from '../components/ScreenHeader';
import CodeInput from '../components/CodeInput';
import { Card, Field, Message, ui } from '../components/ui';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { apiError, formatQuantity } from '../utils/sea';
import { screenStyles } from '../theme/styles';

// Ordens: the OTs of the selected location and, for each one, its
// materials with what was received, where it is and what was withdrawn
// (read-only).

const STATUS = { OPEN: 'Aberta', PARTIAL: 'Recebida em parte', RECEIVED: 'Recebida', CLOSED: 'Fechada', ARCHIVED: 'Arquivada' };

export default function OrdensScreen({ navigation }) {
  const { warehouseId } = useAuth();
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    if (!warehouseId) return;
    try {
      const resp = await client.get(`/api/sea/ots?warehouse_id=${warehouseId}`);
      setList(resp.data?.ots || []);
    } catch (err) {
      setList((current) => current || []);
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar as ordens.') });
    }
  }, [warehouseId]);
  useAutoRefresh(load, { paused: !!detail });

  async function open(code) {
    setMessage(null);
    try {
      const resp = await client.get(`/api/sea/ots/${encodeURIComponent(code)}`);
      setDetail(resp.data);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.status === 404 ? `OT ${code} não encontrada.` : apiError(err, 'Não foi possível consultar a ordem.') });
    }
  }

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="ORDENS" onBack={() => (detail ? setDetail(null) : navigation.goBack())} />
      <ScrollView style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        {!detail && <CodeInput placeholder="Código da OT" onSubmit={open} buttonLabel="ABRIR" />}
        <Message message={message} />

        {!detail && list === null && <Text style={ui.empty}>Carregando…</Text>}
        {!detail && list && list.length === 0 && <Text style={ui.empty}>Nenhuma ordem neste local.</Text>}
        {!detail && (list || []).map((o) => (
          <TouchableOpacity key={o.po_id} style={ui.line} onPress={() => open(o.ot)} accessibilityLabel={`Abrir OT ${o.ot}`}>
            <View style={{ flex: 1 }}>
              <Text style={ui.code}>{o.ot}{o.order_type ? ` · ${o.order_type}` : ''}</Text>
              <Text style={ui.meta}>
                {STATUS[o.status] || o.status} · recebido {o.qty_received}/{o.qty_ordered} · armazenado {o.qty_stored} · retirado {o.qty_withdrawn}
              </Text>
              {o.bins ? <Text style={ui.meta}>{o.bins}</Text> : null}
            </View>
          </TouchableOpacity>
        ))}

        {detail && (
          <>
            <Card title={`OT ${detail.ot.ot}${detail.ot.order_type ? ` · ${detail.ot.order_type}` : ''}`}>
              <Text style={ui.tag}>{STATUS[detail.ot.status] || detail.ot.status}</Text>
              <View style={{ height: 8 }} />
              <Field label="RESERVA" value={detail.ot.reservation_number} />
              <Field label="SOLICITANTE" value={detail.ot.requester_name} />
              <Field label="RECEBEDOR" value={detail.ot.receiver_name} />
            </Card>
            <Card title="MATERIAIS">
              {(detail.materials || []).map((m) => (
                <View key={m.po_line_id} style={ui.line}>
                  <View style={{ flex: 1 }}>
                    <Text style={ui.code}>{m.sku}</Text>
                    <Text style={ui.name}>{m.item_name}</Text>
                    <Text style={ui.meta}>
                      {m.service_order_number ? `Ordem ${m.service_order_type || ''} ${m.service_order_number} · ` : ''}
                      previsto {formatQuantity(m.quantity_ordered, m.uom)} · recebido {m.quantity_received}
                    </Text>
                    <Text style={ui.meta}>
                      em estoque {m.quantity_in_stock} · retirado {m.quantity_withdrawn}
                      {m.locations.length ? ` · ${m.locations.map((l) => `${l.warehouse_code} · ${l.bin_code}`).join(', ')}` : ''}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
