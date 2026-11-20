import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import { readError } from '../utils/sea.js';
import { useLiveRefresh } from '../utils/useLiveRefresh.js';

// Materiais consultados ao montar uma OT: o código traz descrição, unidade e peso da caixa daqui.

const UNITS = ['PC', 'KG', 'PAR'];
const EMPTY = { material_code: '', description: '', uom: '', pack_weight_kg: '' };

export default function CadastroMateriais() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useLiveRefresh(() => setTick((n) => n + 1));

  useEffect(() => {
    let cancelled = false;
    api.get(`/sea/catalogo?q=${encodeURIComponent(search)}&page=${page}`).then(async (res) => {
      if (cancelled || !res) return;
      if (!res.ok) { setMessage({ type: 'error', text: await readError(res, 'Não foi possível carregar o cadastro.') }); return; }
      setData(await res.json());
    });
    return () => { cancelled = true; };
  }, [search, page, tick]);

  async function save() {
    setFormError('');
    const code = form.material_code.trim();
    const description = form.description.trim();
    const isKg = form.uom === 'KG';
    const pack = isKg && String(form.pack_weight_kg).trim() !== '' ? Number(form.pack_weight_kg) : null;
    if (!code) { setFormError('Informe o código do material.'); return; }
    if (!description) { setFormError('Informe a descrição.'); return; }
    if (pack !== null && (!Number.isInteger(pack) || pack <= 0)) { setFormError('O peso por caixa precisa ser um número inteiro maior que zero.'); return; }
    const body = { description, uom: form.uom || null, pack_weight_kg: pack };
    setBusy(true);
    const res = form.editing
      ? await api.put(`/sea/catalogo/${encodeURIComponent(form.editing)}`, body)
      : await api.post('/sea/catalogo', { material_code: code, ...body });
    setBusy(false);
    if (!res) return;
    if (!res.ok) { setFormError(await readError(res, 'Não foi possível salvar o material.')); return; }
    setMessage({ type: 'ok', text: form.editing ? `Material ${code} atualizado.` : `Material ${code} cadastrado.` });
    setForm(null);
  }

  async function remove() {
    const code = removing.material_code;
    setRemoving(null);
    const res = await api.delete(`/sea/catalogo/${encodeURIComponent(code)}`);
    if (!res) return;
    if (!res.ok) { setMessage({ type: 'error', text: await readError(res, 'Não foi possível excluir o material.') }); return; }
    setMessage({ type: 'ok', text: `Material ${code} excluído do cadastro.` });
  }

  const rows = data?.materials || [];

  return (
    <div>
      <PageHeader title="Cadastro de materiais">
        <button type="button" className="btn btn-primary" onClick={() => { setFormError(''); setForm({ ...EMPTY, editing: null }); }}>Novo material</button>
      </PageHeader>
      <p className="settings-note">
        Materiais consultados ao montar uma OT: ao informar o código, o SEA traz a descrição, a unidade e o peso por caixa daqui.
      </p>

      {message && (
        <div className={message.type === 'error' ? 'form-error' : 'tag tag-success'} role={message.type === 'error' ? 'alert' : 'status'} style={{ display: 'block', padding: 10, marginBottom: 12 }}>
          {message.text}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="form-input" aria-label="Buscar no cadastro" placeholder="Buscar por código ou descrição" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn">Buscar</button>
      </form>

      {data && rows.length === 0 && <p className="settings-note">{search ? 'Nenhum material encontrado para esta busca.' : 'O cadastro está vazio.'}</p>}
      {rows.length > 0 && (
        <table className="lines-table">
          <thead><tr><th>Código</th><th>Descrição</th><th>Unidade</th><th>Peso por caixa</th><th /></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.material_code}>
                <td className="mono">{m.material_code}</td>
                <td>{m.description}</td>
                <td>{m.uom || '-'}</td>
                <td>{m.pack_weight_kg ? `${m.pack_weight_kg} kg` : '-'}</td>
                <td>
                  <button type="button" className="btn btn-sm" aria-label={`Alterar ${m.material_code}`}
                    onClick={() => { setFormError(''); setForm({ ...m, uom: m.uom || '', pack_weight_kg: m.pack_weight_kg ?? '', editing: m.material_code }); }}>Alterar</button>
                  <button type="button" className="btn btn-sm btn-danger" style={{ marginLeft: 6 }} aria-label={`Excluir ${m.material_code}`} onClick={() => setRemoving(m)}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.pages > 1 && (
        <div className="pagination">
          <span>Página {data.page} de {data.pages} ({data.total} no total)</span>
          <div className="pagination-buttons">
            <button type="button" className="pagination-btn" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Anterior</button>
            <button type="button" className="pagination-btn" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>Próxima</button>
          </div>
        </div>
      )}

      {form && (
        <Modal
          title={form.editing ? `Alterar material ${form.editing}` : 'Novo material'} onClose={() => setForm(null)}
          footer={<>
            <button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Salvar</button>
          </>}
        >
          <div className="form-group">
            <label htmlFor="cat-code">Código *</label>
            <input id="cat-code" className="form-input mono" disabled={!!form.editing} value={form.material_code} onChange={(e) => setForm({ ...form, material_code: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="cat-desc">Descrição *</label>
            <input id="cat-desc" className="form-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="cat-uom">Unidade</label>
            <select id="cat-uom" className="form-select" value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })}>
              <option value="">Não definida</option>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              {form.uom && !UNITS.includes(form.uom) && <option value={form.uom}>{form.uom}</option>}
            </select>
          </div>
          {form.uom === 'KG' && (
            <div className="form-group">
              <label htmlFor="cat-pack">Peso por caixa (kg)</label>
              <input id="cat-pack" className="form-input" type="number" min="1" step="1" placeholder="ex.: 18" value={form.pack_weight_kg} onChange={(e) => setForm({ ...form, pack_weight_kg: e.target.value })} />
              <div className="settings-note">O estoque fica em quilos e a retirada é feita por caixa. Em branco: a retirada é por quilo.</div>
            </div>
          )}
          {formError && <div className="form-error" role="alert">{formError}</div>}
        </Modal>
      )}

      {removing && (
        <Modal
          title={`Excluir material ${removing.material_code}`} onClose={() => setRemoving(null)}
          footer={<>
            <button type="button" className="btn" onClick={() => setRemoving(null)}>Cancelar</button>
            <button type="button" className="btn btn-danger" onClick={remove}>Excluir</button>
          </>}
        >
          <p>{removing.description} sai do cadastro. O estoque e as ordens já registradas não são alterados.</p>
        </Modal>
      )}
    </div>
  );
}
