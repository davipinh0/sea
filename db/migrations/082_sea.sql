-- ============================================================
-- 082_sea.sql - SEA (Sistema de Expedição e Armazenamento)
-- ============================================================
-- Adapts the SEA schema for the SEA prototype:
--   * Ordem de Transferência (OT) = purchase_orders row with an
--     order_type of PM11 or PM12. Received stock carries the OT number
--     as inventory.lot_number, which links every unit back to its OT.
--   * SP12 storage rules: configurable bin capacity, size class
--     (e.g. A3 for small parts) and material compatibility groups.
--     All new limits default to NULL = "not configured / no limit";
--     the prototype never invents numeric capacities.
--   * Employee badge (RFID/NFC HID, simulated) on users.
--   * Withdrawals (retiradas) requested at the touchscreen terminal.
--     Requested quantities are reserved in inventory.quantity_allocated
--     and only leave quantity_on_hand when the employee confirms the
--     handover with their badge.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

-- OT type (PM11 / PM12). NULL for non-SEA purchase orders.
ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS order_type VARCHAR(4)
    CHECK (order_type IS NULL OR order_type IN ('PM11', 'PM12'));
CREATE INDEX IF NOT EXISTS ix_purchase_orders_order_type
    ON purchase_orders(order_type) WHERE order_type IS NOT NULL;

-- Employee badge identifier (simulated RFID/NFC HID reader).
ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_uid VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_badge_uid
    ON users(badge_uid) WHERE badge_uid IS NOT NULL;

-- SP12 storage rules. NULL = not configured (no limit / any class).
ALTER TABLE bins
    ADD COLUMN IF NOT EXISTS capacity_units INT
    CHECK (capacity_units IS NULL OR capacity_units > 0);
ALTER TABLE bins
    ADD COLUMN IF NOT EXISTS size_class VARCHAR(20)
    CHECK (size_class IS NULL OR size_class IN ('PEQUENO', 'GRANDE'));
ALTER TABLE items
    ADD COLUMN IF NOT EXISTS size_class VARCHAR(20)
    CHECK (size_class IS NULL OR size_class IN ('PEQUENO', 'GRANDE'));
-- Materials sharing the same compat_group may share an address.
-- NULL = only shares an address with the same material.
ALTER TABLE items ADD COLUMN IF NOT EXISTS compat_group VARCHAR(50);

-- Withdrawals (retiradas) requested at the terminal.
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
