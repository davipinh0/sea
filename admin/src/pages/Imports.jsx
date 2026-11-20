import { useState, useRef } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';

// Every template must include every field the corresponding import
// endpoint treats as required OR meaningfully useful. Issue #91: the
// prior templates were missing warehouse_id on PO/SO (always required
// by the import helper) and several column-scope fields on Bins/Items.
// Operators who downloaded a template, filled it, and imported without
// editing the column list got row-level "Missing required field"
// errors. Keeping the templates in lockstep with the pydantic schemas
// in api/schemas/csv_import.py is the only way to close that loop.
// Exported for alignment tests in admin/src/test/imports.test.jsx.
export const CSV_TEMPLATES = {
  items: `sku,name,description,category,upc,default_bin,weight,quantity,size_class,compat_group
MAT-600601,Parafuso allen M6x20 (cx 100),Fictício,Fixadores,,,,,PEQUENO,FIXADORES
MAT-600602,Correia em V A-50,Fictício,Transmissão,,,,,,TRANSMISSAO
MAT-600603,Filtro de ar industrial,Fictício,Filtros,,,,,GRANDE,FILTROS`,
  'purchase-orders': `po_number,order_type,warehouse_id,vendor,sku,quantity,expected_date
OT-7100001,PM11,1,SAP (simulado),MAT-600601,20,2026-12-01
OT-7100001,PM11,1,SAP (simulado),MAT-600602,5,2026-12-01
OT-7100002,PM12,1,SAP (simulado),MAT-600603,2,2026-12-05`,
  bins: `bin_code,bin_barcode,zone,warehouse_id,aisle,level_num,bin_type,pick_sequence,putaway_sequence,capacity_units,size_class,description
D0,D0,PRAT,1,D,0,Pickable,40,40,,,Prateleira D nível 0
D1,D1,PRAT,1,D,1,Pickable,41,41,,,Prateleira D nível 1
D3,D3,PRAT,1,D,3,Pickable,43,43,,PEQUENO,Prateleira D nível 3 (peças pequenas)`,
  'sap-ordens': `order_number,order_type,description
2005113840,PM12,Manutenção corretiva (fictício)
2005113841,PM11,Manutenção preventiva (fictício)`,
  'sap-materiais': `material_code,description,uom
74165325,Arame de solda (fictício),KG
74165326,Luva de proteção (fictício),PAR`,
  'sap-reservas': `ot_number,reservation_number,requester_name,needed_date,order_number,material_code,quantity,uom,lot_number
1003329915,0285365145,Solicitante Fictício,2026-12-01,2005113840,74165325,54,KG,L2026-0457
1003329915,0285365145,Solicitante Fictício,2026-12-01,2005113841,74165326,10,PAR,L2026-0458`,
};

const SAP_IMPORTS = { 'sap-ordens': 'ordens', 'sap-materiais': 'materiais', 'sap-reservas': 'reservas' };

function downloadTemplate(type) {
  const csv = CSV_TEMPLATES[type];
  if (!csv) return;
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `import-${type}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const IMPORT_TYPES = [
  { value: 'items', label: 'Materiais', desc: 'Código, descrição, categoria, classe de tamanho (PEQUENO/GRANDE) e grupo de compatibilidade.' },
  { value: 'bins', label: 'Endereços', desc: 'Endereços do SP12 com zona, prateleira, nível, capacidade (opcional) e classe de tamanho.' },
  { value: 'sap-ordens', label: 'Base SAP: ordens', desc: 'Ordens do SAP: número e tipo (PM11 ou PM12). Uma ordem já existente é atualizada.' },
  { value: 'sap-materiais', label: 'Base SAP: materiais', desc: 'Materiais do SAP: código, descrição e unidade (PC, KG, PAR). Um material já existente é atualizado.' },
  { value: 'sap-reservas', label: 'Base SAP: OTs / reservas', desc: 'OTs / reservas abertas no SAP. Uma linha por material, com a ordem a que pertence, a quantidade, a unidade e o lote; linhas com o mesmo ot_number formam uma OT. As ordens e os materiais precisam estar na base antes.' },
  { value: 'purchase-orders', label: 'Ordens', desc: 'Ordens PM11/PM12 com seus materiais e quantidades previstas. Uma linha por material; linhas com o mesmo número formam uma ordem. warehouse_id é o número do local (veja em Sistema > Configurações).' },
];

export default function Imports() {
  const [importType, setImportType] = useState('items');
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  async function handleImport() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setImportResult(null);
    setImporting(true);

    try {
      const text = await file.text();
      let rows;

      if (file.name.endsWith('.json')) {
        rows = JSON.parse(text);
      } else {
        const lines = text.trim().split('\n');
        const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
        rows = lines.slice(1).map((line) => {
          const vals = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
          const obj = {};
          headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
          return obj;
        });
      }

      const url = SAP_IMPORTS[importType] ? `/sea/sap/importar/${SAP_IMPORTS[importType]}` : `/admin/import/${importType}`;
      const res = await api.post(url, { records: rows });
      if (res?.ok) {
        const data = await res.json();
        setImportResult(data);
      } else {
        const data = await res?.json();
        setImportResult({ error: data?.error || 'Falha na importação' });
      }
    } catch (err) {
      setImportResult({ error: 'Falha ao ler o arquivo' });
    }
    setImporting(false);
    fileRef.current.value = '';
  }

  return (
    <div>
      <PageHeader title="Importação" />

      <div className="settings-section">
        <h3>Importar dados</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {IMPORT_TYPES.map((t) => (
            <button
              key={t.value}
              className={`btn ${importType === t.value ? 'btn-primary' : ''}`}
              onClick={() => { setImportType(t.value); setImportResult(null); }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="settings-note">{IMPORT_TYPES.find((t) => t.value === importType)?.desc}</p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <input ref={fileRef} type="file" accept=".csv,.json" style={{ fontSize: 13 }} />
          <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
            {importing ? 'Importando...' : 'Importação'}
          </button>
          <button className="btn btn-sm" onClick={() => downloadTemplate(importType)} style={{ fontSize: 12 }}>
            Baixar modelo
          </button>
        </div>
      </div>

      {importResult && (
        <div className="settings-section">
          <h3>Resultados</h3>
          <div className="import-results">
            {importResult.error ? (
              <div className="errors">{importResult.error}</div>
            ) : (
              <>
                <div className="success">Importados: {importResult.imported ?? 0}</div>
                {importResult.errors?.length > 0 && (
                  <div className="errors" style={{ marginTop: 4 }}>
                    Erros: {importResult.errors.length}
                    <ul style={{ margin: '4px 0 0 16px', fontSize: 12 }}>
                      {importResult.errors.slice(0, 20).map((err, i) => (
                        <li key={i}>Linha {err.row}: {err.error}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
