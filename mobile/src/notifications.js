import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { withoutLock } from './auth/appLock';
import client from './api/client';

// Notificações no celular.
// - App aberto: o app consulta a API de tempos em tempos e mostra o que é novo.
// - App fechado: o aviso chega pelo push, quando o servidor está com SEA_PUSH=expo e o app tem a
// chave do Firebase.

// O Android guarda o som do canal para sempre, por isso o som vai no nome do canal.
const CHANNEL = 'sea-avisos';
const SOUND = 'sea_aviso.wav';
const POLL_MS = 15000;
const TOKEN_KEY = 'sea_push_token';
const SEEN_KEY = 'sea_notif_seen';

export const KIND_SCREEN = {
  RETIRADA_SOLICITADA: 'Retirada',
  RETIRADA_APROVADA: 'Retirada',
  RETIRADA_CANCELADA: 'Retirada',
  RECEBIMENTO: 'Armazenar',
  ARMAZENAGEM_CONCLUIDA: 'Estoque',
};

export const LOGIN_APPROVAL = 'login_approval';

export function onLoginApprovalPush(onLoginApproval) {
  const isApproval = (n) => n?.request?.content?.data?.kind === LOGIN_APPROVAL;
  const received = Notifications.addNotificationReceivedListener((n) => { if (isApproval(n)) onLoginApproval(); });
  const tapped = Notifications.addNotificationResponseReceivedListener((r) => { if (isApproval(r.notification)) onLoginApproval(); });
  return () => { received.remove(); tapped.remove(); };
}

export const KIND_LABEL = {
  RETIRADA_SOLICITADA: 'Solicitação de retirada',
  RETIRADA_APROVADA: 'Retirada aprovada',
  RETIRADA_CANCELADA: 'Retirada cancelada',
  RECEBIMENTO: 'Recebimento de materiais',
  ARMAZENAGEM_CONCLUIDA: 'Armazenamento concluído',
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // Com o app aberto quem mostra é a consulta periódica; o push do mesmo evento seria repetido.
    const remote = notification.request.trigger?.type === 'push';
    const show = !(remote && AppState.currentState === 'active');
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
  },
});

async function allowed() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Avisos do SEA', importance: Notifications.AndroidImportance.HIGH, sound: SOUND,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await withoutLock(() => Notifications.requestPermissionsAsync())).granted;
}

// Token de push deste celular. O app manda no login: o celular cadastrado confirma o próprio login.
export async function getDeviceToken() {
  return AsyncStorage.getItem(TOKEN_KEY).catch(() => null);
}

// Registra o celular para receber avisos com o app fechado. Com a trava do app ligada
// (``secureLock``), ele também confirma os logins do usuário. Falha em silêncio se o build não tem
// chave de push.
export async function registerDevice({ secureLock = false } = {}) {
  try {
    if (!(await allowed())) return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const deviceName = String(Platform.constants?.Model || Platform.OS).slice(0, 100);
    await client.post('/api/sea/push/registrar', { token, secure_lock: !!secureLock, device_name: deviceName });
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Sem push aqui: as notificações continuam com o app aberto.
  }
}

// Chamado antes de sair, com a sessão ainda válida. O celular para de receber avisos, mas continua
// cadastrado para confirmar os logins do usuário.
export async function unregisterDevice() {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await client.post('/api/sea/push/remover', { token });
  } catch {
    // O servidor tira o aparelho no próximo login neste celular.
  }
}

export async function readSeen() {
  const raw = await AsyncStorage.getItem(SEEN_KEY).catch(() => null);
  return raw === null ? null : Number(raw);
}

export async function writeSeen(id) {
  await AsyncStorage.setItem(SEEN_KEY, String(id)).catch(() => {});
}

export function startPolling(onNew) {
  let last = null;
  let stopped = false;

  async function poll() {
    if (stopped || AppState.currentState !== 'active') return;
    try {
      const first = last === null;
      const resp = await client.get(`/api/sea/notificacoes${first ? '' : `?after=${last}`}`);
      const list = resp.data?.notifications || [];
      if (first) {
        last = list[0]?.notification_id ?? 0;
        // Na primeira vez neste celular nada é anunciado como novo.
        const seen = await readSeen();
        if (seen === null) { await writeSeen(last); return; }
        const missed = list.filter((n) => n.notification_id > seen);
        if (missed.length) { announce(missed); onNew?.(missed); }
        return;
      }
      if (list.length === 0) return;
      last = list[0].notification_id;
      announce(list);
      onNew?.(list);
    } catch {
      // Sem conexão ou sessão encerrada: a próxima consulta tenta de novo.
    }
  }

  poll();
  const timer = setInterval(poll, POLL_MS);
  const sub = AppState.addEventListener('change', (state) => { if (state === 'active') poll(); });
  return () => { stopped = true; clearInterval(timer); sub.remove(); };
}

function announce(list) {
  [...list].reverse().forEach((n) => {
    Notifications.scheduleNotificationAsync({
      content: {
        title: n.title, body: n.message, sound: SOUND,
        data: { kind: n.kind, notification_id: n.notification_id },
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    }).catch(() => {});
  });
}

export function onNotificationTap(navigate) {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const kind = response.notification.request.content.data?.kind;
    // Login para confirmar abre por cima de qualquer tela (LoginApproval).
    if (kind === LOGIN_APPROVAL) return;
    navigate(KIND_SCREEN[kind] || 'Notificacoes');
  });
  return () => sub.remove();
}
