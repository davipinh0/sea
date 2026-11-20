-- 085_sea_base_sap.sql - base de dados vinda do SAP
-- Cópia, dentro do SEA, de ordens (PM11/PM12), materiais e OTs/reservas abertas. O recebimento
-- procura a OT aqui e registra pelo mesmo caminho da etiqueta. A operação nunca escreve na base:
-- ela é carregada por importação e, no futuro, pela integração com o SAP.
-- Como uma OT traz materiais de várias ordens, a ordem também fica em cada material da OT.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

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
    UNIQUE (ot_number, material_code)
);
CREATE INDEX IF NOT EXISTS ix_sap_reservation_items_order
    ON sap_reservation_items(order_number);

ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS service_order_number VARCHAR(40),
    ADD COLUMN IF NOT EXISTS service_order_type   VARCHAR(4)
        CHECK (service_order_type IS NULL OR service_order_type IN ('PM11', 'PM12'));
