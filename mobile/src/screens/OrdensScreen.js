import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthContext';
import client from '../api/client';
import ScreenHeader from '../components/ScreenHeader';
import CodeInput from '../components/CodeInput';
import { Card, Field, Message, ui } from '../components/ui';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { apiError, formatQuantity, orderName } from '../utils/sea';
import { screenStyles } from '../theme/styles';
import RefreshScroll from '../components/RefreshScroll';

const STATUS = { OPEN: 'Aberta', PARTIAL: 'Recebimento parcial', RECEIVED: 'Recebida', CLOSED: 'Fechada', ARCHIVED: 'Arquivada' };

export default function OrdensScreen({ navigation }) {
  const { warehouseId } = useAuth();
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    if (!warehouseId) return;
    try {
      const resp = await client.get(`/api/sea/ordens?warehouse_id=${warehouseId}`);
      setList(resp.data?.orders || []);
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
      <RefreshScroll onRefresh={load} style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        {!detail && <CodeInput placeholder="Código de barras da OT" onSubmit={open} buttonLabel="ABRIR" />}
        <Message message={message} />

        {!detail && list === null && <Text style={ui.empty}>Carregando…</Text>}
        {!detail && list && list.length === 0 && <Text style={ui.empty}>Nenhuma ordem neste local.</Text>}
        {!detail && (list || []).map((o) => (
          <TouchableOpacity key={o.row_id} style={ui.line} onPress={() => open(o.ot)} accessibilityLabel={`Abrir ordem ${o.order_number}`}>
            <View style={{ flex: 1 }}>
              <Text style={ui.code}>{orderName(o)}</Text>
              <Text style={ui.meta}>
                {STATUS[o.status] || o.status} · recebido {o.qty_received}/{o.qty_ordered} · armazenado {o.qty_stored} · retirado {o.qty_withdrawn}
                {o.ot_status === 'PARTIAL' && o.status !== 'PARTIAL' ? `\nOT ${o.ot} em recebimento parcial: falta(m) ${o.ot_pending_materials} material(is)` : ''}
              </Text>
              <Text style={ui.meta}>{o.bins ? `${o.bins} · ` : ''}OT {o.ot}</Text>
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
                      Lote {m.lot_number || '-'} · previsto {formatQuantity(m.quantity_ordered, m.uom)} · recebido {m.quantity_received}
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
      </RefreshScroll>
    </SafeAreaView>
  );
}
