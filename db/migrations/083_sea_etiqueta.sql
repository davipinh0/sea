-- ============================================================
-- 083_sea_etiqueta.sql - SEA: dados da etiqueta de recebimento
-- ============================================================
-- Stores the data printed on the label that travels with each material
-- (OT, reserva, material, lote, solicitante, recebedor, ordem de serviço).
--
-- Mapping onto the existing Sentry tables (no parallel model):
--   * Recebimento / OT  = purchase_orders
--       codigo_ot            -> po_number          (existing)
--       codigo_barras        -> po_barcode         (existing)
--       empresa_origem       -> vendor_name        (existing)
--       data_necessaria      -> expected_date      (existing)
--       tipo_ordem_servico   -> order_type         (mig 082, PM11 / PM12)
--       numero_ordem_servico -> service_order_number
--       the remaining label fields are the columns added below.
--   * Material recebido = purchase_order_lines (one row per material of
--     the OT) + items (the material master, shared between OTs).
--     The supplier lot lives on the OT line, separate from the material
--     code. inventory.lot_number keeps carrying the OT number (mig 082),
--     which is what ties stock, address and withdrawals back to the OT.
--
-- Every new column is nullable: a field that was not identified on the
-- label stays NULL = "pendente de preenchimento", never guessed.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS reservation_number   VARCHAR(40),
    ADD COLUMN IF NOT EXISTS label_date           DATE,
    ADD COLUMN IF NOT EXISTS department           VARCHAR(60),
    ADD COLUMN IF NOT EXISTS pickup_location      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS unload_location      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS requester_name       VARCHAR(120),
    ADD COLUMN IF NOT EXISTS receiver_name        VARCHAR(120),
    ADD COLUMN IF NOT EXISTS service_order_number VARCHAR(40),
    -- Where the OT data came from: typed in, read from a label, or (future)
    -- fetched from the corporate system.
    ADD COLUMN IF NOT EXISTS data_source          VARCHAR(20)
        CHECK (data_source IS NULL OR data_source IN ('MANUAL', 'ETIQUETA', 'INTEGRACAO')),
    -- Label content that was not recognized, or that disagreed with what
    -- was already registered: kept for the operator to review, never
    -- discarded and never written over existing data.
    ADD COLUMN IF NOT EXISTS review_notes         TEXT;

CREATE INDEX IF NOT EXISTS ix_purchase_orders_reservation
    ON purchase_orders(reservation_number) WHERE reservation_number IS NOT NULL;

ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS lot_number  VARCHAR(50),
    ADD COLUMN IF NOT EXISTS expiry_date DATE,
    ADD COLUMN IF NOT EXISTS uom         VARCHAR(10),
    ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT NOW();

-- Unit of measure of the material master (KG, UN, M ...).
ALTER TABLE items ADD COLUMN IF NOT EXISTS uom VARCHAR(10);
