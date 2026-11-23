import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { ALL_FUNCTIONS, PAGE_GROUPS } from './Users.jsx';
import { formatDateTime, readError } from '../utils/sea.js';

// "Gerenciar Acessos" do próprio usuário. Locais, permissões e celulares só o administrador muda;
// aqui o usuário vê tudo e desconecta os aparelhos onde ainda está conectado.

function granted(user, key, isOverride) {
  if (user?.role === 'ADMIN') return true;
  return (isOverride ? user?.allowed_overrides : user?.allowed_pages)?.includes(key) || false;
}

export default function MeusAcessos() {
  const { user } = useAuth();
  const [mine, setMine] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null); // { ids, title, text }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get('/sea/meus-acessos');
    if (!res) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível carregar os seus acessos.')); return; }
    setMine(await res.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function disconnect() {
    setError(''); setNotice('');
    setBusy(true);
    const res = await api.post('/sea/meus-acessos/sessoes/encerrar', { ids: confirm.ids });
    setBusy(false);
    if (!res) return;
    setConfirm(null);
    if (!res.ok) { setError(await readError(res, 'Não foi possível desconectar.')); load(); return; }
    const { ended } = await res.json();
    setNotice(ended === 1 ? '1 aparelho desconectado.' : `${ended} aparelhos desconectados.`);
    load();
  }

  const admin = user?.role === 'ADMIN';
  const sessions = mine?.sessions || [];
  const others = sessions.filter((s) => !s.current);

  return (
    <div>
      <PageHeader title="Gerenciar Acessos" />
      {error && <div className="form-error" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="form-success" role="status" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="settings-section">
        <h3>Dispositivos conectados</h3>
        <p className="settings-note">
          Onde você está conectado agora (painel, app e terminal). Não reconhece um aparelho? Desconecte e troque a senha.
        </p>
        {!mine && !error && <p className="settings-note">Carregando…</p>}
        {mine && (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Aparelho</th><th>Tipo</th><th>IP</th><th>Conectado desde</th><th>Último uso</th><th aria-label="Ações" /></tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.device}</td>
                    <td>{s.kind}</td>
                    <td className="mono">{s.ip || '-'}</td>
                    <td>{formatDateTime(s.started_at)}</td>
                    <td>{formatDateTime(s.last_seen_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {s.current ? <span className="tag tag-success">Este aparelho</span> : (
                        <button
                          type="button" className="btn btn-sm" aria-label={`Desconectar ${s.device}`}
                          onClick={() => setConfirm({ ids: [s.id], title: `Desconectar ${s.device}?`, text: 'Ele vai precisar entrar de novo com usuário e senha.' })}
                        >
                          Desconectar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {others.length > 1 && (
          <button
            type="button" className="btn" style={{ marginTop: 12 }}
            onClick={() => setConfirm({ ids: others.map((s) => s.id), title: 'Desconectar todos os outros aparelhos?', text: `${others.length} aparelhos vão precisar entrar de novo. Este continua conectado.` })}
          >
            Desconectar todos os outros
          </button>
        )}
      </div>

      {mine && (
        <div className="settings-section">
          <h3>Confirmação de login no celular</h3>
          <p className="settings-note">
            {mine.login_approval
              ? 'Ligada: um login com senha em outro lugar espera a sua confirmação no app SEA.'
              : 'Desligada: o login usa só a senha.'}
          </p>
          {mine.devices.length === 0 && <p className="settings-note">Nenhum celular cadastrado.</p>}
          {mine.devices.length > 0 && (
            <div className="detail-grid">
              {mine.devices.map((d) => (
                <span key={`${d.ending}-${d.updated_at}`} style={{ display: 'contents' }}>
                  <span className="detail-label">{d.device} (…{d.ending})</span>
                  <span>{d.secure_lock ? 'Confirma logins' : 'Sem bloqueio: não confirma logins'} · {d.signed_in ? 'conectado' : 'fora do app'} · {formatDateTime(d.updated_at)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {mine && (
        <div className="settings-section">
          <h3>Locais</h3>
          <p className="settings-note">
            {mine.all_locations ? 'Todos os locais (administrador).' : mine.locations.map((l) => (l.name && l.name !== l.code ? `${l.code} (${l.name})` : l.code)).join(', ') || 'Nenhum local liberado.'}
          </p>
        </div>
      )}

      <div className="settings-section">
        <h3>Permissões</h3>
        {admin && <p className="settings-note">Administrador: acesso a tudo.</p>}
        <div className="detail-grid">
          <span className="detail-label">No app</span>
          <span>{ALL_FUNCTIONS.filter((f) => admin || user?.allowed_functions?.includes(f.key)).map((f) => f.label).join(', ') || 'Nenhuma função'}</span>
          {PAGE_GROUPS.map((group) => {
            const on = group.pages.filter((p) => granted(user, p.key, group.isOverride));
            return (
              <span key={group.label} style={{ display: 'contents' }}>
                <span className="detail-label">{group.label}</span>
                <span>{on.map((p) => p.label).join(', ') || '-'}</span>
              </span>
            );
          })}
        </div>
      </div>

      <p className="settings-note" style={{ textAlign: 'center' }}>
        Para pedir um acesso novo, mudar de local ou tirar um celular perdido, fale com o administrador do SEA.
      </p>

      {confirm && (
        <Modal
          title={confirm.title} onClose={() => setConfirm(null)}
          footer={(
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancelar</button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={disconnect}>{busy ? 'Desconectando…' : 'Desconectar'}</button>
            </>
          )}
        >
          <p>{confirm.text}</p>
        </Modal>
      )}
    </div>
  );
}
