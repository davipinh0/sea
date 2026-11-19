-- ============================================================
-- 097_sea_lote_material.sql - SEA: lote de cada material da OT na
-- base do SAP
-- ============================================================
-- A planilha de OTs / reservas da base do SAP passa a trazer o lote de
-- cada material (coluna lot_number ou "lote"). Ao registrar a entrega da
-- OT pela base, o lote segue para o material da ordem
-- (purchase_order_lines.lot_number), como já acontecia no cadastro pela
-- etiqueta.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE sap_reservation_items ADD COLUMN IF NOT EXISTS lot_number VARCHAR(50);
