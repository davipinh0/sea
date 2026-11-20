-- 098_sea_terminal_retirada.sql
-- 1. Usuário do terminal (só a permissão "terminal-retirada"). Quem não tem acesso ao SEA pede só
-- com o e-mail corporativo (withdrawals.requester_email).
-- 2. Depois do aceite, só quem aceitou acompanha: as notificações apontam para a retirada e somem
-- para os demais. RETIRADA_CANCELADA avisa quem aceitou que o pedido foi cancelado.
-- 3. O peso da caixa e a unidade do cadastro passam para o material do estoque.
-- 4. SP13 recebe as mesmas prateleiras do SP12; o código de barras leva o prefixo SP13-.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS requester_email VARCHAR(254);

ALTER TABLE sea_notifications ADD COLUMN IF NOT EXISTS withdrawal_id INT;
CREATE INDEX IF NOT EXISTS ix_sea_notifications_withdrawal
    ON sea_notifications(withdrawal_id) WHERE withdrawal_id IS NOT NULL;
ALTER TABLE sea_notifications DROP CONSTRAINT IF EXISTS sea_notifications_kind_check;
ALTER TABLE sea_notifications ADD CONSTRAINT sea_notifications_kind_check
    CHECK (kind IN ('RETIRADA_SOLICITADA', 'RETIRADA_APROVADA', 'RETIRADA_CANCELADA',
                    'RECEBIMENTO', 'ARMAZENAGEM_CONCLUIDA'));

UPDATE items i
SET pack_weight_kg = m.pack_weight_kg, uom = COALESCE(m.uom, i.uom)
FROM sap_materials m
WHERE m.material_code = i.sku AND m.pack_weight_kg IS NOT NULL
  AND i.pack_weight_kg IS DISTINCT FROM m.pack_weight_kg;

INSERT INTO zones (warehouse_id, zone_code, zone_name, zone_type)
SELECT w.warehouse_id, 'PRAT', 'Prateleiras SP13', 'STORAGE'
FROM warehouses w
WHERE w.warehouse_code = 'SP13'
  AND NOT EXISTS (SELECT 1 FROM zones x WHERE x.warehouse_id = w.warehouse_id AND x.zone_code = 'PRAT');

INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type, aisle, row_num,
                  level_num, position_num, pick_sequence, putaway_sequence, capacity_units,
                  size_class, description, is_active, external_id)
SELECT z13.zone_id, w13.warehouse_id, b.bin_code, 'SP13-' || b.bin_code, b.bin_type, b.aisle,
       b.row_num, b.level_num, b.position_num, b.pick_sequence, b.putaway_sequence,
       b.capacity_units, b.size_class, b.description, b.is_active, gen_random_uuid()
FROM bins b
JOIN warehouses w12 ON w12.warehouse_id = b.warehouse_id AND w12.warehouse_code = 'SP12'
JOIN warehouses w13 ON w13.warehouse_code = 'SP13'
JOIN zones z13 ON z13.warehouse_id = w13.warehouse_id AND z13.zone_code = 'PRAT'
WHERE b.bin_type NOT IN ('Staging', 'PickableStaging')
  AND NOT EXISTS (SELECT 1 FROM bins x
                  WHERE x.warehouse_id = w13.warehouse_id AND x.bin_code = b.bin_code);
