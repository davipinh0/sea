import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { OtTypeTag } from '../components/sea.jsx';
import { readError } from '../utils/sea.js';

// Expedição > Armazenagem: material waiting in a receiving area, with an
// automatic address suggestion (whole order in one address, size class,
// capacity, compatibility). Material is received in one location (the
// Expedição has a single address) and stored in the shelves of another
// (SP12, Contêiner de Solda), so the page lists what is waiting in every
// location and offers the storage addresses of all of them. The operator
// confirms or picks another address; the API re-validates every rule.

function Row({ row, destinations, otTypes, onDone }) {
  const [suggestion, setSuggestion] = useState(null);
  const [target, setTarget] = useState('');
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [showWhy, setShowWhy] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(`/sea/armazenagem/sugestao/${row.inventory_id}`).then(async (res) => {
      if (cancelled || !res?.ok) return;
      const data = await res.json();
      setSuggestion(data);
      if (data.bin_id) setTarget(String(data.bin_id));
    });
    return () => { cancelled = true; };
  }, [row.inventory_id]);

  async function confirm() {
    const q = parseInt(quantity, 10);
    if (!Number.isInteger(q) || q <= 0 || q > row.quantity) {
      setError(`Informe uma quantidade entre 1 e ${row.quantity}.`);
      return;
    }
    if (!target) {
      setError('Escolha o endereço de destino.');
      return;
    }
    setSaving(true);
    setError('');
    const res = await api.post('/putaway/confirm', {
      item_id: row.item_id,
      from_bin_id: row.bin_id,
      to_bin_id: parseInt(target, 10),
      quantity: q,
      lot_number: row.lot_number,
    });
    setSaving(false);
    if (!res) return;
    if (!res.ok) {
      setError(await readError(res, 'Não foi possível confirmar a armazenagem.'));
      return;
    }
    const data = await res.json();
    const place = destinations.flatMap((g) => g.bins).find((b) => String(b.bin_id) === target);
    onDone(`${data.quantity} un. de ${data.item} armazenada(s) em ${place ? `${place.warehouse_code} · ` : ''}${data.to_bin}.`);
  }

  return (
    <tr>
      <td className="mono">{row.lot_number || '-'} <OtTypeTag type={otTypes[row.lot_number]} /></td>
      <td className="mono">{row.sku}</td>
      <td>{row.item_name}</td>
      <td className="mono">{row.warehouse_code ? `${row.warehouse_code} · ` : ''}{row.bin_code}</td>
      <td>
        <input type="number" min="1" max={row.quantity} className="form-input" style={{ width: 80 }}
          aria-label={`Quantidade de ${row.sku}`} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <span className="settings-note"> de {row.quantity}</span>
      </td>
      <td>
        {suggestion === null && <span className="settings-note">Calculando…</span>}
        {suggestion && suggestion.bin_code && <strong className="mono">{suggestion.warehouse_code} · {suggestion.bin_code}</strong>}
        {suggestion && !suggestion.bin_code && <span className="form-error">Nenhum endereço compatível</span>}
        {suggestion && suggestion.rejected.length > 0 && (
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setShowWhy((v) => !v)}>
              {showWhy ? 'Ocultar motivos' : 'Por que não outros?'}
            </button>
            {showWhy && (
              <ul className="settings-note" style={{ margin: '6px 0 0 16px' }}>
                {suggestion.rejected.map((r) => <li key={`${r.warehouse_code}-${r.bin_code}`}><strong>{r.warehouse_code} · {r.bin_code}</strong>: {r.reason}</li>)}
              </ul>
            )}
          </div>
        )}
      </td>
      <td>
        <select className="form-select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={`Endereço de destino de ${row.sku}`}>
          <option value="">Escolha…</option>
          {destinations.map((g) => (
            <optgroup key={g.warehouse_id} label={`${g.warehouse_code} - ${g.warehouse_name}`}>
              {g.bins.map((b) => <option key={b.bin_id} value={b.bin_id}>{b.bin_code}{b.size_class ? ` (${b.size_class})` : ''}</option>)}
            </optgroup>
          ))}
        </select>
        {error && <div className="form-error" style={{ marginTop: 4 }}>{error}</div>}
      </td>
      <td>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={confirm}>
          {saving ? 'Salvando…' : 'Confirmar'}
        </button>
      </td>
    </tr>
  );
}

// Storage addresses grouped by location, in the order the API returns.
function groupByLocation(bins) {
  const groups = [];
  bins.forEach((b) => {
    let group = groups.find((g) => g.warehouse_id === b.warehouse_id);
    if (!group) {
      group = { warehouse_id: b.warehouse_id, warehouse_code: b.warehouse_code, warehouse_name: b.warehouse_name, bins: [] };
      groups.push(group);
    }
    group.bins.push(b);
  });
  return groups;
}

export default function ArmazenagemSP12() {
  const { warehouseId, warehouses } = useWarehouse();
  const [pending, setPending] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [otTypes, setOtTypes] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  // Bumping ``tick`` re-runs the fetch (Atualizar button, after a put-away).
  const [tick, setTick] = useState(0);
  const load = () => setTick((n) => n + 1);

  // Every location the user sees; the selected one comes first. When the
  // list of locations is not available, only the selected one is used.
  const locationKey = (warehouses || []).map((w) => w.warehouse_id || w.id).join(',');

  useEffect(() => {
    if (!warehouseId) return undefined;
    let cancelled = false;
    const known = (warehouses || []).map((w) => ({ id: w.warehouse_id || w.id, code: w.warehouse_code || w.code }));
    const locations = known.length > 0 ? known : [{ id: warehouseId, code: '' }];
    locations.sort((a, b) => (b.id === warehouseId) - (a.id === warehouseId));
    (async () => {
      const [destRes, ...perLocation] = await Promise.all([
        api.get('/sea/armazenagem/destinos'),
        ...locations.flatMap((loc) => [
          api.get(`/putaway/pending/${loc.id}`),
          api.get(`/sea/ots?warehouse_id=${loc.id}`),
        ]),
      ]);
      if (cancelled) return;
      const rows = [];
      const types = {};
      for (let i = 0; i < locations.length; i += 1) {
        const pendRes = perLocation[2 * i];
        const otsRes = perLocation[2 * i + 1];
        if (pendRes && !pendRes.ok) {
          const msg = await readError(pendRes, 'Não foi possível carregar os materiais pendentes.');
          if (!cancelled) setError(msg);
          return;
        }
        if (pendRes?.ok) {
          ((await pendRes.json()).pending_items || []).forEach((r) => rows.push({ ...r, warehouse_code: locations[i].code }));
        }
        if (otsRes?.ok) ((await otsRes.json()).ots || []).forEach((o) => { types[o.ot] = o.order_type; });
      }
      const dest = destRes?.ok ? (await destRes.json()).bins || [] : null;
      if (cancelled) return;
      setError('');
      setPending(rows);
      if (dest) setDestinations(groupByLocation(dest));
      setOtTypes(types);
      setVersion((v) => v + 1);
    })();
    return () => { cancelled = true; };
  }, [warehouseId, locationKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  function done(text) {
    setMessage(text);
    load();
  }

  return (
    <div>
      <PageHeader title="Armazenagem">
        <button type="button" className="btn btn-sm" onClick={load}>Atualizar</button>
      </PageHeader>
      <p className="settings-note" style={{ marginBottom: 12 }}>
        O material recebido (na Expedição ou na área de recebimento de um local) é armazenado nas prateleiras
        do SP12 ou no Contêiner de Solda: escolha o destino em qualquer local. Os materiais de uma
        ordem podem ficar em endereços diferentes. Regras: materiais só compartilham endereço quando compatíveis; endereços com classe de
        tamanho (ex.: A3 para peças pequenas) e capacidade configurada são respeitados.
      </p>
      {message && <div className="tag tag-success" style={{ display: 'block', padding: 12, marginBottom: 12 }}>{message}</div>}
      {error && <div className="form-error">{error}</div>}
      {destinations.length === 0 && pending.length > 0 && (
        <div className="form-error">Nenhum endereço de armazenagem cadastrado. Cadastre em Estoque &gt; Endereços.</div>
      )}
      {pending.length === 0 ? (
        <p className="settings-note">Nenhum material aguardando armazenagem.</p>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr><th>Ordem (OT)</th><th>Código</th><th>Descrição</th><th>Origem</th><th>Quantidade</th><th>Sugestão</th><th>Destino</th><th /></tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <Row key={`${r.inventory_id}-${version}`} row={r} destinations={destinations} otTypes={otTypes} onDone={done} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
