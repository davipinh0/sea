-- 082_sea.sql - base do SEA
-- - OT = purchase_orders com order_type PM11 ou PM12. O estoque recebido leva o número da OT como
-- lote (inventory.lot_number), o que liga cada unidade à sua OT.
-- - Regras de armazenagem por endereço (capacidade, classe de tamanho, compatibilidade). NULL = sem
-- regra; nenhum limite é inventado.
-- - Crachá do funcionário (não é mais usado).
-- - Retiradas pedidas no terminal: a quantidade fica reservada e só sai do estoque quando o
-- funcionário confirma.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

-- Tipo da OT (PM11/PM12). NULL para pedidos que não são do SEA.
ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS order_type VARCHAR(4)
    CHECK (order_type IS NULL OR order_type IN ('PM11', 'PM12'));
CREATE INDEX IF NOT EXISTS ix_purchase_orders_order_type
    ON purchase_orders(order_type) WHERE order_type IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_uid VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_badge_uid
    ON users(badge_uid) WHERE badge_uid IS NOT NULL;

-- Regras de armazenagem. NULL = sem regra.
ALTER TABLE bins
    ADD COLUMN IF NOT EXISTS capacity_units INT
    CHECK (capacity_units IS NULL OR capacity_units > 0);
ALTER TABLE bins
    ADD COLUMN IF NOT EXISTS size_class VARCHAR(20)
    CHECK (size_class IS NULL OR size_class IN ('PEQUENO', 'GRANDE'));
ALTER TABLE items
    ADD COLUMN IF NOT EXISTS size_class VARCHAR(20)
    CHECK (size_class IS NULL OR size_class IN ('PEQUENO', 'GRANDE'));
-- Materiais do mesmo compat_group podem dividir um endereço. NULL = só com o mesmo material.
ALTER TABLE items ADD COLUMN IF NOT EXISTS compat_group VARCHAR(50);

CREATE TABLE IF NOT EXISTS withdrawals (
    withdrawal_id        SERIAL PRIMARY KEY,
    warehouse_id         INT NOT NULL REFERENCES warehouses(warehouse_id),
    po_id                INT NOT NULL REFERENCES purchase_orders(po_id),
    status               VARCHAR(20) NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN ('REQUESTED', 'PICKING', 'READY', 'DELIVERED', 'CANCELLED')),
    requested_by         VARCHAR(100) NOT NULL,
    requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requester_note       VARCHAR(500),
    picked_by            VARCHAR(100),
    picking_started_at   TIMESTAMPTZ,
    ready_at             TIMESTAMPTZ,
    delivered_to_user_id INT REFERENCES users(user_id),
    delivered_badge_uid  VARCHAR(64),
    delivered_at         TIMESTAMPTZ,
    confirmed_by         VARCHAR(100),
    cancelled_by         VARCHAR(100),
    cancelled_at         TIMESTAMPTZ,
    cancel_reason        VARCHAR(500)
);
CREATE INDEX IF NOT EXISTS ix_withdrawals_wh_status ON withdrawals(warehouse_id, status);
CREATE INDEX IF NOT EXISTS ix_withdrawals_po ON withdrawals(po_id);

CREATE TABLE IF NOT EXISTS withdrawal_lines (
    withdrawal_line_id SERIAL PRIMARY KEY,
    withdrawal_id      INT NOT NULL REFERENCES withdrawals(withdrawal_id) ON DELETE CASCADE,
    inventory_id       INT NOT NULL REFERENCES inventory(inventory_id),
    item_id            INT NOT NULL REFERENCES items(item_id),
    bin_id             INT NOT NULL REFERENCES bins(bin_id),
    lot_number         VARCHAR(50),
    quantity           INT NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS ix_withdrawal_lines_withdrawal ON withdrawal_lines(withdrawal_id);
