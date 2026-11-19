import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, TextInput, StyleSheet, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { reloadAppAsync } from 'expo';
import { useAuth } from '../auth/AuthContext';
import client from '../api/client';
import WarehouseSelector from '../components/WarehouseSelector';
import UserPhoto from '../components/UserPhoto';
import ServerDialog from '../components/ServerDialog';
import { Button } from '../components/ui';
import useAutoRefresh from '../hooks/useAutoRefresh';
import { readSeen, unregisterDevice } from '../notifications';
import { visibleModules } from '../utils/sea';
import { colors, radii, saveTheme, spacing, themeChoice } from '../theme/styles';
import RefreshScroll from '../components/RefreshScroll';

// Tela inicial: local selecionado, sino de notificações e menu do usuário
// no topo; abaixo, os módulos que o usuário pode abrir.

const ACCENT = { red: colors.accentRed, copper: colors.copper, gray: colors.grayAccent };
const THEMES = [['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Escuro']];

export default function HomeScreen({ navigation }) {
  const { user, warehouseId, logout, switchWarehouse, locked, needsEnrollment } = useAuth();
  const [me, setMe] = useState(user);
  const [warehouses, setWarehouses] = useState([]);
  const [counts, setCounts] = useState({});
  const [unread, setUnread] = useState(0);
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [showServer, setShowServer] = useState(false);

  // Who the user is and where they work change rarely: loaded once and
  // refreshed in the background, never in the way of the screen.
  const loadProfile = useCallback(async () => {
    try {
      const [meResp, whResp] = await Promise.all([client.get('/api/auth/me'), client.get('/api/warehouses/list')]);
      setMe(meResp.data);
      setWarehouses(whResp.data.warehouses || []);
    } catch {
      // Keeps what is on screen.
    }
  }, []);
  useEffect(() => { loadProfile(); }, [loadProfile]);

  // The first location is chosen for who has only one.
  const chosen = useRef(false);
  useEffect(() => {
    if (warehouseId || chosen.current || warehouses.length !== 1) return;
    chosen.current = true;
    switchWarehouse(warehouses[0].id);
  }, [warehouseId, warehouses, switchWarehouse]);

  // The selected location comes from what is already in memory, so
  // changing it is immediate; the counters follow in the background.
  const current = useMemo(() => warehouses.find((w) => w.id === warehouseId) || null, [warehouses, warehouseId]);
  const modules = visibleModules(me, current?.code);

  const loadCounts = useCallback(async () => {
    if (!warehouseId) return;
    client.get(`/api/sea/painel?warehouse_id=${warehouseId}`)
      .then((resp) => setCounts({
        receive: resp.data.unreceived_ots ?? resp.data.open_ots ?? 0,
        putaway: resp.data.staging_ots || 0,
        retirada: resp.data.pending_withdrawals_all ?? resp.data.pending_withdrawals ?? 0,
      }))
      .catch(() => {});
    Promise.all([readSeen(), client.get('/api/sea/notificacoes?limit=50')])
      .then(([seen, resp]) => {
        const list = resp.data?.notifications || [];
        setUnread(seen === null ? 0 : list.filter((n) => n.notification_id > seen).length);
      })
      .catch(() => {});
  }, [warehouseId]);
  useAutoRefresh(loadCounts);

  function selectWarehouse(id) {
    setPicking(false);
    setCounts({});
    switchWarehouse(id);
  }

  // The phone stops receiving notifications of who logs out.
  async function signOut() {
    setMenu(false);
    await unregisterDevice();
    logout();
  }

  async function chooseTheme(choice) {
    if (choice === themeChoice) return;
    await saveTheme(choice);
    // Every screen builds its colours when the app starts.
    reloadAppAsync('Tema alterado').catch(() => {});
  }

  // Cards adapt to the screen: two per row, one on a narrow screen or
  // when the phone uses a large font.
  const { width, fontScale } = useWindowDimensions();
  const oneColumn = width < 340 || fontScale > 1.3;
  const cardWidth = oneColumn ? width - 32 : (width - 32 - spacing.cardGap) / 2;
  const needsWarehouse = !warehouseId && warehouses.length > 1;
  // The lock / fingerprint registration screen comes first: a window
  // opened after it would cover it.
  const covered = locked || needsEnrollment;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.logo}>SEA</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.pill} onPress={() => setPicking(true)} accessibilityLabel={`Local: ${current?.code || 'não selecionado'}. Tocar para trocar`}>
            <Text style={styles.pillText} numberOfLines={1}>{current?.code || 'Local'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.bell} onPress={() => navigation.navigate('Notificacoes')} accessibilityLabel={unread ? `Notificações: ${unread} nova(s)` : 'Notificações'}>
            <Text style={styles.bellIcon}>{'\u{1F514}'}</Text>
            {unread > 0 && <View style={styles.bellBadge}><Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text></View>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.avatar} onPress={() => setMenu(true)} accessibilityLabel="Menu do usuário">
            <UserPhoto userId={me?.user_id} version={me?.photo_version} name={me?.full_name || me?.username} size={40} />
          </TouchableOpacity>
        </View>
      </View>

      <RefreshScroll onRefresh={() => Promise.all([loadProfile(), loadCounts()])} contentContainerStyle={styles.content}>
        <Text style={styles.section}>OPERAÇÕES</Text>
        {modules.length === 0 && (
          <Text style={styles.empty}>
            {current ? 'Nenhuma operação liberada para o seu usuário neste local.' : 'Selecione o local no topo da tela.'}
          </Text>
        )}
        <View style={styles.grid}>
          {modules.map((m) => (
            <TouchableOpacity key={m.key} style={[styles.card, { width: cardWidth }]} activeOpacity={0.7} onPress={() => navigation.navigate(m.screen)} accessibilityLabel={m.label}>
              <View style={[styles.stripe, { backgroundColor: ACCENT[m.accent] }]} />
              {counts[m.key] > 0 && <View style={styles.cardBadge}><Text style={styles.badgeText}>{counts[m.key]}</Text></View>}
              <Text style={styles.cardLabel}>{m.label}</Text>
              <Text style={styles.cardSub}>{m.sub}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </RefreshScroll>

      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.overlay} onPress={() => setMenu(false)}>
          <Pressable style={styles.menu} onPress={() => {}}>
            <View style={{ alignItems: 'center', marginBottom: 8 }}>
              <UserPhoto userId={me?.user_id} version={me?.photo_version} name={me?.full_name || me?.username} size={64} />
            </View>
            <Text style={styles.menuUser}>{me?.full_name || me?.username}</Text>
            <Text style={styles.menuRole}>{me?.role === 'ADMIN' ? 'Administrador' : 'Usuário'}</Text>
            <View style={styles.divider} />
            <Text style={styles.menuLabel}>TEMA</Text>
            <View style={styles.themes}>
              {THEMES.map(([value, label]) => (
                <TouchableOpacity key={value} style={[styles.theme, themeChoice === value && styles.themeActive]} onPress={() => chooseTheme(value)} accessibilityLabel={`Tema ${label}`}>
                  <Text style={[styles.themeText, themeChoice === value && styles.themeTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.divider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenu(false); setChangingPassword(true); }}>
              <Text style={styles.menuItemText}>Alterar senha</Text>
            </TouchableOpacity>
            {me?.role === 'ADMIN' && (
              <TouchableOpacity style={styles.menuItem} onPress={() => { setMenu(false); setShowServer(true); }}>
                <Text style={styles.menuItemText}>Servidor</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.menuItem} onPress={signOut}>
              <Text style={[styles.menuItemText, { color: colors.danger }]}>Sair</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <PasswordDialog visible={changingPassword} onClose={() => setChangingPassword(false)} onChanged={logout} />
      <ServerDialog visible={showServer} onClose={() => setShowServer(false)} onChanged={signOut} />
      <WarehouseSelector
        visible={!covered && (picking || needsWarehouse)} warehouses={warehouses} selected={warehouseId}
        onSelect={selectWarehouse} onClose={needsWarehouse ? undefined : () => setPicking(false)}
      />
    </SafeAreaView>
  );
}

function PasswordDialog({ visible, onClose, onChanged }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function close() {
    setForm({ current: '', next: '', confirm: '' });
    setError('');
    onClose();
  }

  async function save() {
    if (!form.current || !form.next || !form.confirm) { setError('Preencha os três campos.'); return; }
    if (form.next !== form.confirm) { setError('A nova senha e a confirmação não são iguais.'); return; }
    if (form.next.length < 8 || !/[A-Za-zÀ-ÿ]/.test(form.next) || !/\d/.test(form.next)) {
      setError('A nova senha precisa ter pelo menos 8 caracteres, com ao menos uma letra e um número.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await client.post('/api/auth/change-password', { current_password: form.current, new_password: form.next });
      close();
      onChanged();
    } catch (err) {
      setError(err.response?.status === 401 || err.response?.status === 400 ? 'A senha atual está incorreta ou a nova senha não foi aceita.' : 'Não foi possível alterar a senha.');
    } finally {
      setBusy(false);
    }
  }

  const field = (key, placeholder) => (
    <TextInput
      style={styles.input} value={form[key]} onChangeText={(t) => { setForm({ ...form, [key]: t }); setError(''); }}
      placeholder={placeholder} placeholderTextColor={colors.textPlaceholder} secureTextEntry autoCapitalize="none"
      accessibilityLabel={placeholder}
    />
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.menu}>
          <Text style={styles.menuUser}>Alterar senha</Text>
          <Text style={[styles.menuRole, { marginBottom: 12 }]}>Depois de alterar, entre de novo com a nova senha.</Text>
          {field('current', 'Senha atual')}
          {field('next', 'Nova senha')}
          {field('confirm', 'Confirmar nova senha')}
          {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={busy ? 'SALVANDO...' : 'ALTERAR'} onPress={save} disabled={busy} style={{ flex: 1 }} />
            <Button label="CANCELAR" secondary onPress={close} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  logo: { fontSize: 24, fontWeight: '900', letterSpacing: 1.5, color: colors.copper },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  pill: { maxWidth: 150, minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 20, backgroundColor: colors.cardBg, borderWidth: 1, borderColor: colors.cardBorder },
  pillText: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  bell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  bellIcon: { fontSize: 22 },
  bellBadge: { position: 'absolute', top: 2, right: 0, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  avatar: { width: 40, height: 40, borderRadius: 20, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, paddingBottom: 32 },
  section: { fontSize: 11, fontWeight: '700', letterSpacing: 2, color: colors.textMuted, marginBottom: 10 },
  empty: { fontSize: 14, color: colors.textMuted, marginTop: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.cardGap },
  card: { minHeight: 104, justifyContent: 'center', padding: spacing.cardPadding, paddingTop: 20, overflow: 'hidden', backgroundColor: colors.cardBg, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radii.card },
  stripe: { position: 'absolute', top: 0, left: 0, right: 0, height: 5 },
  cardBadge: { position: 'absolute', top: 12, right: 10, minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 6, backgroundColor: colors.buttonBg, alignItems: 'center', justifyContent: 'center' },
  cardLabel: { fontSize: 16, fontWeight: '800', letterSpacing: 0.3, color: colors.textPrimary },
  cardSub: { fontSize: 13, lineHeight: 17, color: colors.textSecondary, marginTop: 4 },
  overlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: 24 },
  menu: { backgroundColor: colors.background, borderRadius: radii.card, padding: 18, borderWidth: 1, borderColor: colors.cardBorder },
  menuUser: { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
  menuRole: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  menuLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: colors.textMuted, marginBottom: 8 },
  divider: { height: 1, backgroundColor: colors.cardBorder, marginVertical: 14 },
  themes: { flexDirection: 'row', gap: 8 },
  theme: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radii.small, borderWidth: 1.5, borderColor: colors.cardBorder, backgroundColor: colors.cardBg },
  themeActive: { borderColor: colors.copper, backgroundColor: colors.cream },
  themeText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  themeTextActive: { color: colors.accentRed, fontWeight: '800' },
  menuItem: { minHeight: 48, justifyContent: 'center' },
  menuItemText: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  input: { minHeight: 48, paddingHorizontal: 12, marginBottom: 10, fontSize: 15, color: colors.textPrimary, backgroundColor: colors.inputBg, borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input },
  error: { fontSize: 13, color: colors.danger, marginBottom: 10 },
});
