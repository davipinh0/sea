import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import client from '../api/client';
import ScreenHeader from '../components/ScreenHeader';
import RefreshScroll from '../components/RefreshScroll';
import FadeIn from '../components/FadeIn';
import UserPhoto from '../components/UserPhoto';
import { Card, Message } from '../components/ui';
import { accessGroups, accessSummary, appModules } from '../utils/acessos';
import { apiError } from '../utils/sea';
import { colors, radii, screenStyles } from '../theme/styles';

function when(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Row({ label, sub, granted }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${granted ? 'liberado' : 'não liberado'}`}>
      <View style={[styles.mark, granted ? styles.markOn : styles.markOff]}>
        <Text style={[styles.markText, { color: granted ? colors.success : colors.textMuted }]}>{granted ? '✓' : '–'}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, !granted && styles.rowOff]}>{label}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
    </View>
  );
}

// Só mostra: quem muda permissões, locais e celulares é o administrador, no painel.
export default function AcessosScreen({ navigation }) {
  const [me, setMe] = useState(null);
  const [mine, setMine] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const [meResp, mineResp] = await Promise.all([client.get('/api/auth/me'), client.get('/api/sea/meus-acessos')]);
      setMe(meResp.data);
      setMine(mineResp.data);
      setMessage(null);
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Não foi possível carregar os seus acessos.') });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const admin = me?.role === 'ADMIN';
  let index = 0;
  const next = () => index++;

  return (
    <SafeAreaView style={screenStyles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="GERENCIAR ACESSOS" onBack={() => navigation.goBack()} />
      <RefreshScroll onRefresh={load} style={screenStyles.content} contentContainerStyle={screenStyles.contentInner}>
        <Message message={message} />
        {!me && !message && <Text style={styles.muted}>Carregando…</Text>}
        {me && (
          <>
            <FadeIn index={next()}>
              <Card>
                <View style={styles.profile}>
                  <UserPhoto userId={me.user_id} version={me.photo_version} name={me.full_name || me.username} size={56} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{me.full_name || me.username}</Text>
                    <Text style={styles.muted}>{me.username} · {admin ? 'Administrador' : 'Usuário'}</Text>
                  </View>
                </View>
                <Text style={[styles.summary, admin && { color: colors.accentRed }]}>{accessSummary(me)}</Text>
                {mine?.last_login ? <Text style={styles.muted}>Último login: {when(mine.last_login)}</Text> : null}
              </Card>
            </FadeIn>

            <FadeIn index={next()}>
              <Card title="LOCAIS">
                {mine?.all_locations && <Text style={styles.muted}>Todos os locais (administrador).</Text>}
                {mine && mine.locations.length === 0 && <Text style={styles.muted}>Nenhum local liberado.</Text>}
                {(mine?.locations || []).map((loc) => (
                  <Row key={loc.code} label={loc.code} sub={loc.name !== loc.code ? loc.name : null} granted />
                ))}
              </Card>
            </FadeIn>

            <FadeIn index={next()}>
              <Card title="NO APLICATIVO">
                {appModules(me).map((m) => <Row key={m.label} label={m.label} sub={m.sub} granted={m.granted} />)}
              </Card>
            </FadeIn>

            {accessGroups(me).map((group) => (
              <FadeIn key={group.label} index={next()}>
                <Card title={`PAINEL WEB · ${group.label.toUpperCase()} (${group.granted}/${group.items.length})`}>
                  {group.items.map((item) => <Row key={item.key} label={item.label} granted={item.granted} />)}
                </Card>
              </FadeIn>
            ))}

            {mine && (
              <FadeIn index={next()}>
                <Card title="SEGURANÇA">
                  <Row
                    label="Confirmar login no celular"
                    sub={mine.login_approval ? 'Login com senha em outro lugar espera a sua confirmação aqui.' : 'Desligado: o login usa só a senha.'}
                    granted={mine.login_approval}
                  />
                  {mine.devices.length === 0 && <Text style={styles.muted}>Nenhum celular cadastrado.</Text>}
                  {mine.devices.map((d) => (
                    <Row
                      key={`${d.ending}-${d.updated_at}`} label={`📱 ${d.device} (…${d.ending})`}
                      sub={`${d.secure_lock ? 'Bloqueio ativo: confirma logins' : 'Sem bloqueio: não confirma logins'} · ${d.signed_in ? 'conectado' : 'fora do app'} · ${when(d.updated_at)}`}
                      granted={d.secure_lock}
                    />
                  ))}
                </Card>
              </FadeIn>
            )}

            <FadeIn index={next()}>
              <Text style={styles.footer}>
                Para pedir um acesso novo, mudar de local ou tirar um celular perdido, fale com o administrador do SEA.
              </Text>
            </FadeIn>
          </>
        )}
      </RefreshScroll>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  name: { fontSize: 18, fontWeight: '800', color: colors.textPrimary },
  summary: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  muted: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 6 },
  mark: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  markOn: { borderColor: colors.success, backgroundColor: colors.successBg },
  markOff: { borderColor: colors.cardBorder, backgroundColor: 'transparent' },
  markText: { fontSize: 15, fontWeight: '900' },
  rowLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  rowOff: { color: colors.textMuted, fontWeight: '500' },
  rowSub: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  footer: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 8, marginBottom: 16, lineHeight: 18, borderRadius: radii.card },
});
