import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../auth/AuthContext';
import { biometricError } from '../auth/appLock';
import client from '../api/client';
import { approvalEndMessage } from '../utils/loginApproval';
import ServerDialog from '../components/ServerDialog';
import AppLogo from '../components/AppLogo';
import { Button } from '../components/ui';
import { colors, radii } from '../theme/styles';

// O endereço do servidor não aparece aqui; trocá-lo é tarefa do administrador (ServerDialog).

const LAST_USER_KEY = 'sea_last_username';

export default function LoginScreen() {
  const { login, completeLogin, savedLoginUser, loginWithSavedPassword } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [waiting, setWaiting] = useState(null);
  // Usuário com login salvo neste celular: entra com a digital ou o PIN, sem digitar a senha.
  const [savedUser, setSavedUser] = useState(null);
  const cancelled = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const saved = await savedLoginUser().catch(() => null);
      if (!active) return;
      if (saved) {
        setSavedUser(saved);
        setUsername(saved);
        // Pede a digital assim que a tela abre; cancelar deixa digitar a senha.
        enterWithSaved();
        return;
      }
      const last = await AsyncStorage.getItem(LAST_USER_KEY).catch(() => null);
      if (active && last) setUsername(last);
    })();
    return () => { active = false; };
  }, []);

  function showError(err) {
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
  }

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
      showError(err);
    } finally {
      setWaiting(null);
      setBusy(false);
    }
  }

  async function enterWithSaved() {
    setError('');
    setBusy(true);
    try {
      const result = await loginWithSavedPassword();
      if (result.biometric) {
        const message = biometricError(result.biometric);
        if (message) setError(message);
        return;
      }
      if (result.missing) {
        setSavedUser(null);
        return;
      }
      if (result.approval) await waitForPhone(result.approval);
    } catch (err) {
      if (err.response?.status === 401) {
        // A senha mudou: o login salvo já foi apagado. A próxima entrada com senha salva de novo.
        setSavedUser(null);
        setError('A senha mudou. Digite a senha nova; o login pela digital volta a funcionar depois.');
      } else {
        showError(err);
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
          <AppLogo />
          <Text style={styles.subtitle}>Sistema de Entrada e Armazenamento</Text>

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
            <>
              <Button label={busy ? 'ENTRANDO...' : 'ENTRAR'} onPress={submit} disabled={busy} />
              {savedUser ? (
                <View style={styles.savedLogin}>
                  <Button label="ENTRAR COM DIGITAL OU PIN" secondary onPress={enterWithSaved} disabled={busy} />
                </View>
              ) : null}
            </>
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
  subtitle: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 32 },
  input: {
    minHeight: 52, paddingHorizontal: 14, marginBottom: 12, fontSize: 16, color: colors.textPrimary,
    backgroundColor: colors.inputBg, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input,
  },
  error: { fontSize: 14, color: colors.danger, marginBottom: 12 },
  waiting: { padding: 14, borderRadius: radii.card, borderWidth: 1, borderColor: colors.cardBorder, backgroundColor: colors.cardBg },
  waitingTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginBottom: 6 },
  waitingText: { fontSize: 14, color: colors.textSecondary, marginBottom: 12, lineHeight: 20 },
  savedLogin: { marginTop: 12 },
  serverLink: { marginTop: 28, alignSelf: 'center', padding: 8 },
  serverLinkText: { fontSize: 13, color: colors.textMuted, textDecorationLine: 'underline' },
});
