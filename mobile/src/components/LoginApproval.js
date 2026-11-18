import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Modal, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import client from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { biometricError, withoutLock } from '../auth/appLock';
import { getDeviceToken, onLoginApprovalPush } from '../notifications';
import { apiError } from '../utils/sea';
import { approvalSummary } from '../utils/loginApproval';
import { Button } from './ui';
import { colors, radii } from '../theme/styles';

// "Você está entrando no SEA?" (mig 092). A password login of this user
// outside this phone (web panel, terminal, another phone) waits here: the
// user confirms with the fingerprint or the phone's PIN/pattern, or denies.
// It shows over any screen once the app is unlocked.

const REFRESH_MS = 10000;

export default function LoginApproval() {
  const { user, locked, needsEnrollment } = useAuth();
  const ready = !!user && !user.must_change_password && !locked && !needsEnrollment;
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const resp = await client.get('/api/sea/login/pendentes');
      setPending(resp.data?.pending || []);
    } catch {
      // Offline: the next round (or the next push) tries again.
    }
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    load();
    const stopPush = onLoginApprovalPush(load);
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') load(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') load(); }, REFRESH_MS);
    return () => { stopPush(); sub.remove(); clearInterval(timer); };
  }, [ready, load]);

  const current = ready ? pending[0] : null;

  async function decide(approve) {
    setMessage(null);
    setBusy(true);
    try {
      if (approve) {
        const result = await withoutLock(() => LocalAuthentication.authenticateAsync({
          promptMessage: 'Confirme que é você',
          cancelLabel: 'Cancelar',
          disableDeviceFallback: false,
        }));
        if (!result.success) {
          setMessage({ error: true, text: biometricError(result) || 'Confirmação cancelada. O login continua aguardando.' });
          return;
        }
      }
      const deviceToken = await getDeviceToken();
      if (!deviceToken) {
        setMessage({ error: true, text: 'Este celular não está cadastrado para confirmar logins. Ative as notificações do SEA e entre de novo no app.' });
        return;
      }
      await client.post(`/api/sea/login/${current.challenge_id}/decidir`, { approve, device_token: deviceToken });
      const done = current.purpose ? 'Processo liberado no painel.' : 'Login confirmado.';
      setMessage({ text: approve ? done : 'Negado. Se não foi você, troque a sua senha.' });
      await load();
    } catch (err) {
      setMessage({ error: true, text: apiError(err, 'Não foi possível responder. Tente de novo.') });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const info = current ? approvalSummary(current) : null;
  return (
    <>
      <Modal visible={!!current} transparent animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
        <View style={styles.overlay}>
          <View style={styles.card} accessibilityRole="alert">
            <Text style={styles.title}>{info?.title || 'Você está entrando no SEA?'}</Text>
            {info && (
              <>
                <Text style={styles.line}>{info.client}</Text>
                <Text style={styles.meta}>{info.when}{info.ip ? ` · IP ${info.ip}` : ''}</Text>
                <Text style={styles.meta}>Responda em até {info.timeLeft}.</Text>
              </>
            )}
            {message?.error && <Text style={styles.error}>{message.text}</Text>}
            <Button label={busy ? 'AGUARDE...' : 'SIM, SOU EU'} onPress={() => decide(true)} disabled={busy} style={{ marginTop: 16 }} />
            <Button label="NÃO, NEGAR" danger onPress={() => decide(false)} disabled={busy} style={{ marginTop: 10 }} />
          </View>
        </View>
      </Modal>
      <Modal visible={!current && !!message && !message.error} transparent animationType="fade" onRequestClose={() => setMessage(null)}>
        <View style={styles.overlay}>
          <View style={styles.card} accessibilityRole="alert">
            <Text style={styles.title}>{message?.text}</Text>
            <Button label="OK" onPress={() => setMessage(null)} style={{ marginTop: 16 }} />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.cardBg, borderRadius: radii.card, padding: 20 },
  title: { fontSize: 18, fontWeight: '800', color: colors.textPrimary, textAlign: 'center', marginBottom: 10 },
  line: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  meta: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 4 },
  error: { fontSize: 14, color: colors.danger, textAlign: 'center', marginTop: 12 },
});
