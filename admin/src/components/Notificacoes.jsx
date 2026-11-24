import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useWarehouse } from '../warehouse.jsx';
import { formatDateTime } from '../utils/sea.js';

// Sino de notificações: busca as novas de tempos em tempos, toca um som curto e mostra até serem
// lidas. O e-mail para os administradores sai da API, não daqui.

const POLL_MS = 10000;
const TOAST_MS = 8000;

const KIND_LABEL = {
  RETIRADA_SOLICITADA: 'Solicitação de retirada',
  RETIRADA_APROVADA: 'Retirada aprovada',
  RETIRADA_CANCELADA: 'Retirada cancelada',
  RECEBIMENTO: 'Recebimento de materiais',
  ARMAZENAGEM_CONCLUIDA: 'Armazenamento concluído',
};

const KIND_TARGET = {
  RETIRADA_SOLICITADA: '/retirada',
  RETIRADA_APROVADA: '/retirada',
  RETIRADA_CANCELADA: '/retirada',
  RECEBIMENTO: '/recebimento/armazenagem',
  ARMAZENAGEM_CONCLUIDA: '/estoque/sp12',
};

const EMAIL_LABEL = {
  ENVIADO: 'e-mail enviado',
  PENDENTE: 'e-mail na fila',
  FALHA: 'falha no envio do e-mail',
  SEM_DESTINATARIO: 'nenhum administrador com e-mail',
  NAO_CONFIGURADO: 'e-mail não configurado',
};

// O navegador só libera som depois que o usuário interage com a página; antes disso o aviso é só
// visual.
function playNotificationSound() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    [880, 1175].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.2, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.start(start);
      osc.stop(start + 0.17);
    });
    setTimeout(() => ctx.close(), 800);
  } catch {
    // Som bloqueado pelo navegador: o aviso visual continua.
  }
}

// Maior id de notificação já aberto pelo usuário neste navegador. null = nunca usado aqui.
function readSeen(username) {
  try {
    const raw = window.localStorage.getItem(`sea_notif_seen_${username}`);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function writeSeen(username, id) {
  try {
    window.localStorage.setItem(`sea_notif_seen_${username}`, String(id));
  } catch {
    // Armazenamento bloqueado: as notificações funcionam só nesta sessão.
  }
}

export default function Notificacoes() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { warehouses, setWarehouseId } = useWarehouse() || {};
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const lastId = useRef(null);
  const boxRef = useRef(null);
  const username = user?.username;

  useEffect(() => {
    if (!username) return undefined;
    let stopped = false;
    lastId.current = null;

    async function poll() {
      const first = lastId.current === null;
      const res = await api.get(`/sea/notificacoes${first ? '' : `?after=${lastId.current}`}`, { silentPermissionDenied: true });
      if (stopped || !res?.ok) return;
      const list = (await res.json()).notifications || [];
      if (first) {
        lastId.current = list[0]?.notification_id ?? 0;
        setItems(list);
        // O que chegou enquanto o painel estava fechado é anunciado agora.
        const seen = readSeen(username);
        if (seen === null) { writeSeen(username, lastId.current); return; }
        const missed = list.filter((n) => n.notification_id > seen);
        if (missed.length === 0) return;
        setUnread(missed.length);
        setToast(missed[0]);
        playNotificationSound();
        return;
      }
      if (list.length === 0) return;
      lastId.current = list[0].notification_id;
      setItems((old) => [...list, ...old].slice(0, 30));
      setUnread((n) => n + list.length);
      setToast(list[0]);
      playNotificationSound();
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [username]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!open) return undefined;
    function outside(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  function toggle() {
    setOpen((v) => !v);
    setUnread(0);
    setToast(null);
    if (lastId.current !== null) writeSeen(username, lastId.current);
  }

  function go(n) {
    setOpen(false);
    setToast(null);
    setUnread(0);
    if (lastId.current !== null) writeSeen(username, lastId.current);
    if (n.warehouse_id && (warehouses || []).some((w) => w.warehouse_id === n.warehouse_id)) {
      setWarehouseId?.(n.warehouse_id);
    }
    navigate(KIND_TARGET[n.kind] || '/');
  }

  // Limpa só a lista deste usuário; os registros continuam no servidor.
  async function clearAll() {
    const res = await api.post('/sea/notificacoes/limpar', {});
    if (!res?.ok) return;
    const { cleared_id: clearedId } = await res.json();
    lastId.current = Math.max(lastId.current ?? 0, clearedId ?? 0);
    writeSeen(username, lastId.current);
    setItems([]);
    setUnread(0);
    setToast(null);
  }

  return (
    <div className="sea-notif" ref={boxRef}>
      <button type="button" className="sea-notif-bell" onClick={toggle} aria-label={unread ? `Notificações: ${unread} nova(s)` : 'Notificações'} title="Notificações">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="sea-notif-count">{unread}</span>}
      </button>

      {open && (
        <div className="sea-notif-list" role="dialog" aria-label="Notificações">
          {items.length === 0 && <div className="sea-notif-empty">Nenhuma notificação.</div>}
          {items.length > 0 && (
            <div className="sea-notif-actions">
              <button type="button" className="btn btn-sm" onClick={clearAll}>Limpar notificações</button>
            </div>
          )}
          {items.map((n) => (
            <button type="button" key={n.notification_id} className="sea-notif-item" onClick={() => go(n)}>
              <div className="sea-notif-kind">{KIND_LABEL[n.kind] || n.kind} · {n.warehouse_code}</div>
              <div className="sea-notif-title">{n.title}</div>
              <div>{n.message}</div>
              <div className="sea-notif-meta">{formatDateTime(n.created_at)} · {EMAIL_LABEL[n.email_status] || n.email_status}</div>
            </button>
          ))}
        </div>
      )}

      {toast && !open && (
        <div className="sea-notif-toast" role="status" aria-live="polite" onClick={() => go(toast)}>
          <div className="sea-notif-kind">{KIND_LABEL[toast.kind] || toast.kind}</div>
          <div className="sea-notif-title">{toast.title}</div>
          <div>{toast.message}</div>
        </div>
      )}
    </div>
  );
}
