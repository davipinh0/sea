import React, { useState } from 'react';
import { Modal, View, Text, TextInput, StyleSheet } from 'react-native';
import { setApiUrl } from '../api/client';
import { Button } from './ui';
import { colors, radii } from '../theme/styles';

// Change the address of the server this phone talks to. Only a system
// administrator may do it: the change is accepted when the administrator's
// user and password are valid AT THE NEW ADDRESS. That also works when the
// current address stopped answering (e.g. the computer changed its IP),
// which is exactly when the address needs changing.
//
// The current address is never shown.

const TIMEOUT_MS = 8000;

async function adminLogin(url, username, password) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: controller.signal,
    });
    if (resp.status === 401) return 'Usuário ou senha inválidos.';
    if (resp.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    // The address is right, but the system behind it is starting or down.
    if (resp.status >= 500) return 'O servidor do SEA está iniciando ou fora do ar. Tente de novo em instantes.';
    if (!resp.ok) return 'O endereço respondeu, mas não é um servidor do SEA.';
    const data = await resp.json();
    if (data?.user?.role !== 'ADMIN') return 'Só um administrador do sistema pode alterar o servidor.';
    return null;
  } catch {
    return 'Não foi possível conectar a esse endereço. Confira o endereço e a rede.';
  } finally {
    clearTimeout(timer);
  }
}

export default function ServerDialog({ visible, onClose, onChanged }) {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function close() {
    setUrl(''); setUsername(''); setPassword(''); setError('');
    onClose();
  }

  async function save() {
    const clean = url.replace(/\/+$/, '').trim();
    if (!/^https?:\/\/.+/i.test(clean)) { setError('Informe o endereço começando com http:// ou https://.'); return; }
    if (!username.trim() || !password) { setError('Informe o usuário e a senha de um administrador.'); return; }
    setBusy(true);
    setError('');
    const problem = await adminLogin(clean, username.trim(), password);
    setBusy(false);
    if (problem) { setError(problem); return; }
    await setApiUrl(clean);
    close();
    onChanged?.();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>SERVIDOR DO SEA</Text>
          <Text style={styles.note}>Alteração restrita ao administrador do sistema. Informe o novo endereço e confirme com o seu usuário.</Text>
          <TextInput
            style={styles.input} value={url} onChangeText={setUrl} placeholder="Novo endereço do servidor"
            placeholderTextColor={colors.textPlaceholder} autoCapitalize="none" autoCorrect={false} keyboardType="url"
            accessibilityLabel="Novo endereço do servidor"
          />
          <TextInput
            style={styles.input} value={username} onChangeText={setUsername} placeholder="Usuário administrador"
            placeholderTextColor={colors.textPlaceholder} autoCapitalize="none" autoCorrect={false}
            accessibilityLabel="Usuário administrador"
          />
          <TextInput
            style={styles.input} value={password} onChangeText={setPassword} placeholder="Senha" secureTextEntry
            placeholderTextColor={colors.textPlaceholder} autoCapitalize="none" accessibilityLabel="Senha do administrador"
          />
          {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
          <View style={styles.actions}>
            <Button label={busy ? 'VERIFICANDO...' : 'SALVAR'} onPress={save} disabled={busy} style={{ flex: 1 }} />
            <Button label="CANCELAR" secondary onPress={close} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: colors.background, borderRadius: radii.card, padding: 18, borderWidth: 1, borderColor: colors.cardBorder },
  title: { fontSize: 14, fontWeight: '800', letterSpacing: 0.5, color: colors.textPrimary, marginBottom: 6 },
  note: { fontSize: 13, color: colors.textSecondary, marginBottom: 12 },
  input: {
    minHeight: 48, paddingHorizontal: 12, marginBottom: 10, fontSize: 15, color: colors.textPrimary,
    backgroundColor: colors.inputBg, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input,
  },
  error: { fontSize: 13, color: colors.danger, marginBottom: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
});
