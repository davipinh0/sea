-- 083_sea_etiqueta.sql - dados da etiqueta de recebimento
-- Os dados da etiqueta (OT, reserva, material, lote, solicitante, recebedor, ordem de serviço)
-- entram nas tabelas que já existem: a OT em purchase_orders e cada material em
-- purchase_order_lines + items. O lote do fornecedor fica na linha da OT, separado do código do
-- material; inventory.lot_number continua com o número da OT.
-- Toda coluna nova aceita NULL: campo não identificado fica pendente, nunca adivinhado.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS reservation_number   VARCHAR(40),
    ADD COLUMN IF NOT EXISTS label_date           DATE,
    ADD COLUMN IF NOT EXISTS department           VARCHAR(60),
    ADD COLUMN IF NOT EXISTS pickup_location      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS unload_location      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS requester_name       VARCHAR(120),
    ADD COLUMN IF NOT EXISTS receiver_name        VARCHAR(120),
    ADD COLUMN IF NOT EXISTS service_order_number VARCHAR(40),
    -- Origem dos dados da OT: digitados, lidos da etiqueta ou (no futuro) vindos do sistema
    -- corporativo.
    ADD COLUMN IF NOT EXISTS data_source          VARCHAR(20)
        CHECK (data_source IS NULL OR data_source IN ('MANUAL', 'ETIQUETA', 'INTEGRACAO')),
    -- Texto da etiqueta não reconhecido ou que divergia do cadastrado: fica para revisão, nunca é
    -- descartado nem sobrescreve dados.
    ADD COLUMN IF NOT EXISTS review_notes         TEXT;

CREATE INDEX IF NOT EXISTS ix_purchase_orders_reservation
    ON purchase_orders(reservation_number) WHERE reservation_number IS NOT NULL;

ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS lot_number  VARCHAR(50),
    ADD COLUMN IF NOT EXISTS expiry_date DATE,
    ADD COLUMN IF NOT EXISTS uom         VARCHAR(10),
    ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE items ADD COLUMN IF NOT EXISTS uom VARCHAR(10);
