import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import client from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import CodeInput from '../components/CodeInput';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { AddressPicker, Button, Card, Field, Message, QuantityInput, ui } from '../components/ui';
import { apiError, formatQuantity, orderName, parseQuantity, quantityProblem } from '../utils/sea';
import { screenStyles } from '../theme/styles';

// Armazenagem. Lists what waits in the receiving areas of every location
// the user works in; the material goes to a shelf of any location (an
// order received in the Expedição is stored in the SP12 or in the
// SP13). The API applies the storage rules.

export default function ArmazenarScreen({ navigation }) {
  const [pending, setPending] = useState(null);
  const [bins, setBins] = useState([]);
  const [active, setActive] = useState(null);
  const [suggested, setSuggested] = useState(null);
  const [target, setTarget] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      // What waits in every location of the user, with the order of each material.
      const [pendResp, binResp] = await Promise.all([
        client.get('/api/sea/armazenagem/pendentes'),
        client.get('/api/sea/armazenagem/destinos'),
      ]);
      setBins(binResp.data?.bins || []);
      setPending(pendResp.data?.pending_items || []);
    } catch (err) {
      setPending([]);
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar o que aguarda armazenagem.') });
    }
  }, []);

  // Not while a material is being stored: the form stays as it is.
  useAutoRefresh(load, { paused: !!active });

  async function select(row) {
    setActive(row);
    setTarget(null);
    setSuggested(null);
    setQuantity(String(row.quantity));
    setMessage(null);
    try {
      const resp = await client.get(`/api/sea/armazenagem/sugestao/${row.inventory_id}`);
      if (resp.data?.bin_id) setSuggested(resp.data);
    } catch {
      // No suggestion: the operator chooses the address.
    }
  }

  // An address code read or typed must be one of the offered destinations.
  function pickByCode(code) {
    const wanted = code.toUpperCase();
    const matches = bins.filter((b) => b.bin_code.toUpperCase() === wanted);
    if (matches.length === 1) { setTarget(matches[0]); setMessage(null); return; }
    setMessage({ type: 'error', text: matches.length > 1 ? `Há mais de um endereço ${code}. Escolha na lista.` : `Endereço ${code} não encontrado entre os destinos.` });
  }

  async function confirm() {
    const problem = quantityProblem(quantity, { max: active.quantity });
    if (problem) { setMessage({ type: 'error', text: problem }); return; }
    if (!target) { setMessage({ type: 'error', text: 'Escolha o endereço de destino.' }); return; }
    setBusy(true);
    try {
      await client.post('/api/putaway/confirm', {
        item_id: active.item_id, from_bin_id: active.bin_id, to_bin_id: target.bin_id,
        quantity: parseQuantity(quantity), lot_number: active.lot_number,
      });
      setMessage({ type: 'ok', text: `${parseQuantity(quantity)} de ${active.sku} armazenado(s) em ${target.warehouse_code} · ${target.bin_code}.` });
      setActive(null);
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível armazenar.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="ARMAZENAR" onBack={() => (active ? setActive(null) : navigation.goBack())} />
      <ScrollView style={screenStyles.content} contentContainerStyle={screenStyles.contentInner} keyboardShouldPersistTaps="handled">
        <Message message={message} />

        {!active && (
          <Card title="AGUARDANDO ARMAZENAGEM">
            {pending === null && <Text style={ui.empty}>Carregando…</Text>}
            {pending && pending.length === 0 && <Text style={ui.empty}>Nada aguardando armazenagem.</Text>}
            {(pending || []).map((p) => (
              <TouchableOpacity key={p.inventory_id} style={ui.line} onPress={() => select(p)} accessibilityLabel={`Armazenar ${p.sku}`}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.code}>{p.sku}</Text>
                  <Text style={ui.name}>{p.item_name}</Text>
                  <Text style={ui.meta}>Ordem {orderName(p)} · em {p.warehouse_code} · {p.bin_code}</Text>
                </View>
                <Text style={ui.code}>{p.quantity}</Text>
              </TouchableOpacity>
            ))}
          </Card>
        )}

        {active && (
          <Card title={`${active.sku} · ${active.item_name}`}>
            <Field label="ORIGEM" value={`${active.warehouse_code} · ${active.bin_code}`} />
            <Field label="ORDEM" value={orderName(active)} />
            <Field label="OT" value={active.lot_number} />
            <Field label="AGUARDANDO" value={formatQuantity(active.quantity)} />
            {suggested && (
              <Button
                label={`USAR SUGESTÃO: ${suggested.warehouse_code ? `${suggested.warehouse_code} · ` : ''}${suggested.bin_code}`} secondary
                onPress={() => setTarget(bins.find((b) => b.bin_id === suggested.bin_id) || null)}
                style={{ marginVertical: 8 }}
              />
            )}
            <CodeInput placeholder="Código do endereço de destino" onSubmit={pickByCode} disabled={busy} />
            <Button label="ESCOLHER NA LISTA" secondary onPress={() => setPicking(true)} />
            <Field label="DESTINO" value={target ? `${target.warehouse_code} · ${target.bin_code}` : 'não escolhido'} />
            <QuantityInput value={quantity} onChangeText={setQuantity} hint="Pode armazenar só uma parte; o restante continua aguardando." />
            <Button label="CONFIRMAR ARMAZENAGEM" onPress={confirm} disabled={busy} />
          </Card>
        )}
      </ScrollView>

      <AddressPicker
        visible={picking} bins={bins} excludeBinId={active?.bin_id} suggestedBinId={suggested?.bin_id}
        onPick={(bin) => { setTarget(bin); setPicking(false); setMessage(null); }} onClose={() => setPicking(false)}
      />
    </SafeAreaView>
  );
}
