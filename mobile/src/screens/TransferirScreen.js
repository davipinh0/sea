import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import client from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import CodeInput from '../components/CodeInput';
import { AddressPicker, Button, Card, Field, Message, QuantityInput, ui } from '../components/ui';
import { apiError, formatQuantity, orderName, parseQuantity, quantityProblem } from '../utils/sea';
import { screenStyles } from '../theme/styles';
import RefreshScroll from '../components/RefreshScroll';

// Transferência entre endereços. Find a material by its code, see where
// it is, and move it to another shelf of the same location (A1 to B2) or
// to another location (SP12 to the SP13). The API applies
// the rules (free balance, whole boxes, size class, capacity, compatibility).

export default function TransferirScreen({ navigation, route }) {
  const [item, setItem] = useState(null);
  const [stock, setStock] = useState([]);
  const [bins, setBins] = useState([]);
  const [moving, setMoving] = useState(null);
  const [target, setTarget] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.get('/api/sea/armazenagem/destinos')
      .then((resp) => setBins(resp.data?.bins || []))
      .catch(() => setBins([]));
  }, []);

  const loadStock = useCallback(async (itemId) => {
    const resp = await client.get(`/api/sea/materiais/${itemId}/estoque`);
    setStock(resp.data?.stock || []);
  }, []);

  const find = useCallback(async (code, keepMessage = false) => {
    if (!keepMessage) setMessage(null);
    setMoving(null);
    setBusy(true);
    try {
      const resp = await client.get(`/api/lookup/item/${encodeURIComponent(code)}`);
      setItem(resp.data.item);
      await loadStock(resp.data.item.item_id);
    } catch (err) {
      setItem(null);
      setStock([]);
      setMessage({ type: 'error', text: err.response?.status === 404 ? `Material ${code} não encontrado.` : apiError(err, 'Não foi possível consultar o material.') });
    } finally {
      setBusy(false);
    }
  }, [loadStock]);

  // Opened from a code read on the home screen.
  const initialCode = route?.params?.code;
  useEffect(() => { if (initialCode) find(initialCode); }, [initialCode, find]);

  function start(row) {
    setMoving(row);
    setTarget(null);
    setQuantity(String(row.available));
    setMessage(null);
  }

  function pickByCode(code) {
    const wanted = code.toUpperCase();
    const matches = bins.filter((b) => b.bin_code.toUpperCase() === wanted && b.bin_id !== moving.bin_id);
    if (matches.length === 1) { setTarget(matches[0]); setMessage(null); return; }
    setMessage({ type: 'error', text: matches.length > 1 ? `Há mais de um endereço ${code}. Escolha na lista.` : `Endereço ${code} não encontrado entre os destinos.` });
  }

  async function confirm() {
    const problem = quantityProblem(quantity, { max: moving.available, packWeightKg: moving.pack_weight_kg });
    if (problem) { setMessage({ type: 'error', text: problem }); return; }
    if (!target) { setMessage({ type: 'error', text: 'Escolha o endereço de destino.' }); return; }
    setBusy(true);
    try {
      const resp = await client.post('/api/sea/transferencias', {
        inventory_id: moving.inventory_id, to_bin_id: target.bin_id, quantity: parseQuantity(quantity),
      });
      setMessage({ type: 'ok', text: `${formatQuantity(resp.data.quantity, moving.uom, moving.pack_weight_kg)} de ${resp.data.sku} transferido(s) de ${resp.data.from} para ${resp.data.to}.` });
      setMoving(null);
      await loadStock(item.item_id);
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível transferir.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="TRANSFERIR" onBack={() => (moving ? setMoving(null) : navigation.goBack())} />
      <RefreshScroll onRefresh={() => (item ? loadStock(item.item_id) : undefined)} style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        {!moving && <CodeInput placeholder="Código do material" onSubmit={find} disabled={busy} buttonLabel="BUSCAR" />}
        <Message message={message} />

        {item && !moving && (
          <Card title={`${item.sku} · ${item.item_name}`}>
            {stock.length === 0 && <Text style={ui.empty}>Sem saldo em estoque.</Text>}
            {stock.map((s) => (
              <TouchableOpacity
                key={s.inventory_id} style={ui.line} disabled={!s.stored || s.available <= 0} onPress={() => start(s)}
                accessibilityLabel={`Transferir de ${s.warehouse_code} ${s.bin_code}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={ui.code}>{s.warehouse_code} · {s.bin_code}</Text>
                  <Text style={ui.meta}>
                    Ordem {orderName(s)}{s.quantity_allocated > 0 ? ` · ${s.quantity_allocated} reservado(s)` : ''}
                    {!s.stored ? ' · área de recebimento (use Armazenar)' : ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={ui.code}>{formatQuantity(s.quantity_on_hand, s.uom, s.pack_weight_kg)}</Text>
                  {s.stored && s.available > 0 ? <Text style={ui.tag}>TRANSFERIR</Text> : null}
                </View>
              </TouchableOpacity>
            ))}
          </Card>
        )}

        {moving && (
          <Card title={`${item.sku} · ${item.item_name}`}>
            <Field label="ORIGEM" value={`${moving.warehouse_code} · ${moving.bin_code}`} />
            <Field label="SALDO LIVRE" value={formatQuantity(moving.available, moving.uom, moving.pack_weight_kg)} />
            <CodeInput placeholder="Código do endereço de destino" onSubmit={pickByCode} disabled={busy} />
            <Button label="ESCOLHER NA LISTA" secondary onPress={() => setPicking(true)} />
            <Field label="DESTINO" value={target ? `${target.warehouse_code} · ${target.bin_code}` : 'não escolhido'} />
            <QuantityInput
              label={`QUANTIDADE${moving.uom ? ` (${moving.uom})` : ''}`} value={quantity} onChangeText={setQuantity}
              hint={moving.pack_weight_kg ? `Caixas inteiras de ${moving.pack_weight_kg} KG.` : 'O que está reservado para retirada não se move.'}
            />
            <Button label="CONFIRMAR TRANSFERÊNCIA" onPress={confirm} disabled={busy} />
          </Card>
        )}
      </RefreshScroll>

      <AddressPicker
        visible={picking} bins={bins} excludeBinId={moving?.bin_id}
        onPick={(bin) => { setTarget(bin); setPicking(false); setMessage(null); }} onClose={() => setPicking(false)}
      />
    </SafeAreaView>
  );
}
