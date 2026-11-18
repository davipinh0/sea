import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { withoutLock } from './auth/appLock';
import client from './api/client';

// SEA notifications on the phone (withdrawal requested, materials
// received, storage concluded).
//
//   * App open: the app asks the API every few seconds and shows what is
//     new as a notification of the phone (sound + banner).
//   * App closed: the notification comes through the push service, when
//     the server has it switched on (SEA_PUSH=expo) and the app was built
//     with the Firebase key. Without that, this part simply stays off.

// Android keeps the sound of a channel for good, so the channel carries
// the sound in its name.
const CHANNEL = 'sea-avisos';
// The two short tones of the panel (assets/sea_aviso.wav).
const SOUND = 'sea_aviso.wav';
const POLL_MS = 15000;
const TOKEN_KEY = 'sea_push_token';
const SEEN_KEY = 'sea_notif_seen';

// Screen each notification leads to.
export const KIND_SCREEN = {
  RETIRADA_SOLICITADA: 'Retirada',
  RECEBIMENTO: 'Armazenar',
  ARMAZENAGEM_CONCLUIDA: 'Estoque',
};

export const KIND_LABEL = {
  RETIRADA_SOLICITADA: 'Solicitação de retirada',
  RECEBIMENTO: 'Recebimento de materiais',
  ARMAZENAGEM_CONCLUIDA: 'Armazenamento concluído',
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // With the app open the poller shows the notification itself; a push
    // of the same event would be a duplicate.
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
  // The permission window puts the app in the background: no lock for it.
  return (await withoutLock(() => Notifications.requestPermissionsAsync())).granted;
}

// Register this phone to receive notifications while the app is closed.
// Fails quietly when the build has no push key or the server refuses.
export async function registerDevice() {
  try {
    if (!(await allowed())) return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await client.post('/api/sea/push/registrar', { token });
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } catch {
    // No push available here: notifications still work with the app open.
  }
}

// Called before logout, while the session is still valid.
export async function unregisterDevice() {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await AsyncStorage.removeItem(TOKEN_KEY);
    await client.post('/api/sea/push/remover', { token });
  } catch {
    // The server drops the device at the next login on this phone.
  }
}

export async function readSeen() {
  const raw = await AsyncStorage.getItem(SEEN_KEY).catch(() => null);
  return raw === null ? null : Number(raw);
}

export async function writeSeen(id) {
  await AsyncStorage.setItem(SEEN_KEY, String(id)).catch(() => {});
}

// Ask the API for what is new and show it. Returns a function that stops.
// ``onNew(list)`` lets the app update what is on screen.
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
        // Nothing is announced as new the first time the app is used here.
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
      // Offline or session ended: the next round tries again.
    }
  }

  poll();
  const timer = setInterval(poll, POLL_MS);
  const sub = AppState.addEventListener('change', (state) => { if (state === 'active') poll(); });
  return () => { stopped = true; clearInterval(timer); sub.remove(); };
}

function announce(list) {
  // Newest last, so the most recent ends on top of the phone's list.
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

// Open the related screen when a notification is tapped.
export function onNotificationTap(navigate) {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const kind = response.notification.request.content.data?.kind;
    navigate(KIND_SCREEN[kind] || 'Notificacoes');
  });
  return () => sub.remove();
}
