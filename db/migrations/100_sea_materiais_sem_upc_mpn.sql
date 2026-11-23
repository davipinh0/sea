-- 100_sea_materiais_sem_upc_mpn.sql - materiais sem UPC e MPN
-- O SEA não usa esses dados: o material é identificado pelo código (sku) e os códigos alternativos
-- lidos no scanner ficam em barcode_aliases. A leitura que procurava pelo UPC passa a procurar pelo
-- código. Nenhum material tinha UPC ou MPN preenchido quando a coluna saiu.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

DROP INDEX IF EXISTS ix_items_upc;
DROP INDEX IF EXISTS ix_items_mpn;
ALTER TABLE items DROP COLUMN IF EXISTS upc, DROP COLUMN IF EXISTS mpn;
