-- ============================================================
-- 090_sea_sp13.sql - SEA: o Contêiner de Solda passa a ser o SP13
-- ============================================================
-- O local "Solda - Contêiner de Solda" é renomeado para
-- "SP13 - Setor SP13 - Almoxarifado", com os seus endereços
-- (SOLDA-RECEB -> SP13-RECEB, SOLDA -> SP13). Estoque, histórico e
-- permissões apontam para os ids, que não mudam.
--
-- Idempotent: safe to run more than once. Só dados (db/seed-sea.sql já
-- cria o local com os nomes novos).
-- ============================================================

UPDATE warehouses SET warehouse_code = 'SP13', warehouse_name = 'Setor SP13 - Almoxarifado'
WHERE warehouse_code = 'Solda'
  AND NOT EXISTS (SELECT 1 FROM warehouses WHERE warehouse_code = 'SP13');

UPDATE zones z SET zone_name = 'Almoxarifado SP13'
FROM warehouses w
WHERE w.warehouse_id = z.warehouse_id AND w.warehouse_code = 'SP13'
  AND z.zone_code = 'CONT' AND z.zone_name = 'Contêiner de Solda';

UPDATE bins b SET bin_code = 'SP13-RECEB', bin_barcode = 'SP13-RECEB'
FROM warehouses w
WHERE w.warehouse_id = b.warehouse_id AND w.warehouse_code = 'SP13'
  AND b.bin_code = 'SOLDA-RECEB';

UPDATE bins b SET bin_code = 'SP13', bin_barcode = 'SP13',
       description = 'Almoxarifado SP13 (endereço geral)'
FROM warehouses w
WHERE w.warehouse_id = b.warehouse_id AND w.warehouse_code = 'SP13'
  AND b.bin_code = 'SOLDA';
