import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState, KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useAuth } from '../auth/AuthContext';
import { biometricError, unlockMode } from '../auth/appLock';
import { Button } from './ui';
import { apiError } from '../utils/sea';
import { unregisterDevice } from '../notifications';
import { colors, radii } from '../theme/styles';

// Lock screen and fingerprint registration, shown over the app (see
// auth/appLock.js). It is a Modal: it covers the screens and any window
// they opened (camera, confirmations) without unmounting them, and the
// back button does not reach the screen underneath.

async function phoneMode() {
  try {
    const [isEnrolled, securityLevel] = await Promise.all([
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);
    return unlockMode({ isEnrolled, securityLevel });
  } catch {
    return 'none';
  }
}

// Mode of the phone, checked again whenever the app comes back to the
// front (the user may have registered a fingerprint in the settings).
function usePhoneMode() {
  const [mode, setMode] = useState(null);
  const refresh = useCallback(() => phoneMode().then(setMode), []);
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);
  return [mode, refresh];
}

export default function AppLock() {
  const { user, locked, needsEnrollment } = useAuth();
  const visible = !!user && !user.must_change_password && (locked || needsEnrollment);
  return (
    <Modal visible={visible} animationType="none" statusBarTranslucent onRequestClose={() => {}}>
      {visible && (needsEnrollment ? <Enroll /> : <Unlock />)}
    </Modal>
  );
}

function Frame({ title, children }) {
  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>SEA</Text>
        <Text style={styles.title}>{title}</Text>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function LogoutLink() {
  const { logout } = useAuth();
  // Same as leaving from the home screen: this phone stops receiving the
  // notifications of who logs out.
  async function signOut() {
    await unregisterDevice();
    logout();
  }
  return (
    <TouchableOpacity style={styles.link} onPress={signOut} accessibilityRole="button">
      <Text style={styles.linkText}>Sair da conta</Text>
    </TouchableOpacity>
  );
}

// After the first password login of this user on this phone.
function Enroll() {
  const { user, enrollFingerprint } = useAuth();
  const [mode, refresh] = usePhoneMode();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function enroll() {
    setError('');
    setBusy(true);
    try {
      const result = await enrollFingerprint();
      if (!result.success) setError(biometricError(result) || 'Ativação cancelada. Toque no botão para tentar de novo.');
    } catch {
      setError('Não foi possível usar o bloqueio do celular. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }

  function openSettings() {
    Linking.sendIntent('android.settings.SECURITY_SETTINGS').catch(() => Linking.openSettings());
  }

  const name = user?.full_name || user?.username;
  return (
    <Frame title="Proteja o seu acesso">
      <Text style={styles.text}>
        {name ? `${name}, para` : 'Para'} a segurança do SEA, o app fica bloqueado sempre que for fechado ou ficar em
        segundo plano. O que estiver em andamento continua lá depois de desbloquear.
      </Text>
      {mode === null && <Text style={styles.text}>Verificando o bloqueio do celular…</Text>}
      {mode === 'biometric' && (
        <Button label={busy ? 'AGUARDANDO A DIGITAL...' : 'CADASTRAR DIGITAL'} onPress={enroll} disabled={busy} />
      )}
      {mode === 'device' && (
        <>
          <Text style={styles.warning}>
            Este celular não tem digital cadastrada. O SEA vai abrir com a senha do celular (PIN, padrão ou senha
            de desbloqueio).
          </Text>
          <Button label={busy ? 'AGUARDANDO...' : 'USAR A SENHA DO CELULAR'} onPress={enroll} disabled={busy} />
        </>
      )}
      {mode === 'none' && (
        <>
          <Text style={styles.warning}>
            Este celular está sem bloqueio de tela. Para usar o SEA, configure um PIN, padrão ou digital nas
            configurações do aparelho (Segurança › Bloqueio de tela) e volte ao app.
          </Text>
          <Button label="ABRIR CONFIGURAÇÕES" onPress={openSettings} />
          <Button label="JÁ CONFIGUREI" secondary onPress={refresh} style={{ marginTop: 10 }} />
        </>
      )}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <LogoutLink />
    </Frame>
  );
}

function Unlock() {
  const { user, unlockWithFingerprint, unlockWithPassword } = useAuth();
  const [mode] = usePhoneMode();
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const prompting = useRef(false);

  const fingerprint = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    setError('');
    try {
      const result = await unlockWithFingerprint();
      if (!result.success) {
        const message = biometricError(result);
        if (message) setError(message);
        if (result.error === 'user_cancel' || result.error === 'lockout') setUsePassword(true);
      }
    } catch {
      setError('Não foi possível usar o leitor de digital. Use a senha.');
      setUsePassword(true);
    } finally {
      prompting.current = false;
    }
  }, [unlockWithFingerprint]);

  // Asks for the fingerprint as soon as the app is in front: at once when
  // it already is, otherwise when the user comes back to it.
  useEffect(() => {
    if ((mode !== 'biometric' && mode !== 'device') || usePassword) return undefined;
    if (AppState.currentState === 'active') fingerprint();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') fingerprint(); });
    return () => sub.remove();
  }, [mode, usePassword, fingerprint]);

  async function submitPassword() {
    if (!password) { setError('Informe a sua senha.'); return; }
    setError('');
    setBusy(true);
    try {
      await unlockWithPassword(password);
    } catch (err) {
      setPassword('');
      if (err.userMessage) setError(err.userMessage);
      else if (err.response?.status === 401) setError('Senha incorreta.');
      else if (err.response?.status === 429) setError('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
      else setError(apiError(err, 'Não foi possível conferir a senha.'));
    } finally {
      setBusy(false);
    }
  }

  const phoneUnlock = mode === 'biometric' || mode === 'device';
  const showPassword = usePassword || (mode !== null && !phoneUnlock);
  return (
    <Frame title="SEA bloqueado">
      <Text style={styles.text}>{user?.full_name || user?.username}</Text>
      {phoneUnlock && (
        <Button
          label={mode === 'biometric' ? 'DESBLOQUEAR COM DIGITAL' : 'DESBLOQUEAR COM A SENHA DO CELULAR'}
          onPress={() => { setUsePassword(false); fingerprint(); }} disabled={busy}
        />
      )}
      {showPassword ? (
        <>
          <TextInput
            style={[styles.input, phoneUnlock && { marginTop: 16 }]} value={password} onChangeText={setPassword}
            placeholder="Senha do SEA" placeholderTextColor={colors.textPlaceholder} secureTextEntry autoCapitalize="none"
            accessibilityLabel="Senha" returnKeyType="go" onSubmitEditing={submitPassword}
          />
          <Button label={busy ? 'CONFERINDO...' : 'DESBLOQUEAR COM A SENHA DO SEA'} secondary={phoneUnlock} onPress={submitPassword} disabled={busy} />
        </>
      ) : (
        <TouchableOpacity style={styles.link} onPress={() => setUsePassword(true)} accessibilityRole="button">
          <Text style={styles.linkText}>Usar a senha do SEA</Text>
        </TouchableOpacity>
      )}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <LogoutLink />
    </Frame>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  logo: { fontSize: 44, fontWeight: '900', letterSpacing: 2, color: colors.copper, textAlign: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, textAlign: 'center', marginTop: 8, marginBottom: 20 },
  text: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', marginBottom: 20, lineHeight: 21 },
  warning: { fontSize: 14, color: colors.textPrimary, marginBottom: 16, lineHeight: 20 },
  input: {
    minHeight: 52, paddingHorizontal: 14, marginBottom: 12, fontSize: 16, color: colors.textPrimary,
    backgroundColor: colors.inputBg, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input,
  },
  error: { fontSize: 14, color: colors.danger, marginTop: 12, textAlign: 'center' },
  link: { marginTop: 24, alignSelf: 'center', padding: 8 },
  linkText: { fontSize: 13, color: colors.textMuted, textDecorationLine: 'underline' },
});
