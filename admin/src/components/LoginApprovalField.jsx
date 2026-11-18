import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Sistema > Usuários: "Confirmar login no celular" (mig 092) and the
// phones that confirm the logins of the user.

function when(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
}

export default function LoginApprovalField({ userId, enabled, onToggle }) {
  const [devices, setDevices] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    api.get(`/admin/users/${userId}/aparelhos`, { silentPermissionDenied: true }).then(async (res) => {
      const data = res?.ok ? await res.json() : { devices: [] };
      if (alive) setDevices(data.devices || []);
    });
    return () => { alive = false; };
  }, [userId]);

  async function removeDevices() {
    const res = await api.delete(`/admin/users/${userId}/aparelhos`);
    setConfirmRemove(false);
    if (res?.ok) {
      setDevices([]);
      setMessage('Aparelhos removidos. O usuário volta a entrar só com a senha até ativar o bloqueio no app de novo.');
    } else {
      setMessage('Não foi possível remover os aparelhos.');
    }
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
          {devices.length > 0 && (confirmRemove ? (
            <div className="login-approval-confirm">
              <span>Remover {devices.length === 1 ? 'o celular' : `os ${devices.length} celulares`} deste usuário?</span>
              <button type="button" className="btn btn-sm btn-danger" onClick={removeDevices}>Remover</button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmRemove(false)}>Manter</button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setConfirmRemove(true)}>
              Remover celulares (perdido ou trocado)
            </button>
          ))}
          {enabled && devices.length > 0 && trusted.length === 0 && (
            <div className="settings-note">Nenhum celular com bloqueio ativo: o login segue só com a senha.</div>
          )}
        </div>
      )}
      {message && <div className="settings-note" role="status">{message}</div>}
    </div>
  );
}
