-- SEA - dados FICTÍCIOS do protótipo. Nada aqui é real: materiais, OTs e funcionários são
-- inventados.
-- Pode rodar mais de uma vez. Requer db/migrations/082_sea.sql.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO warehouses (warehouse_code, warehouse_name, address)
VALUES ('SP12', 'Setor SP12 - Almoxarifado', 'Protótipo SEA - dados fictícios')
ON CONFLICT (warehouse_code) DO NOTHING;

INSERT INTO zones (warehouse_id, zone_code, zone_name, zone_type)
SELECT w.warehouse_id, z.code, z.name, z.type
FROM warehouses w
CROSS JOIN (VALUES ('RECEB', 'Área de recebimento', 'RECEIVING'),
                   ('PRAT', 'Prateleiras SP12', 'STORAGE')) AS z(code, name, type)
WHERE w.warehouse_code = 'SP12'
  AND NOT EXISTS (SELECT 1 FROM zones x WHERE x.warehouse_id = w.warehouse_id AND x.zone_code = z.code);

-- Área de recebimento: o material recebido espera a armazenagem aqui.
INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type, description, external_id)
SELECT z.zone_id, w.warehouse_id, 'SP12-RECEB', 'SP12-RECEB', 'Staging',
       'Área de recebimento (aguardando armazenagem)', gen_random_uuid()
FROM warehouses w JOIN zones z ON z.warehouse_id = w.warehouse_id AND z.zone_code = 'RECEB'
WHERE w.warehouse_code = 'SP12'
  AND NOT EXISTS (SELECT 1 FROM bins b WHERE b.warehouse_id = w.warehouse_id AND b.bin_code = 'SP12-RECEB');

-- Prateleiras A, B e C, níveis 0 a 3, sem limite de capacidade ou tamanho.
INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type, aisle, level_num,
                  pick_sequence, putaway_sequence, size_class, description, external_id)
SELECT z.zone_id, w.warehouse_id, s.shelf || n.lvl, s.shelf || n.lvl, 'Pickable', s.shelf, n.lvl::text,
       s.ord * 10 + n.lvl, s.ord * 10 + n.lvl,
       NULL,
       'Prateleira ' || s.shelf || ', nível ' || n.lvl, gen_random_uuid()
FROM warehouses w
JOIN zones z ON z.warehouse_id = w.warehouse_id AND z.zone_code = 'PRAT'
CROSS JOIN (VALUES ('A', 1), ('B', 2), ('C', 3)) AS s(shelf, ord)
CROSS JOIN generate_series(0, 3) AS n(lvl)
WHERE w.warehouse_code = 'SP12'
  AND NOT EXISTS (SELECT 1 FROM bins b WHERE b.warehouse_id = w.warehouse_id AND b.bin_code = s.shelf || n.lvl);

INSERT INTO items (sku, item_name, description, category, size_class, compat_group, external_id)
VALUES
  ('MAT-100101', 'Parafuso sextavado M8x30 (cx 100)', 'Fictício', 'Fixadores', 'PEQUENO', 'FIXADORES', gen_random_uuid()),
  ('MAT-100102', 'Porca sextavada M8 (cx 100)', 'Fictício', 'Fixadores', 'PEQUENO', 'FIXADORES', gen_random_uuid()),
  ('MAT-100103', 'Arruela lisa M8 (cx 200)', 'Fictício', 'Fixadores', 'PEQUENO', 'FIXADORES', gen_random_uuid()),
  ('MAT-200201', 'Rolamento 6205-2RS', 'Fictício', 'Rolamentos', 'PEQUENO', 'ROLAMENTOS', gen_random_uuid()),
  ('MAT-200202', 'Correia em V A-42', 'Fictício', 'Transmissão', NULL, 'TRANSMISSAO', gen_random_uuid()),
  ('MAT-300301', 'Filtro de óleo hidráulico', 'Fictício', 'Hidráulica', 'GRANDE', 'HIDRAULICA', gen_random_uuid()),
  ('MAT-300302', 'Mangueira hidráulica 3/8 pol. (rolo 10 m)', 'Fictício', 'Hidráulica', 'GRANDE', 'HIDRAULICA', gen_random_uuid()),
  ('MAT-400401', 'Luva nitrílica de proteção (par)', 'Fictício', 'EPI', NULL, 'EPI', gen_random_uuid()),
  ('MAT-400402', 'Óculos de segurança incolor', 'Fictício', 'EPI', NULL, 'EPI', gen_random_uuid()),
  ('MAT-500501', 'Válvula esfera 1/2 pol.', 'Fictício', 'Válvulas', NULL, NULL, gen_random_uuid())
ON CONFLICT (sku) DO NOTHING;

-- OTs fictícias PM11 e PM12; vendor_name marca a origem simulada.
INSERT INTO purchase_orders (po_number, po_barcode, vendor_name, status, expected_date,
                             warehouse_id, notes, created_by, order_type, external_id)
SELECT o.num, o.num, 'SAP (simulado)', 'OPEN', CURRENT_DATE + o.days, w.warehouse_id,
       'OT fictícia para demonstração', 'seed-sea', o.type, gen_random_uuid()
FROM warehouses w
CROSS JOIN (VALUES ('OT-7000001', 'PM11', 0), ('OT-7000002', 'PM12', 0),
                   ('OT-7000003', 'PM11', 1), ('OT-7000004', 'PM12', 2)) AS o(num, type, days)
WHERE w.warehouse_code = 'SP12'
ON CONFLICT (po_number) DO NOTHING;

INSERT INTO purchase_order_lines (po_id, item_id, quantity_ordered, line_number)
SELECT po.po_id, i.item_id, l.qty, l.line_no
FROM (VALUES ('OT-7000001', 'MAT-100101', 10, 1), ('OT-7000001', 'MAT-100102', 10, 2),
             ('OT-7000002', 'MAT-300301', 4, 1),
             ('OT-7000003', 'MAT-200201', 6, 1), ('OT-7000003', 'MAT-200202', 3, 2),
             ('OT-7000004', 'MAT-400401', 50, 1), ('OT-7000004', 'MAT-400402', 20, 2))
     AS l(ot, sku, qty, line_no)
JOIN purchase_orders po ON po.po_number = l.ot
JOIN items i ON i.sku = l.sku
WHERE NOT EXISTS (SELECT 1 FROM purchase_order_lines x
                  WHERE x.po_id = po.po_id AND x.line_number = l.line_no);

-- Usuário fictício do almoxarifado. Senha inicial "Sea@2026", com troca obrigatória.
INSERT INTO users (username, password_hash, full_name, role, warehouse_id, warehouse_ids,
                   allowed_functions, must_change_password, external_id)
SELECT 'almoxarife', crypt('Sea@2026', gen_salt('bf')), 'Almoxarife SP12 (fictício)', 'USER',
       w.warehouse_id, ARRAY[w.warehouse_id], ARRAY['receive', 'putaway']::text[], TRUE,
       gen_random_uuid()
FROM warehouses w WHERE w.warehouse_code = 'SP12'
ON CONFLICT (username) DO NOTHING;

-- Usuários do protótipo inicial que não existem mais (crachá e sessão compartilhada do terminal).
-- Sem histórico, são apagados; com histórico, ficam inativos.
DO $$
DECLARE
    u RECORD;
BEGIN
    FOR u IN SELECT user_id FROM users
             WHERE username IN ('func.joao', 'func.maria', 'func.carlos', 'terminal')
    LOOP
        BEGIN
            DELETE FROM users WHERE user_id = u.user_id;
        EXCEPTION WHEN foreign_key_violation THEN
            UPDATE users SET is_active = FALSE, badge_uid = NULL WHERE user_id = u.user_id;
        END;
    END LOOP;
END $$;
UPDATE users SET badge_uid = NULL WHERE badge_uid IS NOT NULL;

INSERT INTO user_page_permissions (user_id, page_key)
SELECT u.user_id, p.page_key
FROM users u
JOIN (VALUES ('almoxarife', 'inventory'), ('almoxarife', 'items'), ('almoxarife', 'bins'),
             ('almoxarife', 'audit-log'), ('almoxarife', 'receiving'), ('almoxarife', 'putaway'),
             ('almoxarife', 'purchase-orders'), ('almoxarife', 'retirada'))
     AS p(username, page_key)
  ON p.username = u.username
ON CONFLICT DO NOTHING;

UPDATE users SET warehouse_id = (SELECT warehouse_id FROM warehouses WHERE warehouse_code = 'SP12')
WHERE username = 'admin';

-- --- Locais: Expedição, SP12 e SP13. Requer a migração 084 (users.email).

-- O armazém padrão vira a Expedição, com um único endereço.
UPDATE warehouses SET warehouse_code = 'Expedição', warehouse_name = 'Área da Expedição'
WHERE warehouse_code = 'WH-01';

UPDATE bins SET bin_code = 'EXPEDICAO', bin_barcode = 'EXPEDICAO',
       description = 'Área da Expedição (endereço único)'
WHERE bin_code = 'RECV-01'
  AND warehouse_id = (SELECT warehouse_id FROM warehouses WHERE warehouse_code = 'Expedição');

UPDATE zones SET zone_name = 'Área da Expedição'
WHERE zone_code = 'RCV' AND zone_name = 'Receiving'
  AND warehouse_id = (SELECT warehouse_id FROM warehouses WHERE warehouse_code = 'Expedição');

-- Os outros endereços de exemplo saem da Expedição: apagados se nunca usados; inativos se já têm
-- histórico.
DO $$
DECLARE
    b RECORD;
BEGIN
    FOR b IN
        SELECT x.bin_id FROM bins x JOIN warehouses w ON w.warehouse_id = x.warehouse_id
        WHERE w.warehouse_code = 'Expedição' AND x.bin_code IN ('PICK-01', 'BULK-01')
    LOOP
        BEGIN
            DELETE FROM bins WHERE bin_id = b.bin_id;
        EXCEPTION WHEN foreign_key_violation THEN
            UPDATE bins SET is_active = FALSE WHERE bin_id = b.bin_id;
        END;
    END LOOP;
END $$;

DELETE FROM zones z
USING warehouses w
WHERE w.warehouse_id = z.warehouse_id AND w.warehouse_code = 'Expedição'
  AND z.zone_code IN ('PICK', 'STAGE')
  AND NOT EXISTS (SELECT 1 FROM bins x WHERE x.zone_id = z.zone_id);

-- SP13: área de recebimento e um endereço geral. Outros endereços em Estoque > Endereços.
INSERT INTO warehouses (warehouse_code, warehouse_name, address)
VALUES ('SP13', 'Setor SP13 - Almoxarifado', 'Protótipo SEA - dados fictícios')
ON CONFLICT (warehouse_code) DO NOTHING;

INSERT INTO zones (warehouse_id, zone_code, zone_name, zone_type)
SELECT w.warehouse_id, z.code, z.name, z.type
FROM warehouses w
CROSS JOIN (VALUES ('RECEB', 'Área de recebimento', 'RECEIVING'),
                   ('CONT', 'Almoxarifado SP13', 'STORAGE')) AS z(code, name, type)
WHERE w.warehouse_code = 'SP13'
  AND NOT EXISTS (SELECT 1 FROM zones x WHERE x.warehouse_id = w.warehouse_id AND x.zone_code = z.code);

INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type, description, external_id)
SELECT z.zone_id, w.warehouse_id, b.code, b.code, b.type, b.description, gen_random_uuid()
FROM warehouses w
JOIN (VALUES ('RECEB', 'SP13-RECEB', 'Staging', 'Área de recebimento (aguardando armazenagem)'),
             ('CONT', 'SP13', 'Pickable', 'Almoxarifado SP13 (endereço geral)'))
     AS b(zone, code, type, description) ON TRUE
JOIN zones z ON z.warehouse_id = w.warehouse_id AND z.zone_code = b.zone
WHERE w.warehouse_code = 'SP13'
  AND NOT EXISTS (SELECT 1 FROM bins x WHERE x.warehouse_id = w.warehouse_id AND x.bin_code = b.code);

-- Usuário de teste do terminal: entra com "retirada" ou com o e-mail fictício abaixo. Senha
-- "Sea@2026", sem troca obrigatória (o terminal não tem tela de troca de senha).
INSERT INTO users (username, password_hash, full_name, role, warehouse_id, warehouse_ids,
                   allowed_functions, must_change_password, email, external_id)
SELECT 'retirada', crypt('Sea@2026', gen_salt('bf')), 'Usuário de Retirada (teste)', 'USER',
       w.warehouse_id, ARRAY[w.warehouse_id], ARRAY[]::text[], FALSE,
       'retirada@sea.example', gen_random_uuid()
FROM warehouses w WHERE w.warehouse_code = 'SP12'
ON CONFLICT (username) DO NOTHING;

INSERT INTO user_page_permissions (user_id, page_key)
SELECT user_id, 'retirada' FROM users WHERE username = 'retirada'
ON CONFLICT DO NOTHING;

UPDATE users u
SET warehouse_ids = ARRAY(
        SELECT w.warehouse_id FROM warehouses w
        WHERE w.warehouse_code IN ('SP12', 'Expedição', 'SP13')
        ORDER BY (w.warehouse_code = 'SP12') DESC, w.warehouse_id)
WHERE u.username IN ('almoxarife', 'retirada');

-- Base do SAP fictícia. No recebimento, os códigos 1000000101 e 1000000102 trazem materiais,
-- ordens, quantidades e solicitante.
INSERT INTO sap_orders (order_number, order_type, description) VALUES
    ('2000000011', 'PM11', 'Manutenção preventiva (fictício)'),
    ('2000000012', 'PM12', 'Manutenção corretiva (fictício)'),
    ('2000000013', 'PM12', 'Reparo de solda (fictício)')
ON CONFLICT (order_number) DO NOTHING;

INSERT INTO sap_materials (material_code, description, uom) VALUES
    ('70000001', 'Arame de solda (fictício)', 'KG'),
    ('70000002', 'Luva de proteção (fictício)', 'PAR'),
    ('70000003', 'Rolamento de esferas (fictício)', 'PC'),
    ('70000004', 'Disco de corte (fictício)', 'PC')
ON CONFLICT (material_code) DO NOTHING;

INSERT INTO sap_reservations (ot_number, reservation_number, requester_name, needed_date) VALUES
    ('1000000101', '0280000101', 'Solicitante Fictício A', DATE '2026-12-01'),
    ('1000000102', '0280000102', 'Solicitante Fictício B', DATE '2026-12-05')
ON CONFLICT (ot_number) DO NOTHING;

INSERT INTO sap_reservation_items (ot_number, order_number, material_code, quantity, uom) VALUES
    ('1000000101', '2000000011', '70000001', 54, 'KG'),
    ('1000000101', '2000000012', '70000002', 10, 'PAR'),
    ('1000000101', '2000000012', '70000003', 4, 'PC'),
    ('1000000102', '2000000013', '70000004', 20, 'PC')
ON CONFLICT (ot_number, material_code) DO NOTHING;
