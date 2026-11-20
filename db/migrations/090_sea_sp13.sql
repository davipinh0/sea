-- 090_sea_sp13.sql - o Contêiner de Solda vira o SP13, com os seus endereços. Os ids não mudam,
-- então estoque, histórico e permissões continuam apontando certo.
-- Pode rodar mais de uma vez. Só dados.

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
