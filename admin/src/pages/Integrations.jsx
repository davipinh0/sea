import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { friendlyError } from '../utils/friendlyError.js';

export default function Integrations() {
  const { warehouseId } = useWarehouse();

  const [connectors, setConnectors] = useState([]);
  const [selectedConnector, setSelectedConnector] = useState(null);
  const [credForm, setCredForm] = useState({});
  const [credSaving, setCredSaving] = useState(false);
  const [credMsg, setCredMsg] = useState('');
  const [credError, setCredError] = useState('');
  const [storedKeys, setStoredKeys] = useState([]);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [syncStates, setSyncStates] = useState([]);
  const [syncingTypes, setSyncingTypes] = useState({});

  useEffect(() => {
    api.get('/admin/connectors').then(async (res) => {
      if (res?.ok) {
        const data = await res.json();
        setConnectors(data.connectors || []);
      }
    }).catch(() => {});
  }, []);

  function selectConnector(conn) {
    setSelectedConnector(conn);
    setCredForm({});
    setCredMsg('');
    setCredError('');
    setTestResult(null);
    setSyncStates([]);
    if (warehouseId) {
      api.get(`/admin/connectors/${conn.name}/credentials?warehouse_id=${warehouseId}`).then(async (res) => {
        if (res?.ok) {
          const data = await res.json();
          setStoredKeys(data.credentials || []);
        }
      }).catch(() => setStoredKeys([]));

      loadSyncStates(conn.name);
    }
  }

  async function loadSyncStates(connectorName) {
    try {
      const res = await api.get(`/admin/connectors/${connectorName}/sync-status?warehouse_id=${warehouseId}`);
      if (res?.ok) {
        const data = await res.json();
        setSyncStates(data.sync_states || []);
      }
    } catch { /* ignore */ }
  }

  function syncStateColor(state) {
    if (!state) return '#999';
    if (state.sync_status === 'error') return 'var(--danger)';
    if (state.consecutive_errors > 0) return '#d29922';
    return 'var(--success)';
  }

  function syncStateLabel(state) {
    if (!state) return 'Nunca sincronizado';
    if (state.sync_status === 'running') return 'Executando...';
    if (state.sync_status === 'error') return `Erro (${state.consecutive_errors} falhas)`;
    if (state.consecutive_errors > 0) return `A última tentativa falhou (${state.consecutive_errors})`;
    return 'Saudável';
  }

  async function triggerSync(syncType) {
    if (!selectedConnector || !warehouseId) return;
    setSyncingTypes((prev) => ({ ...prev, [syncType]: true }));
    try {
      const res = await api.post(`/admin/connectors/${selectedConnector.name}/sync/${syncType}`, {
        warehouse_id: warehouseId,
      });
      if (res?.status === 409) {
        setCredError('Sincronização já em andamento');
      } else if (res?.ok || res?.status === 202) {
        setCredMsg(`${syncType} sincronização na fila`);
        setTimeout(() => loadSyncStates(selectedConnector.name), 1000);
      } else {
        const data = await res.json().catch(() => ({}));
        setCredError(friendlyError(data, 'Falha na sincronização. Tente novamente.'));
      }
    } catch { setCredError('Erro de sincronização'); }
    setSyncingTypes((prev) => ({ ...prev, [syncType]: false }));
  }

  async function saveCredentials() {
    if (!selectedConnector || !warehouseId) return;
    setCredSaving(true);
    setCredMsg('');
    setCredError('');
    try {
      const res = await api.post(`/admin/connectors/${selectedConnector.name}/credentials`, {
        warehouse_id: warehouseId,
        credentials: credForm,
      });
      if (res?.ok) {
        setCredMsg('Credenciais salvas');
        setCredForm({});
        selectConnector(selectedConnector);
      } else {
        const data = await res.json().catch(() => ({}));
        setCredError(friendlyError(data, 'Falha ao salvar as credenciais.'));
      }
    } catch { setCredError('Erro de conexão'); }
    setCredSaving(false);
  }

  async function testConnectorConnection() {
    if (!selectedConnector || !warehouseId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post(`/admin/connectors/${selectedConnector.name}/test`, {
        warehouse_id: warehouseId,
      });
      if (res?.ok) {
        const data = await res.json();
        setTestResult(data);
      } else {
        const data = await res.json().catch(() => ({}));
        setTestResult({ connected: false, message: friendlyError(data, 'Falha no teste de conexão.') });
      }
    } catch { setTestResult({ connected: false, message: 'Erro de conexão' }); }
    setTesting(false);
  }

  async function deleteConnectorCredentials() {
    if (!selectedConnector || !warehouseId) return;
    if (!confirm('Excluir todas as credenciais deste conector?')) return;
    try {
      const res = await api.delete(`/admin/connectors/${selectedConnector.name}/credentials`);
      if (res?.ok) {
        setCredMsg('Credenciais excluídas');
        setStoredKeys([]);
      }
    } catch { setCredError('Falha ao excluir'); }
  }

  return (
    <div>
      <PageHeader title="Integrações" />

      <div className="settings-section">
        <h3>Integrações disponíveis</h3>
        <p className="settings-note">
          Conecte o SEA a ERPs e plataformas externas. As credenciais são criptografadas e restritas por armazém.
        </p>
        {connectors.length === 0 ? (
          <p style={{ color: '#666', fontSize: 14 }}>
            Nenhum conector registrado. Coloque um módulo de conector em{' '}
            <span className="mono">api/connectors/</span> e reinicie a API para disponibilizá-lo aqui. Veja o <a href="https://hightower-systems.github.io/sentry-wms/connectors/" target="_blank" rel="noopener noreferrer">guia do framework de conectores</a>.
          </p>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {connectors.map((c) => (
              <button
                key={c.name}
                className={`btn ${selectedConnector?.name === c.name ? 'btn-primary' : ''}`}
                onClick={() => selectConnector(c)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {selectedConnector && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, background: 'var(--card-bg)' }}>
            <h4 style={{ marginTop: 0 }}>{selectedConnector.name}</h4>
            <p style={{ fontSize: 12, color: '#666' }}>
              Recursos: {selectedConnector.capabilities.join(', ')}
            </p>

            {storedKeys.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <strong style={{ fontSize: 13 }}>Credenciais armazenadas:</strong>
                <div style={{ marginTop: 4 }}>
                  {storedKeys.map((k) => (
                    <div key={k.key} style={{ fontSize: 13, fontFamily: 'monospace' }}>
                      {k.key}: {k.value}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <strong style={{ fontSize: 13 }}>Saúde da sincronização</strong>
              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                {['orders', 'items', 'inventory'].map((syncType) => {
                  const state = syncStates.find((s) => s.sync_type === syncType);
                  const color = syncStateColor(state);
                  const label = syncStateLabel(state);
                  const isRunning = state?.sync_status === 'running' || syncingTypes[syncType];
                  return (
                    <div
                      key={syncType}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: 8,
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        fontSize: 13,
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: color,
                        }}
                      />
                      <strong style={{ minWidth: 90, textTransform: 'capitalize' }}>{syncType}</strong>
                      <span style={{ color: '#666', flex: 1 }}>{label}</span>
                      {state?.last_synced_at && (
                        <span style={{ color: '#999', fontSize: 11 }}>
                          Última: {new Date(state.last_synced_at).toLocaleString()}
                        </span>
                      )}
                      <button
                        className="btn"
                        onClick={() => triggerSync(syncType)}
                        disabled={isRunning}
                      >
                        {isRunning ? 'Sincronizando...' : 'Sincronizar agora'}
                      </button>
                    </div>
                  );
                })}
              </div>
              {syncStates.some((s) => s.last_error_message) && (
                <div style={{ marginTop: 8 }}>
                  {syncStates.filter((s) => s.last_error_message).map((s) => (
                    <div key={s.sync_type} style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
                      {s.sync_type}: {s.last_error_message}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              {Object.entries(selectedConnector.config_schema).map(([key, schema]) => (
                <div key={key} className="form-group" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 13 }}>
                    {schema.label || key} {schema.required && <span style={{ color: 'var(--danger)' }}>*</span>}
                  </label>
                  <input
                    className="form-input"
                    type="password"
                    placeholder={schema.description || key}
                    value={credForm[key] || ''}
                    onChange={(e) => setCredForm({ ...credForm, [key]: e.target.value })}
                  />
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={saveCredentials} disabled={credSaving || Object.keys(credForm).length === 0}>
                {credSaving ? 'Salvando...' : 'Salvar credenciais'}
              </button>
              <button className="btn" onClick={testConnectorConnection} disabled={testing}>
                {testing ? 'Testando...' : 'Testar conexão'}
              </button>
              {storedKeys.length > 0 && (
                <button className="btn btn-danger" onClick={deleteConnectorCredentials}>Excluir credenciais</button>
              )}
            </div>

            {credMsg && <p style={{ color: 'var(--success)', fontSize: 13, marginTop: 8 }}>{credMsg}</p>}
            {credError && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{credError}</p>}
            {testResult && (
              <p style={{ color: testResult.connected ? 'var(--success)' : 'var(--danger)', fontSize: 13, marginTop: 8 }}>
                {testResult.connected ? 'Conectado' : 'Falhou'}: {testResult.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
