import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useWarehouse } from '../warehouse.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import { useDirtyFormGuard } from '../hooks/useDirtyFormGuard.js';

export default function Settings() {
  const { warehouseId } = useWarehouse();
  const [warehouse, setWarehouse] = useState(null);
  const [whForm, setWhForm] = useState({});
  const [editingWh, setEditingWh] = useState(false);
  const [showPO, setShowPO] = useState(false);
  const [showSO, setShowSO] = useState(false);
  const [poForm, setPoForm] = useState({ po_number: '', vendor_name: '', vendor_address: '', warehouse_id: null, lines: [{ sku: '', quantity_ordered: '' }] });
  const [soForm, setSoForm] = useState({ order_number: '', customer_name: '', address_line_1: '', address_line_2: '', city: '', state: '', zip: '', phone: '', warehouse_id: null, lines: [{ sku: '', quantity_ordered: '' }] });
  const [itemsBySku, setItemsBySku] = useState(new Map());
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  // Settings with save button
  const [savedSettings, setSavedSettings] = useState({});
  const [draftSettings, setDraftSettings] = useState({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSuccess, setSettingsSuccess] = useState('');
  const [receivingBins, setReceivingBins] = useState([]);

  const hasUnsavedChanges = JSON.stringify(savedSettings) !== JSON.stringify(draftSettings);

  // v1.4.2 #100: browser-level warning only. Hook owns the
  // beforeunload listener. Intra-SPA sidebar clicks are NOT guarded;
  // deferred to v1.5 along with the rest of the design question.
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

    // Load all settings
    Promise.all([
      api.get('/admin/settings/count_show_expected'),
      api.get('/admin/settings/require_packing_before_shipping'),
      api.get('/admin/settings/allow_over_receiving'),
      api.get('/admin/settings/default_receiving_bin'),
      api.get('/admin/settings/require_count_approval_separation'),
      api.get('/admin/settings/picking_ticket_company_name'),
      api.get('/admin/settings/picking_ticket_company_address'),
      api.get('/admin/settings/picking_ticket_logo_url'),
      api.get('/admin/settings/picking_ticket_returns_text'),
      api.get('/admin/settings/pos_activity_enabled'),
      api.get('/admin/settings/fraud_review_billing_shipping'),
      api.get('/admin/settings/dashboard_bubble_origins'),
    ]).then(async (responses) => {
      const initial = {};
      for (const res of responses) {
        if (res?.ok) {
          const data = await res.json();
          initial[data.key] = data.value;
        }
      }
      // Set defaults for missing settings
      if (!('count_show_expected' in initial)) initial.count_show_expected = 'true';
      if (!('require_packing_before_shipping' in initial)) initial.require_packing_before_shipping = 'true';
      if (!('allow_over_receiving' in initial)) initial.allow_over_receiving = 'true';
      if (!('default_receiving_bin' in initial)) initial.default_receiving_bin = '';
      if (!('require_count_approval_separation' in initial)) initial.require_count_approval_separation = 'false';
      // Picking-ticket / packing-slip branding. All default to empty so a
      // fresh install prints a clean, unbranded slip until an operator
      // fills these in.
      if (!('picking_ticket_company_name' in initial)) initial.picking_ticket_company_name = '';
      if (!('picking_ticket_company_address' in initial)) initial.picking_ticket_company_address = '';
      if (!('picking_ticket_logo_url' in initial)) initial.picking_ticket_logo_url = '';
      if (!('picking_ticket_returns_text' in initial)) initial.picking_ticket_returns_text = '';
      // POS Activity tab is hidden by default; deployments using the POS
      // checkout surface opt in. Sidebar reads the same key to gate the nav.
      if (!('pos_activity_enabled' in initial)) initial.pos_activity_enabled = 'false';
      // Billing != shipping fraud heuristic is opt-in: off by default so
      // a fresh install never parks orders in FRAUD_REVIEW automatically.
      if (!('fraud_review_billing_shipping' in initial)) initial.fraud_review_billing_shipping = 'false';
      // Marketplace Health bubble set: a JSON array of {origin, label}. Empty
      // by default so the dashboard surfaces no channels until an operator
      // adds them; the dashboard endpoint reads the same key.
      if (!('dashboard_bubble_origins' in initial)) initial.dashboard_bubble_origins = '[]';
      setSavedSettings({ ...initial });
      setDraftSettings({ ...initial });
    });

    api.get(`/admin/bins?warehouse_id=${warehouseId}&bin_type=Staging`).then(async (res) => {
      if (res?.ok) {
        const data = await res.json();
        setReceivingBins(data.bins || []);
      }
    }).catch(() => {
      api.get(`/admin/bins?warehouse_id=${warehouseId}`).then(async (res) => {
        if (res?.ok) {
          const data = await res.json();
          setReceivingBins((data.bins || []).filter((b) => b.bin_type === 'Staging'));
        }
      }).catch(() => {});
    });
  }, [warehouseId]);

  function updateDraft(key, value) {
    setDraftSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsSuccess('');
  }

  // Marketplace Health bubble set is stored as a JSON string in
  // draftSettings.dashboard_bubble_origins; parse / mutate / re-serialize
  // around the flat string the settings store keeps.
  function bubbleRows() {
    try {
      const parsed = JSON.parse(draftSettings.dashboard_bubble_origins || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function setBubbleRows(rows) {
    updateDraft('dashboard_bubble_origins', JSON.stringify(rows));
  }

  function updateBubble(i, field, value) {
    const rows = bubbleRows();
    rows[i] = { ...rows[i], [field]: value };
    setBubbleRows(rows);
  }

  function addBubble() {
    setBubbleRows([...bubbleRows(), { origin: '', label: '' }]);
  }

  function removeBubble(i) {
    const rows = bubbleRows();
    rows.splice(i, 1);
    setBubbleRows(rows);
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

  // v1.4.2 #93: cache SKU -> item_id lookup so the PO/SO manual-entry
  // lines can accept an SKU (what operators memorize) instead of a
  // raw item_id (a database autoincrement). Loaded lazily when either
  // modal opens so Settings' first paint does not fetch /admin/items.
  //
  // The cache holds the first 1000 active items for instant typeahead
  // and autocomplete; catalogues larger than 1000 fall back to a
  // per-SKU server lookup in resolveSku so a less-common SKU at line
  // submit time still resolves correctly instead of silently failing.
  async function ensureItemsLoaded() {
    if (itemsLoaded) return;
    const res = await api.get('/admin/items?per_page=1000&active=true', { silentPermissionDenied: true });
    if (res?.ok) {
      const data = await res.json();
      const map = new Map();
      for (const it of data.items || []) {
        if (it.sku) map.set(String(it.sku).trim().toLowerCase(), it.item_id);
      }
      setItemsBySku(map);
      setItemsLoaded(true);
    }
  }

  async function resolveSku(sku) {
    const key = String(sku || '').trim().toLowerCase();
    if (!key) return null;
    if (itemsBySku.has(key)) return itemsBySku.get(key);
    // Cache miss: catalogue > 1000 items or the SKU is brand new. A
    // narrow server-side query backs the cache so submit does not
    // depend on the pre-loaded slice.
    const res = await api.get(`/admin/items?q=${encodeURIComponent(sku)}&per_page=10&active=true`);
    if (!res?.ok) return null;
    const data = await res.json();
    const match = (data.items || []).find(
      (i) => String(i.sku || '').trim().toLowerCase() === key,
    );
    return match ? match.item_id : null;
  }

  function openPoModal() {
    setShowPO(true);
    setFormError('');
    ensureItemsLoaded();
  }

  function openSoModal() {
    setShowSO(true);
    setFormError('');
    ensureItemsLoaded();
  }

  // v1.4.2 #92: reset modal state on every Cancel/close. Without this,
  // a second "Create PO" click reopens the modal with stale fields
  // from the previous attempt -- either data that was already
  // submitted or a half-filled form the user abandoned.
  function closePoModal() {
    setShowPO(false);
    setPoForm({ po_number: '', vendor_name: '', vendor_address: '', warehouse_id: warehouseId, lines: [{ sku: '', quantity_ordered: '' }] });
    setFormError('');
  }

  function closeSoModal() {
    setShowSO(false);
    setSoForm({ order_number: '', customer_name: '', address_line_1: '', address_line_2: '', city: '', state: '', zip: '', phone: '', warehouse_id: warehouseId, lines: [{ sku: '', quantity_ordered: '' }] });
    setFormError('');
  }

  // PO lines
  function addPOLine() { setPoForm({ ...poForm, lines: [...poForm.lines, { sku: '', quantity_ordered: '' }] }); }
  function updatePOLine(i, key, val) {
    const lines = [...poForm.lines];
    lines[i] = { ...lines[i], [key]: val };
    setPoForm({ ...poForm, lines });
  }

  async function createPO() {
    setFormError(''); setFormSuccess('');
    const entries = poForm.lines.filter((x) => x.sku);
    // Resolve all SKUs in parallel so a multi-line PO does not pay
    // a round-trip per line when the cache misses.
    const ids = await Promise.all(entries.map((l) => resolveSku(l.sku)));
    const resolved = [];
    for (let i = 0; i < entries.length; i++) {
      const itemId = ids[i];
      if (!itemId) {
        setFormError(`SKU desconhecido: ${entries[i].sku}`);
        return;
      }
      resolved.push({ item_id: itemId, quantity_ordered: Number(entries[i].quantity_ordered) });
    }
    const body = {
      po_number: poForm.po_number,
      warehouse_id: poForm.warehouse_id || warehouseId,
      vendor_name: poForm.vendor_name || null,
      notes: poForm.vendor_address ? `Endereço do fornecedor: ${poForm.vendor_address}` : null,
      lines: resolved,
    };
    const res = await api.post('/admin/purchase-orders', body);
    if (res?.ok) {
      setFormSuccess('PC criado');
      setShowPO(false);
      setPoForm({ po_number: '', vendor_name: '', vendor_address: '', warehouse_id: warehouseId, lines: [{ sku: '', quantity_ordered: '' }] });
    } else {
      const data = await res?.json();
      setFormError(data?.error || 'Falha ao criar PC');
    }
  }

  // SO lines
  function addSOLine() { setSoForm({ ...soForm, lines: [...soForm.lines, { sku: '', quantity_ordered: '' }] }); }
  function updateSOLine(i, key, val) {
    const lines = [...soForm.lines];
    lines[i] = { ...lines[i], [key]: val };
    setSoForm({ ...soForm, lines });
  }

  async function createSO() {
    setFormError(''); setFormSuccess('');
    const shipAddress = [soForm.address_line_1, soForm.address_line_2, soForm.city, soForm.state, soForm.zip].filter(Boolean).join(', ');
    const entries = soForm.lines.filter((x) => x.sku);
    const ids = await Promise.all(entries.map((l) => resolveSku(l.sku)));
    const resolved = [];
    for (let i = 0; i < entries.length; i++) {
      const itemId = ids[i];
      if (!itemId) {
        setFormError(`SKU desconhecido: ${entries[i].sku}`);
        return;
      }
      resolved.push({ item_id: itemId, quantity_ordered: Number(entries[i].quantity_ordered) });
    }
    const body = {
      so_number: soForm.order_number,
      customer_name: soForm.customer_name || null,
      customer_phone: soForm.phone || null,
      customer_address: shipAddress || null,
      ship_address: shipAddress || null,
      warehouse_id: soForm.warehouse_id || warehouseId,
      lines: resolved,
    };
    const res = await api.post('/admin/sales-orders', body);
    if (res?.ok) {
      setFormSuccess('PV criado');
      setShowSO(false);
      setSoForm({ order_number: '', customer_name: '', address_line_1: '', address_line_2: '', city: '', state: '', zip: '', phone: '', warehouse_id: warehouseId, lines: [{ sku: '', quantity_ordered: '' }] });
    } else {
      const data = await res?.json();
      setFormError(data?.error || 'Falha ao criar PV');
    }
  }

  const toBool = (v) => v !== 'false' && v !== false;

  return (
    <div>
      {/* v1.4.2 #93: shared SKU datalist for the PO + SO manual-entry
          line inputs. Lives outside the modals so the <input list>
          reference resolves whether either modal is open. */}
      <datalist id="settings-sku-datalist">
        {Array.from(itemsBySku.keys()).map((k) => (
          <option key={k} value={k.toUpperCase()} />
        ))}
      </datalist>
      <PageHeader title="Configurações" />

      {formSuccess && <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--success-bg)', color: 'var(--success)', borderRadius: 'var(--radius)', fontSize: 13 }}>{formSuccess}</div>}

      {/* Warehouse config */}
      <div className="settings-section">
        <h3>Armazém</h3>
        {warehouse && !editingWh && (
          <div>
            <div className="detail-grid" style={{ marginBottom: 12 }}>
              <span className="detail-label">Nome</span><span>{warehouse.warehouse_name}</span>
              <span className="detail-label">Código</span><span className="mono">{warehouse.warehouse_code}</span>
              <span className="detail-label">Endereço postal</span><span>{warehouse.address || '-'}</span>
            </div>
            <button className="btn btn-sm" onClick={() => setEditingWh(true)}>Editar</button>
          </div>
        )}
        {editingWh && (
          <div>
            <div className="form-group">
              <label>Nome</label>
              <input className="form-input" value={whForm.warehouse_name || ''} onChange={(e) => setWhForm({ ...whForm, warehouse_name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Endereço postal</label>
              <input className="form-input" value={whForm.address || ''} onChange={(e) => setWhForm({ ...whForm, address: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setEditingWh(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={saveWarehouse}>Salvar</button>
            </div>
          </div>
        )}
      </div>

      {/* Manual PO/SO */}
      <div className="settings-section">
        <h3>Cadastro manual</h3>
        <p className="settings-note">Apenas para implantações independentes ou testes. Em produção, PCs e PVs vêm do seu ERP.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={openPoModal}>Criar pedido de compra</button>
          <button className="btn" onClick={openSoModal}>Criar pedido de venda</button>
        </div>
      </div>

      {/* Fulfillment Workflow */}
      <div className="settings-section">
        <h3>Fluxo de atendimento</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={toBool(draftSettings.require_packing_before_shipping)}
              onChange={(e) => updateDraft('require_packing_before_shipping', String(e.target.checked))}
            />
            Exigir embalagem antes da expedição
          </label>
        </div>
        <p className="settings-note">Quando ligado, os pedidos precisam ser embalados antes da expedição. Quando desligado, pedidos separados podem ser expedidos diretamente.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', marginTop: 8 }}>
          <label style={{ fontSize: 13, whiteSpace: 'nowrap' }}>Endereço padrão de recebimento</label>
          <select
            className="form-select"
            style={{ width: 200 }}
            value={draftSettings.default_receiving_bin || ''}
            onChange={(e) => updateDraft('default_receiving_bin', e.target.value)}
          >
            <option value="">Selecione o endereço...</option>
            {receivingBins.map((b) => (
              <option key={b.bin_id} value={String(b.bin_id)}>{b.bin_code}</option>
            ))}
          </select>
        </div>
        <p className="settings-note">Endereço padrão onde os materiais recebidos ficam em staging. Usuários do app móvel podem alterar por sessão.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={toBool(draftSettings.allow_over_receiving)}
              onChange={(e) => updateDraft('allow_over_receiving', String(e.target.checked))}
            />
            Permitir recebimento acima do pedido
          </label>
        </div>
        <p className="settings-note">Quando ligado, os usuários podem receber mais do que a quantidade do PC (com aviso). Quando desligado, o recebimento acima do pedido é bloqueado.</p>
      </div>

      {/* Mobile App Settings */}
      <div className="settings-section">
        <h3>Aplicativo móvel</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={toBool(draftSettings.count_show_expected)}
              onChange={(e) => updateDraft('count_show_expected', String(e.target.checked))}
            />
            Mostrar quantidades esperadas nas contagens cíclicas
          </label>
        </div>
        <p className="settings-note">Quando desligado, os contadores não veem as quantidades esperadas - útil para contagens cegas.</p>
      </div>

      {/* Inventory */}
      <div className="settings-section">
        <h3>Estoque</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={toBool(draftSettings.require_count_approval_separation)}
              onChange={(e) => updateDraft('require_count_approval_separation', String(e.target.checked))}
            />
            Exigir aprovador separado para ajustes de contagem cíclica
          </label>
        </div>
        <p className="settings-note">Quando ligado, o administrador que fez a contagem cíclica não pode aprovar os ajustes resultantes. Outro administrador deve revisar e aprovar.</p>
      </div>

      <div className="settings-section">
        <h3>PDV</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={toBool(draftSettings.pos_activity_enabled)}
              onChange={(e) => updateDraft('pos_activity_enabled', String(e.target.checked))}
            />
            Mostrar o painel Atividade PDV
          </label>
        </div>
        <p className="settings-note">Adiciona a aba Atividade PDV no menu Saída, com a atividade de pedidos do ponto de venda e indicadores diários. Desligado por padrão; ative-o em implantações que usam o checkout PDV.</p>
      </div>

      <div className="settings-section">
        <h3>Análise de fraude</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={toBool(draftSettings.fraud_review_billing_shipping)}
              onChange={(e) => updateDraft('fraud_review_billing_shipping', String(e.target.checked))}
            />
            Sinalizar automaticamente pedidos com endereço de cobrança diferente do de entrega
          </label>
        </div>
        <p className="settings-note">Uma heurística embutida para a fila Saída &gt; Fraude: quando ligada, um pedido recebido cujos endereços de cobrança e entrega divergem (rua / cidade / estado / CEP, ambos preenchidos) vai para FRAUD_REVIEW e fica fora da separação até um atendente liberá-lo. Desligado por padrão. Um atendente sempre pode sinalizar ou liberar um pedido manualmente, independentemente desta configuração.</p>
      </div>

      <div className="settings-section">
        <h3>Saúde dos marketplaces</h3>
        <p className="settings-note">
          Canais exibidos em Painel &gt; Saúde dos marketplaces. A origem é comparada literalmente com o campo do pedido de venda <code>order_origin</code>
          (o rótulo gravado pelo mapeamento do canal de entrada, ou "Phone Order" para pedidos por telefone no PDV); Rótulo é o nome exibido no indicador. Sem canais configurados a visualização fica vazia -- adicione uma linha por canal que deve ter indicador.
        </p>
        {bubbleRows().map((b, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', maxWidth: 560, alignItems: 'center' }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              value={b.origin || ''}
              onChange={(e) => updateBubble(i, 'origin', e.target.value)}
              placeholder="order_origin value (e.g. AMAZON)"
            />
            <input
              className="form-input"
              style={{ flex: 1 }}
              value={b.label || ''}
              onChange={(e) => updateBubble(i, 'label', e.target.value)}
              placeholder="Rótulo de exibição (ex.: Amazon)"
            />
            <button type="button" className="btn btn-secondary" onClick={() => removeBubble(i)}>
              Remover
            </button>
          </div>
        ))}
        <div style={{ padding: '8px 0' }}>
          <button type="button" className="btn btn-secondary" onClick={addBubble}>
            Adicionar canal
          </button>
        </div>
      </div>

      {/* Picking Ticket branding */}
      <div className="settings-section">
        <h3>Ficha de separação</h3>
        <p className="settings-note">
          Identidade visual do romaneio imprimível (Saída &gt; Fichas de separação). Todos os campos são opcionais; deixe-os em branco para um romaneio limpo, sem marca.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', maxWidth: 480 }}>
          <label style={{ fontSize: 13 }}>Nome da empresa</label>
          <input
            className="form-input"
            value={draftSettings.picking_ticket_company_name || ''}
            onChange={(e) => updateDraft('picking_ticket_company_name', e.target.value)}
            placeholder="ex.: Distribuidora Exemplo"
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', maxWidth: 480 }}>
          <label style={{ fontSize: 13 }}>Endereço da empresa</label>
          <textarea
            className="form-input"
            rows={4}
            value={draftSettings.picking_ticket_company_address || ''}
            onChange={(e) => updateDraft('picking_ticket_company_address', e.target.value)}
            placeholder={'Uma linha por item, ex.:\nRua do Armazém, 123\nGalpão 100\nCidade UF 00000-000'}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', maxWidth: 480 }}>
          <label style={{ fontSize: 13 }}>URL do logo</label>
          <input
            className="form-input"
            value={draftSettings.picking_ticket_logo_url || ''}
            onChange={(e) => updateDraft('picking_ticket_logo_url', e.target.value)}
            placeholder="/picking-tickets/logo.png or https://..."
          />
          <p className="settings-note">Caminho ou URL de uma imagem de logo exibida no cabeçalho do romaneio. Em branco, oculta.</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', maxWidth: 480 }}>
          <label style={{ fontSize: 13 }}>Texto de devoluções</label>
          <textarea
            className="form-input"
            rows={3}
            value={draftSettings.picking_ticket_returns_text || ''}
            onChange={(e) => updateDraft('picking_ticket_returns_text', e.target.value)}
            placeholder="ex.: Devoluções aceitas em até 30 dias. Veja exemplo.com/devolucoes."
          />
        </div>
      </div>

      {/* Save button */}
      <div className="settings-section" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={saveSettings} disabled={!hasUnsavedChanges || settingsSaving}>
          {settingsSaving ? 'Salvando...' : 'Salvar configurações'}
        </button>
        {hasUnsavedChanges && <span style={{ fontSize: 12, color: 'var(--copper)' }}>Alterações não salvas</span>}
        {settingsSuccess && <span style={{ fontSize: 12, color: 'var(--success)' }}>{settingsSuccess}</span>}
        {settingsError && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{settingsError}</span>}
      </div>

      {/* About */}
      <div className="settings-section">
        <h3>Sobre</h3>
        <div className="detail-grid">
          <span className="detail-label">Versão</span><span className="mono">1.37.0</span>
          <span className="detail-label">Repositório</span><span><a href="https://github.com/hightower-systems/sentry-wms" target="_blank" rel="noopener noreferrer">github.com/hightower-systems/sentry-wms</a></span>
        </div>
      </div>

      {/* PO Modal */}
      {showPO && (
        <Modal title="Criar pedido de compra" onClose={closePoModal}
          footer={<><button className="btn" onClick={closePoModal}>Cancelar</button><button className="btn btn-primary" onClick={createPO}>Criar PC</button></>}
        >
          {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
          <div className="form-row">
            <div className="form-group">
              <label>Número do PC</label>
              <input className="form-input" value={poForm.po_number} onChange={(e) => setPoForm({ ...poForm, po_number: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Fornecedor</label>
              <input className="form-input" value={poForm.vendor_name} onChange={(e) => setPoForm({ ...poForm, vendor_name: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>Endereço do fornecedor</label>
            <input className="form-input" value={poForm.vendor_address} onChange={(e) => setPoForm({ ...poForm, vendor_address: e.target.value })} placeholder="Opcional" />
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>Linhas</label>
              <button className="btn btn-sm" onClick={addPOLine}>+ Linha</button>
            </div>
            {poForm.lines.map((line, i) => (
              <div className="form-row" key={i} style={{ marginBottom: 8 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <input className="form-input" list="settings-sku-datalist" placeholder="SKU" value={line.sku} onChange={(e) => updatePOLine(i, 'sku', e.target.value)} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <input className="form-input" type="number" placeholder="Qtd. pedida" value={line.quantity_ordered} onChange={(e) => updatePOLine(i, 'quantity_ordered', e.target.value)} />
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* SO Modal */}
      {showSO && (
        <Modal title="Criar pedido de venda" onClose={closeSoModal}
          footer={<><button className="btn" onClick={closeSoModal}>Cancelar</button><button className="btn btn-primary" onClick={createSO}>Criar PV</button></>}
        >
          {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
          <div className="form-row">
            <div className="form-group">
              <label>Número do PV</label>
              <input className="form-input" value={soForm.order_number} onChange={(e) => setSoForm({ ...soForm, order_number: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Cliente</label>
              <input className="form-input" value={soForm.customer_name} onChange={(e) => setSoForm({ ...soForm, customer_name: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>Endereço linha 1</label>
            <input className="form-input" value={soForm.address_line_1} onChange={(e) => setSoForm({ ...soForm, address_line_1: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Endereço linha 2</label>
            <input className="form-input" value={soForm.address_line_2} onChange={(e) => setSoForm({ ...soForm, address_line_2: e.target.value })} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Cidade</label>
              <input className="form-input" value={soForm.city} onChange={(e) => setSoForm({ ...soForm, city: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Estado</label>
              <input className="form-input" value={soForm.state} onChange={(e) => setSoForm({ ...soForm, state: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>CEP</label>
              <input className="form-input" value={soForm.zip} onChange={(e) => setSoForm({ ...soForm, zip: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Telefone</label>
              <input className="form-input" value={soForm.phone} onChange={(e) => setSoForm({ ...soForm, phone: e.target.value })} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>Linhas</label>
              <button className="btn btn-sm" onClick={addSOLine}>+ Linha</button>
            </div>
            {soForm.lines.map((line, i) => (
              <div className="form-row" key={i} style={{ marginBottom: 8 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <input className="form-input" list="settings-sku-datalist" placeholder="SKU" value={line.sku} onChange={(e) => updateSOLine(i, 'sku', e.target.value)} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <input className="form-input" type="number" placeholder="Quantidade" value={line.quantity_ordered} onChange={(e) => updateSOLine(i, 'quantity_ordered', e.target.value)} />
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}

    </div>
  );
}
