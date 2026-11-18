import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { confirmIdentity } from '../auth/confirmIdentity';
import client from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import CodeInput from '../components/CodeInput';
import { Button, Card, Field, Message, ui } from '../components/ui';
import { apiError, formatQuantity, parseQuantity } from '../utils/sea';
import { colors, fonts, radii, screenStyles } from '../theme/styles';

// Recebimento de ordem. Same flow and same API as the panel:
//   1. read or type the OT code;
//   2. an OT not registered yet is looked up in the SAP base: its
//      materials (order, quantity, unit) and requester are shown and the
//      delivery is registered as the base holds it. The receiver is the
//      logged-in user (the API fills it in);
//   3. receive each material, in part or in full, into the receiving area.

export default function ReceberScreen({ navigation, route }) {
  const { warehouseId, user } = useAuth();
  const [areas, setAreas] = useState([]);
  const [areaId, setAreaId] = useState(null);
  const [ot, setOt] = useState(null);          // registered OT being received
  const [lines, setLines] = useState([]);
  const [details, setDetails] = useState({});  // po_line_id -> material (order, unit, box)
  const [qty, setQty] = useState({});
  const [fromBase, setFromBase] = useState(null); // OT found in the SAP base, not registered
  const [notFound, setNotFound] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!warehouseId) return;
    client.get(`/api/sea/recebimentos/areas?warehouse_id=${warehouseId}`)
      .then((resp) => {
        const list = resp.data?.bins || [];
        setAreas(list);
        setAreaId((current) => current || list[0]?.bin_id || null);
      })
      .catch((err) => setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar as áreas de recebimento.') }));
  }, [warehouseId]);

  const load = useCallback(async (code, keepMessage = false) => {
    if (!keepMessage) setMessage(null);
    setFromBase(null);
    setNotFound(null);
    setBusy(true);
    try {
      const resp = await client.get(`/api/receiving/po/${encodeURIComponent(code)}`);
      const order = resp.data.purchase_order;
      const orderLines = resp.data.lines || [];
      setOt(order);
      setLines(orderLines);
      setQty(Object.fromEntries(orderLines.map((l) => [l.po_line_id, String(Math.max(0, l.quantity_remaining))])));
      // Order, unit and box weight of each material.
      try {
        const detail = await client.get(`/api/sea/ots/${encodeURIComponent(order.po_number)}`);
        setDetails(Object.fromEntries((detail.data.materials || []).map((m) => [m.po_line_id, m])));
      } catch {
        setDetails({});
      }
    } catch (err) {
      setOt(null);
      setLines([]);
      if (err.response?.status !== 404) {
        setMessage({ type: 'error', text: apiError(err, 'Não foi possível consultar a OT.') });
      } else {
        try {
          const lookup = await client.get(`/api/sea/recebimentos/consulta?codigo=${encodeURIComponent(code)}`);
          const data = lookup.data?.integration?.data;
          if (data) setFromBase(data);
          else setNotFound(code);
        } catch (lookupErr) {
          setMessage({ type: 'error', text: apiError(lookupErr, 'Não foi possível consultar a base do SAP.') });
        }
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // Opening an OT to receive asks for the fingerprint or the phone's PIN.
  const openOt = useCallback(async (code) => {
    const problem = await confirmIdentity('Confirme para receber a OT');
    if (problem) { setMessage({ type: 'error', text: problem }); return; }
    await load(code);
  }, [load]);

  // Opened from a code read on the home screen.
  const initialCode = route?.params?.code;
  useEffect(() => { if (initialCode) openOt(initialCode); }, [initialCode, openOt]);

  async function registerFromBase() {
    setBusy(true);
    try {
      const resp = await client.post('/api/sea/recebimentos/base', { warehouse_id: warehouseId, ot_code: fromBase.header.ot_code });
      setMessage({ type: 'ok', text: `Entrega da OT ${resp.data.ot} registrada. Confira e receba os materiais.` });
      await load(resp.data.ot, true);
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível registrar a entrega.') });
      setBusy(false);
    }
  }

  // ``full`` receives every pending material in its remaining quantity.
  async function receive(targets, full = false) {
    const items = targets
      .map((l) => ({ line: l, quantity: full ? l.quantity_remaining : parseQuantity(qty[l.po_line_id]) }))
      .filter((x) => x.quantity && x.quantity > 0);
    if (items.length === 0) { setMessage({ type: 'error', text: 'Informe ao menos uma quantidade maior que zero.' }); return; }
    const over = items.find((x) => x.quantity > x.line.quantity_remaining);
    if (over) { setMessage({ type: 'error', text: `A quantidade de ${over.line.sku} (${over.quantity}) é maior que o restante previsto (${over.line.quantity_remaining}).` }); return; }
    if (!areaId) { setMessage({ type: 'error', text: 'Nenhuma área de recebimento cadastrada neste local.' }); return; }
    setBusy(true);
    try {
      await client.post('/api/receiving/receive', {
        po_id: ot.po_id,
        items: items.map((x) => ({ item_id: x.line.item_id, quantity: x.quantity, bin_id: areaId })),
      });
      const total = items.reduce((sum, x) => sum + x.quantity, 0);
      const code = ot.po_number;
      await load(code, true);
      setMessage({ type: 'ok', text: `${total} unidade(s) recebida(s). Material disponível para armazenagem.` });
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível registrar o recebimento.') });
      setBusy(false);
    }
  }

  const receivable = ot && (ot.status === 'OPEN' || ot.status === 'PARTIAL');
  const pending = lines.filter((l) => l.quantity_remaining > 0);
  const receiver = user?.full_name || user?.username;

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="RECEBER" onBack={() => navigation.goBack()} />
      <ScrollView style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        <CodeInput placeholder="Código de barras da OT" onSubmit={openOt} disabled={busy} buttonLabel="CONSULTAR" />
        <Message message={message} />

        {fromBase && (
          <Card title={`OT ${fromBase.header.ot_code} · BASE DO SAP`}>
            <Field label="RESERVA" value={fromBase.header.reservation_number} />
            <Field label="SOLICITANTE" value={fromBase.header.requester_name} />
            <Field label="RECEBEDOR" value={receiver} />
            {fromBase.materials.map((m) => (
              <View key={m.material_code} style={ui.line}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.code}>{m.material_code}</Text>
                  <Text style={ui.name}>{m.description}</Text>
                  <Text style={ui.meta}>Ordem {m.service_order_type} {m.service_order_number}</Text>
                </View>
                <Text style={ui.code}>{formatQuantity(m.quantity, m.uom)}</Text>
              </View>
            ))}
            <Button label="REGISTRAR ENTREGA" onPress={registerFromBase} disabled={busy} style={{ marginTop: 12 }} />
          </Card>
        )}

        {notFound && (
          <Card title={`OT ${notFound} NÃO ENCONTRADA`}>
            <Text style={ui.name}>Ela não está cadastrada nem na base do SAP. Confira o código lido. O cadastro pela etiqueta é feito no painel.</Text>
          </Card>
        )}

        {ot && (
          <Card title={`OT ${ot.po_number}${ot.order_type ? ` · ${ot.order_type}` : ''}`}>
            {!receivable && <Text style={ui.tag}>Ordem já recebida ou fechada</Text>}
            {areas.length > 1 && (
              <View style={{ marginBottom: 8 }}>
                <Text style={styles.label}>ÁREA DE RECEBIMENTO</Text>
                <View style={styles.areas}>
                  {areas.map((a) => (
                    <TouchableOpacity key={a.bin_id} style={[styles.area, a.bin_id === areaId && styles.areaActive]} onPress={() => setAreaId(a.bin_id)}>
                      <Text style={styles.areaText}>{a.bin_code}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            {lines.map((l) => {
              const m = details[l.po_line_id] || {};
              return (
                <View key={l.po_line_id} style={ui.line}>
                  <View style={{ flex: 1 }}>
                    <Text style={ui.code}>{l.sku}</Text>
                    <Text style={ui.name}>{l.item_name}</Text>
                    <Text style={ui.meta}>
                      {m.service_order_number ? `Ordem ${m.service_order_type || ''} ${m.service_order_number} · ` : ''}
                      previsto {formatQuantity(l.quantity_ordered, m.uom)} · recebido {l.quantity_received} · falta {l.quantity_remaining}
                    </Text>
                  </View>
                  {receivable && l.quantity_remaining > 0 && (
                    <>
                      <TextInput
                        style={styles.qty} keyboardType="number-pad" selectTextOnFocus
                        value={qty[l.po_line_id] ?? ''} accessibilityLabel={`Quantidade a receber de ${l.sku}`}
                        onChangeText={(t) => setQty((q) => ({ ...q, [l.po_line_id]: t }))}
                      />
                      <TouchableOpacity style={styles.lineBtn} disabled={busy} onPress={() => receive([l])} accessibilityLabel={`Receber ${l.sku}`}>
                        <Text style={styles.lineBtnText}>OK</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              );
            })}
            {receivable && pending.length > 0 && (
              <Button label="RECEBER ORDEM INTEGRAL" onPress={() => receive(pending, true)} disabled={busy} style={{ marginTop: 12 }} />
            )}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted, marginBottom: 4 },
  areas: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  area: { paddingHorizontal: 12, minHeight: 40, justifyContent: 'center', borderWidth: 1.5, borderColor: colors.cardBorder, borderRadius: radii.small, backgroundColor: colors.background },
  areaActive: { borderColor: colors.copper, backgroundColor: colors.cream },
  areaText: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  qty: {
    width: 68, minHeight: 44, textAlign: 'center', fontFamily: fonts.mono, fontSize: 16, fontWeight: '700',
    color: colors.textPrimary, backgroundColor: colors.background, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.small,
  },
  lineBtn: { minWidth: 48, minHeight: 44, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.copper, borderRadius: radii.small },
  lineBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
