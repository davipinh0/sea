import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import { OtTypeTag } from '../components/sea.jsx';
import NovaOtSapModal from '../components/NovaOtSapModal.jsx';
import { formatDate, readError } from '../utils/sea.js';
import { useLiveRefresh } from '../utils/useLiveRefresh.js';

// Só leitura: a base é carregada em Importação de dados e, no futuro, pela integração com o SAP.

export default function BaseSap() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [tick, setTick] = useState(0);
  useLiveRefresh(() => setTick((n) => n + 1));

  useEffect(() => {
    let cancelled = false;
    api.get(`/sea/sap/base?q=${encodeURIComponent(search)}`).then(async (res) => {
      if (cancelled || !res) return;
      if (!res.ok) { setError(await readError(res, 'Não foi possível carregar a base do SAP.')); return; }
      setError('');
      setData(await res.json());
    });
    return () => { cancelled = true; };
  }, [search, tick]);

  const reservations = data?.reservations || [];

  return (
    <div>
      <PageHeader title="SAP">
        <button type="button" className="btn btn-primary" onClick={() => { setMessage(''); setCreating(true); }}>Nova OT</button>
      </PageHeader>
      {message && <div className="tag tag-success" role="status" style={{ display: 'block', padding: 10, marginBottom: 12 }}>{message}</div>}
      {creating && (
        <NovaOtSapModal
          onClose={() => setCreating(false)}
          onCreated={(ot) => { setCreating(false); setMessage(`OT ${ot} criada. Ao ler este código no recebimento, o SEA traz os materiais dela.`); }}
        />
      )}
      <p className="settings-note">
        Dados vindos do SAP: ordens, materiais e OTs / reservas abertas. Ao ler o código de barras no recebimento, o SEA procura a OT aqui.
        A base é carregada em Sistema &gt; Importação de dados.
      </p>

      <form onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          className="form-input" aria-label="Buscar na base do SAP"
          placeholder="Buscar por OT, reserva, ordem, material ou solicitante"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">Buscar</button>
      </form>

      {error && <div className="form-error" role="alert">{error}</div>}
      {data && reservations.length === 0 && (
        <p className="settings-note">{search ? 'Nenhuma OT encontrada para esta busca.' : 'A base do SAP está vazia.'}</p>
      )}

      {reservations.map((r) => (
        <div className="card" key={r.ot} style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            OT <span className="mono">{r.ot}</span>
            <span className={`tag ${r.registered ? 'tag-success' : 'tag-warning'}`}>
              {r.registered ? 'Entrega registrada no SEA' : 'Aguardando entrega'}
            </span>
          </div>
          <div className="detail-grid" style={{ marginBottom: 8 }}>
            <div><span className="detail-label">Reserva</span> {r.reservation_number || '-'}</div>
            <div><span className="detail-label">Solicitante</span> {r.requester_name || '-'}</div>
            <div><span className="detail-label">Data necessária</span> {formatDate(r.needed_date)}</div>
          </div>
          <table className="lines-table">
            <thead><tr><th>Ordem</th><th>Tipo</th><th>Código</th><th>Descrição</th><th>Lote</th><th>Quantidade</th><th>Unidade</th></tr></thead>
            <tbody>
              {r.materials.map((m) => (
                <tr key={m.material_code}>
                  <td className="mono">{m.service_order_number}</td>
                  <td><OtTypeTag type={m.service_order_type} /></td>
                  <td className="mono">{m.material_code}</td>
                  <td>{m.description}</td>
                  <td className="mono">{m.lot_number || '-'}</td>
                  <td>{m.quantity}</td>
                  <td>{m.uom || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
