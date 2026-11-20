-- 097_sea_lote_material.sql - a planilha de OTs da base do SAP traz o lote de cada material (coluna
-- lot_number ou "lote"), que segue para o material da ordem ao registrar a entrega.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE sap_reservation_items ADD COLUMN IF NOT EXISTS lot_number VARCHAR(50);
