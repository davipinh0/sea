import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../auth/AuthContext';
import client from '../api/client';
import { approvalEndMessage } from '../utils/loginApproval';
import ServerDialog from '../components/ServerDialog';
import { Button } from '../components/ui';
import { colors, radii } from '../theme/styles';

// O endereço do servidor não aparece aqui; trocá-lo é tarefa do administrador (ServerDialog).

const LAST_USER_KEY = 'sea_last_username';

export default function LoginScreen() {
  const { login, completeLogin } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [waiting, setWaiting] = useState(null);
  const cancelled = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(LAST_USER_KEY).then((saved) => { if (saved) setUsername(saved); }).catch(() => {});
  }, []);

  async function submit() {
    const user = username.trim();
    if (!user || !password) { setError('Informe o usuário e a senha.'); return; }
    setError('');
    setBusy(true);
    AsyncStorage.setItem(LAST_USER_KEY, user).catch(() => {});
    try {
      const result = await login(user, password);
      if (result.approval) await waitForPhone(result.approval);
    } catch (err) {
      if (err.approvalEnd) {
        setError(err.message);
        setPassword('');
      } else if (err.response?.status === 401) {
        setError('Usuário ou senha inválidos.');
        setPassword('');
      } else if (err.response?.status === 429) {
        setError('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
      } else if (err.response?.status >= 500) {
        setError('O servidor do SEA está iniciando ou fora do ar. Tente de novo em instantes.');
      } else {
        setError('Sem conexão com o servidor. Confira o Wi-Fi; se continuar, peça a um administrador para conferir o endereço do servidor.');
      }
    } finally {
      setWaiting(null);
      setBusy(false);
    }
  }

  // Este não é o celular cadastrado: o login espera a confirmação no celular do usuário.
  async function waitForPhone(challenge) {
    cancelled.current = false;
    setWaiting(challenge.expires_in);
    const body = { challenge_id: challenge.challenge_id, poll_token: challenge.poll_token };
    for (;;) {
      if (cancelled.current) throw Object.assign(new Error('Login cancelado.'), { approvalEnd: true });
      let resp;
      try {
        resp = await client.post('/api/auth/login/aprovacao', body, { keepSession: true });
      } catch (err) {
        if (err.response) throw Object.assign(new Error(approvalEndMessage(err.response.status)), { approvalEnd: true });
        throw err;
      }
      if (resp.status === 200) {
        await completeLogin(resp.data);
        return;
      }
      setWaiting(resp.data?.expires_in ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.logo}>SEA</Text>
          <Text style={styles.subtitle}>Sistema de Expedição e Armazenamento</Text>

          <TextInput
            style={styles.input} value={username} onChangeText={setUsername} placeholder="Usuário ou e-mail"
            placeholderTextColor={colors.textPlaceholder} autoCapitalize="none" autoCorrect={false}
            accessibilityLabel="Usuário ou e-mail" returnKeyType="next"
          />
          <TextInput
            style={styles.input} value={password} onChangeText={setPassword} placeholder="Senha" secureTextEntry
            placeholderTextColor={colors.textPlaceholder} autoCapitalize="none" accessibilityLabel="Senha"
            returnKeyType="go" onSubmitEditing={submit}
          />
          {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
          {waiting !== null ? (
            <View style={styles.waiting} accessibilityRole="alert">
              <Text style={styles.waitingTitle}>Confirme no seu celular cadastrado</Text>
              <Text style={styles.waitingText}>
                Este celular ainda não é o cadastrado na sua conta. Abra o app SEA no seu celular e confirme o login.
                Tempo restante: {waiting} s.
              </Text>
              <Button label="CANCELAR" secondary onPress={() => { cancelled.current = true; }} />
            </View>
          ) : (
            <Button label={busy ? 'ENTRANDO...' : 'ENTRAR'} onPress={submit} disabled={busy} />
          )}

          <TouchableOpacity style={styles.serverLink} onPress={() => setShowServer(true)} accessibilityRole="button">
            <Text style={styles.serverLinkText}>Servidor (administrador)</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <ServerDialog visible={showServer} onClose={() => setShowServer(false)} onChanged={() => setError('')} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  logo: { fontSize: 44, fontWeight: '900', letterSpacing: 2, color: colors.copper, textAlign: 'center' },
  subtitle: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 32 },
  input: {
    minHeight: 52, paddingHorizontal: 14, marginBottom: 12, fontSize: 16, color: colors.textPrimary,
    backgroundColor: colors.inputBg, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input,
  },
  error: { fontSize: 14, color: colors.danger, marginBottom: 12 },
  waiting: { padding: 14, borderRadius: radii.card, borderWidth: 1, borderColor: colors.cardBorder, backgroundColor: colors.cardBg },
  waitingTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginBottom: 6 },
  waitingText: { fontSize: 14, color: colors.textSecondary, marginBottom: 12, lineHeight: 20 },
  serverLink: { marginTop: 28, alignSelf: 'center', padding: 8 },
  serverLinkText: { fontSize: 13, color: colors.textMuted, textDecorationLine: 'underline' },
});
