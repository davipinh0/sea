import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { readError } from '../utils/sea.js';

// Confirmação de login no celular e os celulares que confirmam os logins do usuário.

// Mesmos motivos da API (schemas/users.py, DEVICE_REMOVAL_REASONS).
export const REMOVAL_REASONS = [
  ['perdido', 'Celular perdido'],
  ['roubado', 'Celular roubado ou furtado'],
  ['troca', 'Troca de celular'],
  ['defeito', 'Celular com defeito'],
  ['desligamento', 'Desligamento ou afastamento do funcionário'],
  ['funcao', 'Mudança de função ou de setor'],
  ['suspeita', 'Suspeita de uso indevido'],
  ['outro', 'Outro'],
];

function when(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
}

function RemovalForm({ count, onRemove, onCancel }) {
  const [reasons, setReasons] = useState([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(key) {
    setError('');
    setReasons((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  }

  async function submit() {
    if (reasons.length === 0) { setError('Escolha pelo menos um motivo.'); return; }
    if (reasons.includes('outro') && note.trim().length < 3) { setError('Explique o motivo em "Outro".'); return; }
    setBusy(true);
    setError(await onRemove(reasons, note.trim()) || '');
    setBusy(false);
  }

  return (
    <fieldset className="login-approval-confirm device-removal">
      <legend>
        Por que remover {count === 1 ? 'o celular' : `os ${count} celulares`} deste usuário? (pode marcar mais de um)
      </legend>
      <div className="device-removal-reasons">
        {REMOVAL_REASONS.map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={reasons.includes(key)} onChange={() => toggle(key)} />
            {label}
          </label>
        ))}
      </div>
      <label htmlFor="device-removal-note">
        Observação{reasons.includes('outro') ? ' (obrigatória em "Outro")' : ' (opcional)'}
      </label>
      <textarea
        id="device-removal-note" className="form-input" rows={2} maxLength={300} value={note}
        onChange={(e) => { setNote(e.target.value); setError(''); }}
      />
      {error && <div className="form-error" role="alert">{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-sm btn-danger" onClick={submit} disabled={busy}>
          {busy ? 'Removendo...' : 'Remover e salvar motivo'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancelar</button>
      </div>
    </fieldset>
  );
}

export default function LoginApprovalField({ userId, enabled, onToggle }) {
  const [devices, setDevices] = useState(null);
  const [lastRemoval, setLastRemoval] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    api.get(`/admin/users/${userId}/aparelhos`, { silentPermissionDenied: true }).then(async (res) => {
      const data = res?.ok ? await res.json() : { devices: [] };
      if (!alive) return;
      setDevices(data.devices || []);
      setLastRemoval(data.last_removal || null);
    });
    return () => { alive = false; };
  }, [userId]);

  // Devolve a mensagem de erro, ou nada quando deu certo.
  async function removeDevices(reasons, note) {
    const res = await api.delete(`/admin/users/${userId}/aparelhos`, { body: JSON.stringify({ reasons, note }) });
    if (!res?.ok) return readError(res, 'Não foi possível remover os aparelhos.');
    const labels = REMOVAL_REASONS.filter(([key]) => reasons.includes(key)).map(([, label]) => label);
    setRemoving(false);
    setDevices([]);
    setLastRemoval({ by: 'você', at: new Date().toISOString(), reasons: labels, note });
    setMessage('Aparelhos removidos e motivo salvo no log. O usuário volta a entrar só com a senha até ativar o bloqueio no app de novo.');
    return '';
  }

  const trusted = (devices || []).filter((d) => d.secure_lock);
  return (
    <div className="form-group login-approval-field">
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!enabled} onChange={(e) => onToggle(e.target.checked)} />
        Confirmar login no celular
      </label>
      <div className="settings-note">
        Ligado, o login com senha no painel web, no terminal ou em outro celular só é liberado depois que o
        usuário confirma no app SEA do celular dele (com a digital ou a senha do celular). Vale quando ele
        tem um celular cadastrado: basta entrar no app e ativar o bloqueio.
      </div>
      {userId && devices !== null && (
        <div className="login-approval-devices">
          {devices.length === 0 && <div className="settings-note">Nenhum celular cadastrado{enabled ? ': por enquanto o login segue só com a senha.' : '.'}</div>}
          {devices.map((d) => (
            <div key={`${d.ending}-${d.updated_at}`} className="login-approval-device">
              <span>📱 {d.device} (…{d.ending})</span>
              <span>{d.secure_lock ? 'bloqueio ativo: confirma logins' : 'sem bloqueio: não confirma logins'}</span>
              <span>{d.signed_in ? 'conectado' : 'fora do app'} · {when(d.updated_at)}</span>
            </div>
          ))}
          {devices.length > 0 && (removing ? (
            <RemovalForm count={devices.length} onRemove={removeDevices} onCancel={() => setRemoving(false)} />
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => { setRemoving(true); setMessage(''); }}>
              Remover celulares
            </button>
          ))}
          {enabled && devices.length > 0 && trusted.length === 0 && (
            <div className="settings-note">Nenhum celular com bloqueio ativo: o login segue só com a senha.</div>
          )}
          {lastRemoval && (
            <div className="settings-note device-last-removal">
              Última remoção: {when(lastRemoval.at)} por {lastRemoval.by}. Motivo: {lastRemoval.reasons.join(', ') || '-'}
              {lastRemoval.note ? ` (${lastRemoval.note})` : ''}.
            </div>
          )}
        </div>
      )}
      {message && <div className="settings-note" role="status">{message}</div>}
    </div>
  );
}
