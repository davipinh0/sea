import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useDirtyFormGuard } from '../hooks/useDirtyFormGuard.js';

// As regras de armazenagem ficam em cada endereço e material (Estoque > Endereços / Materiais),
// junto dos dados.

const SETTING_DEFAULTS = {
  default_receiving_bin: '',
  allow_over_receiving: 'false',
  session_timeout_hours: '8',
};

function toBool(v) {
  return v === true || v === 'true';
}

export default function Settings() {
  const { warehouseId } = useWarehouse();
  const [warehouse, setWarehouse] = useState(null);
  const [whForm, setWhForm] = useState({});
  const [editingWh, setEditingWh] = useState(false);
  const [savedSettings, setSavedSettings] = useState({});
  const [draftSettings, setDraftSettings] = useState({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSuccess, setSettingsSuccess] = useState('');
  const [receivingBins, setReceivingBins] = useState([]);

  const hasUnsavedChanges = JSON.stringify(savedSettings) !== JSON.stringify(draftSettings);
  useDirtyFormGuard(hasUnsavedChanges);

  useEffect(() => {
    if (!warehouseId) return;
    api.get(`/admin/warehouses/${warehouseId}`).then(async (res) => {
      if (res?.ok) {
        const data = await res.json();
        setWarehouse(data);
        setWhForm(data);
      }
    });

    Promise.all(Object.keys(SETTING_DEFAULTS).map((key) => api.get(`/admin/settings/${key}`)))
      .then(async (responses) => {
        const initial = { ...SETTING_DEFAULTS };
        for (const res of responses) {
          if (res?.ok) {
            const data = await res.json();
            if (data && data.key) initial[data.key] = data.value;
          }
        }
        setSavedSettings({ ...initial });
        setDraftSettings({ ...initial });
      });

    api.get(`/admin/bins?warehouse_id=${warehouseId}&per_page=500`).then(async (res) => {
      if (res?.ok) {
        const data = await res.json();
        setReceivingBins((data.bins || []).filter((b) => b.bin_type === 'Staging' || b.bin_type === 'PickableStaging'));
      }
    });
  }, [warehouseId]);

  function updateDraft(key, value) {
    setDraftSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsSuccess('');
  }

  async function saveSettings() {
    setSettingsSaving(true);
    setSettingsError('');
    setSettingsSuccess('');
    const res = await api.put('/admin/settings', { settings: draftSettings });
    if (res?.ok) {
      setSavedSettings({ ...draftSettings });
      setSettingsSuccess('Configurações salvas');
    } else {
      const data = await res?.json();
      setSettingsError(data?.error || 'Falha ao salvar as configurações');
    }
    setSettingsSaving(false);
  }

  async function saveWarehouse() {
    const res = await api.put(`/admin/warehouses/${warehouseId}`, { warehouse_name: whForm.warehouse_name, address: whForm.address });
    if (res?.ok) {
      setWarehouse(await res.json());
      setEditingWh(false);
    }
  }

  return (
    <div>
      <PageHeader title="Configurações" />

      <div className="settings-section">
        <h3>Local</h3>
        {warehouse && !editingWh && (
          <div>
            <div className="detail-grid" style={{ marginBottom: 12 }}>
              <span className="detail-label">Nome</span><span>{warehouse.warehouse_name}</span>
              <span className="detail-label">Código</span><span className="mono">{warehouse.warehouse_code}</span>
              <span className="detail-label">Localização</span><span>{warehouse.address || '-'}</span>
            </div>
            <button className="btn btn-sm" onClick={() => setEditingWh(true)}>Editar</button>
          </div>
        )}
        {editingWh && (
          <div>
            <div className="form-group">
              <label htmlFor="wh-name">Nome</label>
              <input id="wh-name" className="form-input" value={whForm.warehouse_name || ''} onChange={(e) => setWhForm({ ...whForm, warehouse_name: e.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="wh-address">Localização</label>
              <input id="wh-address" className="form-input" value={whForm.address || ''} onChange={(e) => setWhForm({ ...whForm, address: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setEditingWh(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={saveWarehouse}>Salvar</button>
            </div>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>Recebimento</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <label htmlFor="default-bin" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>Área de recebimento padrão</label>
          <select
            id="default-bin"
            className="form-select"
            style={{ width: 220 }}
            value={draftSettings.default_receiving_bin || ''}
            onChange={(e) => updateDraft('default_receiving_bin', e.target.value)}
          >
            <option value="">Selecione…</option>
            {receivingBins.map((b) => <option key={b.bin_id} value={String(b.bin_id)}>{b.bin_code}</option>)}
          </select>
        </div>
        <p className="settings-note">Onde o material recebido aguarda a armazenagem. O app móvel usa este valor como padrão.</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, padding: '8px 0' }}>
          <input
            type="checkbox"
            checked={toBool(draftSettings.allow_over_receiving)}
            onChange={(e) => updateDraft('allow_over_receiving', String(e.target.checked))}
          />
          Permitir receber acima da quantidade prevista na OT
        </label>
        <p className="settings-note">Desligado (recomendado): o recebimento acima do previsto é bloqueado.</p>
      </div>

      <div className="settings-section">
        <h3>Sessão</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <label htmlFor="session-hours" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>Duração da sessão (horas)</label>
          <input
            id="session-hours"
            type="number" min="1" max="24"
            className="form-input" style={{ width: 90 }}
            value={draftSettings.session_timeout_hours || ''}
            onChange={(e) => updateDraft('session_timeout_hours', e.target.value)}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3>Regras de armazenagem do SP12</h3>
        <p className="settings-note">
          Capacidade e classe de tamanho de cada endereço (ex.: A3 para peças pequenas) ficam em{' '}
          <Link to="/estoque/enderecos">Estoque &gt; Endereços</Link>; a classe de tamanho e o grupo de
          compatibilidade de cada material ficam em <Link to="/estoque/materiais">Estoque &gt; Materiais</Link>.
          Campos em branco significam &quot;não configurado&quot; (sem limite).
        </p>
      </div>

      <div className="settings-section" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={saveSettings} disabled={!hasUnsavedChanges || settingsSaving}>
          {settingsSaving ? 'Salvando...' : 'Salvar configurações'}
        </button>
        {hasUnsavedChanges && <span style={{ fontSize: 12, color: 'var(--accent)' }}>Alterações não salvas</span>}
        {settingsSuccess && <span style={{ fontSize: 12, color: 'var(--success)' }}>{settingsSuccess}</span>}
        {settingsError && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{settingsError}</span>}
      </div>

      <div className="settings-section">
        <h3>Sobre</h3>
        <div className="detail-grid">
          <span className="detail-label">Sistema</span><span>SEA - Sistema de Entrada e Armazenamento</span>
          <span className="detail-label">Licença</span>
          <span>Apache 2.0</span>
        </div>
      </div>
    </div>
  );
}
