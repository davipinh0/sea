-- ============================================================
-- 085_sea_base_sap.sql - SEA: base de dados vinda do SAP
-- ============================================================
-- Espelho, dentro do SEA, dos três conjuntos de dados que vêm do SAP:
--   * sap_orders             ordens (PM11 / PM12)
--   * sap_materials          materiais
--   * sap_reservations       OTs / reservas abertas (cabeçalho)
--   * sap_reservation_items  materiais de cada OT: de qual ordem,
--                            quantidade e unidade
--
-- O recebimento lê o código de barras da OT e procura nesta base
-- (services/sap_base.py). O que é encontrado passa pelo mesmo cadastro
-- de uma etiqueta (purchase_orders / purchase_order_lines / items), de
-- modo que recebimento, armazenagem e retirada não mudam.
--
-- A base é só espelho: o SEA nunca escreve nela a partir da operação.
-- Ela é carregada por importação (Sistema > Importação) e, no futuro,
-- pela integração com o SAP.
--
-- Uma OT traz materiais de várias ordens, então a ordem passa a ser
-- guardada também em cada material da OT (purchase_order_lines).
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS sap_orders (
    order_number VARCHAR(40) PRIMARY KEY,
    order_type   VARCHAR(4) NOT NULL CHECK (order_type IN ('PM11', 'PM12')),
    description  VARCHAR(200),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sap_materials (
    material_code VARCHAR(50) PRIMARY KEY,
    description   VARCHAR(200) NOT NULL,
    uom           VARCHAR(10),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sap_reservations (
    ot_number          VARCHAR(50) PRIMARY KEY,
    reservation_number VARCHAR(40),
    requester_name     VARCHAR(120),
    needed_date        DATE,
    department         VARCHAR(60),
    pickup_location    VARCHAR(120),
    unload_location    VARCHAR(120),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sap_reservation_items (
    reservation_item_id SERIAL PRIMARY KEY,
    ot_number     VARCHAR(50) NOT NULL REFERENCES sap_reservations(ot_number) ON DELETE CASCADE,
    order_number  VARCHAR(40) NOT NULL REFERENCES sap_orders(order_number),
    material_code VARCHAR(50) NOT NULL REFERENCES sap_materials(material_code),
    quantity      INT NOT NULL CHECK (quantity > 0),
    uom           VARCHAR(10),
    -- O SEA mantém um registro por material em cada OT.
    UNIQUE (ot_number, material_code)
);
CREATE INDEX IF NOT EXISTS ix_sap_reservation_items_order
    ON sap_reservation_items(order_number);

ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS service_order_number VARCHAR(40),
    ADD COLUMN IF NOT EXISTS service_order_type   VARCHAR(4)
        CHECK (service_order_type IS NULL OR service_order_type IN ('PM11', 'PM12'));
