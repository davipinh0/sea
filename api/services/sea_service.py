"""SEA business rules on top of the SEA core.

Two concerns live here, both scoped to SEA Ordens de Transferência (OT):
a purchase_orders row with order_type PM11/PM12 whose received stock
carries the OT number as inventory.lot_number.

1. SP12 storage rules (put-away):
   * an OT may be spread freely over any number of storage addresses;
   * an address may hold several materials only when they are
     compatible (same item, or same non-null items.compat_group);
   * bins.size_class restricts an address to one material size class
     (e.g. A3 = PEQUENO for screws); NULL = any;
   * bins.capacity_units caps the units stored in an address;
     NULL = not configured (no limit). No numeric capacity is invented.

2. Withdrawals (retiradas) at the touchscreen terminal:
   REQUESTED -> PICKING -> READY -> DELIVERED, or CANCELLED.
   Requesting reserves stock in inventory.quantity_allocated; delivery
   (confirmed by the employee who requested it, identified by their
   login) removes it from quantity_on_hand. Nothing is ever deleted:
   cancelled and undelivered requests stay in ``withdrawals``. Every transition runs under row locks and checks
   the expected current status, so a double click, a retry or two
   terminals racing can never decrement stock twice or below zero.

An order's stock is found by its lot (the OT number, unique across the
system) wherever it is: an order received in one location (Expedição)
may be stored in another (SP12, Contêiner de Solda). The order keeps the
location where it was received; each stock row and each withdrawal
carries the location where the material physically is.

Functions raise SeaError; routes translate it to an HTTP response.
Callers own the transaction (g.db.commit()).
"""

import uuid

from constants import BIN_PICKABLE_STAGING, BIN_STAGING
from sqlalchemy import bindparam, text

from services import notification_service as notifications
from services.audit_service import write_audit_log

OT_TYPES = ("PM11", "PM12")
STAGING_TYPES = (BIN_STAGING, BIN_PICKABLE_STAGING)

W_REQUESTED = "REQUESTED"
W_PICKING = "PICKING"
W_READY = "READY"
W_DELIVERED = "DELIVERED"
W_CANCELLED = "CANCELLED"
W_OPEN_STATUSES = (W_REQUESTED, W_PICKING, W_READY)

ACTION_WITHDRAWAL_REQUESTED = "WITHDRAWAL_REQUESTED"
ACTION_WITHDRAWAL_PICKING = "WITHDRAWAL_PICKING"
ACTION_WITHDRAWAL_READY = "WITHDRAWAL_READY"
ACTION_WITHDRAWAL_DELIVERED = "WITHDRAWAL_DELIVERED"
ACTION_WITHDRAWAL_CANCELLED = "WITHDRAWAL_CANCELLED"


class SeaError(Exception):
    """Business-rule violation. ``status`` is the HTTP status to return."""

    def __init__(self, message, status=409, **context):
        super().__init__(message)
        self.status = status
        self.context = context


# ---------------------------------------------------------------- OTs

def find_ot(db, code, scope_clause="", scope_params=None):
    """Return the OT row matching an OT number or barcode, or None."""
    return db.execute(
        text(
            f"""
            SELECT po_id, po_number, po_barcode, order_type, status, warehouse_id,
                   vendor_name, expected_date, created_at, received_at, created_by,
                   reservation_number, label_date, department, pickup_location,
                   unload_location, requester_name, receiver_name,
                   service_order_number, data_source, review_notes
            FROM purchase_orders
            WHERE (po_number = :code OR po_barcode = :code)
              AND order_type IS NOT NULL
              {scope_clause}
            ORDER BY po_id
            LIMIT 1
            """
        ),
        {"code": code, **(scope_params or {})},
    ).fetchone()


def ot_for_lot(db, lot_number):
    """Return the OT whose number is ``lot_number``, or None. The lot
    identifies the order in any location (po_number is unique)."""
    if not lot_number:
        return None
    return db.execute(
        text(
            """
            SELECT po_id, po_number, order_type, service_order_number, warehouse_id
            FROM purchase_orders
            WHERE po_number = :lot AND order_type IS NOT NULL
            """
        ),
        {"lot": lot_number},
    ).fetchone()


def ot_stock(db, ot):
    """Stock rows of an OT (lot = OT number) in every location, with
    availability per address."""
    rows = db.execute(
        text(
            """
            SELECT inv.inventory_id, inv.item_id, i.sku, i.item_name,
                   inv.bin_id, b.bin_code, b.bin_type, inv.warehouse_id, w.warehouse_code,
                   inv.quantity_on_hand, inv.quantity_allocated,
                   GREATEST(0, inv.quantity_on_hand - inv.quantity_allocated) AS available
            FROM inventory inv
            JOIN items i ON i.item_id = inv.item_id
            JOIN bins b ON b.bin_id = inv.bin_id
            JOIN warehouses w ON w.warehouse_id = inv.warehouse_id
            WHERE inv.lot_number = :lot AND inv.quantity_on_hand > 0
            ORDER BY b.bin_code, i.sku
            """
        ),
        {"lot": ot.po_number},
    ).fetchall()
    return [
        {
            "inventory_id": r.inventory_id,
            "item_id": r.item_id,
            "sku": r.sku,
            "item_name": r.item_name,
            "bin_id": r.bin_id,
            "bin_code": r.bin_code,
            "warehouse_id": r.warehouse_id,
            "warehouse_code": r.warehouse_code,
            "stored": r.bin_type not in STAGING_TYPES,
            "quantity_on_hand": r.quantity_on_hand,
            "quantity_allocated": r.quantity_allocated,
            "available": int(r.available),
        }
        for r in rows
    ]


# ------------------------------------------- Label receiving (etiqueta)
#
# The label that travels with a material is registered onto the existing
# SEA tables: the OT is a purchase_orders row, each material of the OT
# is a purchase_order_lines row pointing at the material master (items).
# The same function serves data typed by the operator, read from a label
# and, later, returned by services.ot_source.

ACTION_OT_REGISTERED = "OT_REGISTERED"
ACTION_OT_MATERIAL_ADDED = "OT_MATERIAL_ADDED"
ACTION_OT_DATA_EDITED = "OT_DATA_EDITED"
ACTION_OT_MATERIAL_EDITED = "OT_MATERIAL_EDITED"
ACTION_OT_MATERIAL_REMOVED = "OT_MATERIAL_REMOVED"

PO_LOCKED_STATUSES = ("CLOSED", "ARCHIVED")

# Request field -> purchase_orders column. Column names only ever come
# from this constant, never from the request.
OT_HEADER_COLUMNS = {
    "origin_company": "vendor_name",
    "label_date": "label_date",
    "reservation_number": "reservation_number",
    "needed_date": "expected_date",
    "department": "department",
    "pickup_location": "pickup_location",
    "unload_location": "unload_location",
    "requester_name": "requester_name",
    "receiver_name": "receiver_name",
    "service_order_type": "order_type",
    "service_order_number": "service_order_number",
}
OT_FIELD_LABELS = {
    "origin_company": "empresa de origem",
    "label_date": "data da etiqueta",
    "reservation_number": "reserva",
    "needed_date": "data necessária",
    "department": "departamento",
    "pickup_location": "local de retirada",
    "unload_location": "local de descarga",
    "requester_name": "solicitante",
    "receiver_name": "recebedor",
    "service_order_type": "tipo da ordem de serviço",
    "service_order_number": "número da ordem de serviço",
    "description": "descrição",
}
OT_MATERIAL_COLUMNS = {
    "quantity": "quantity_ordered",
    "uom": "uom",
    "lot_number": "lot_number",
    "expiry_date": "expiry_date",
}

_LOCK_NS_OT = 8203


def _text(value):
    return None if value is None else str(value)


def _same(a, b):
    return " ".join(str(a).split()).casefold() == " ".join(str(b).split()).casefold()


def _lock_ot_row(db, po_id, scope_clause="", scope_params=None):
    """Lock an OT for a correction; refuses plain POs and closed OTs."""
    columns = ", ".join(sorted(set(OT_HEADER_COLUMNS.values())))
    po = db.execute(
        text(
            f"""
            SELECT po_id, po_number, po_barcode, status, warehouse_id, {columns}
            FROM purchase_orders
            WHERE po_id = :id AND order_type IS NOT NULL {scope_clause}
            FOR UPDATE
            """
        ),
        {"id": po_id, **(scope_params or {})},
    ).fetchone()
    if po is None:
        raise SeaError("OT não encontrada", status=404)
    if po.status in PO_LOCKED_STATUSES:
        raise SeaError(f"A OT {po.po_number} está fechada e não pode ser alterada.", status=409)
    return po


def material_conflict(db, po_id, material_code, lot_number):
    """How a label's material relates to what the OT already holds:
    'NOVO', 'DUPLICADO' (same material and lot) or 'LOTE_DIFERENTE'."""
    line = db.execute(
        text(
            """
            SELECT l.lot_number FROM purchase_order_lines l
            JOIN items i ON i.item_id = l.item_id
            WHERE l.po_id = :po AND i.sku = :sku
            """
        ),
        {"po": po_id, "sku": material_code},
    ).fetchone()
    if line is None:
        return "NOVO"
    if (line.lot_number or None) == (lot_number or None):
        return "DUPLICADO"
    return "LOTE_DIFERENTE"


def register_ot_materials(db, *, warehouse_id, header, materials, username,
                          source="ETIQUETA", unrecognized=()):
    """Register a label: create the OT when it is new, then add each
    material as its own record linked to the OT.

    The receiver is never taken from the caller: it is the user who
    registers the delivery (``username``), recorded when the OT is created.

    Existing data is never written over. Header fields still empty on an
    existing OT are filled in; a value that disagrees with what is
    registered is reported back (and noted on the OT for review) instead
    of replacing it. A material already on the OT is refused before
    anything is written, so one label can never be registered twice.

    ``header`` / ``materials`` are dicts shaped like schemas.sea.OtHeader /
    OtMaterial. Returns {po_id, ot, created, materials_added, divergences}.
    """
    code = header["ot_code"]
    header = {**header, "receiver_name": None}
    codes = [m["material_code"] for m in materials]
    if len(set(codes)) != len(codes):
        raise SeaError("O mesmo material aparece mais de uma vez no cadastro.", status=400)

    # Two operators reading labels of the same new OT at once: the second
    # waits here and then finds the OT created by the first.
    db.execute(
        text("SELECT pg_advisory_xact_lock(:ns, hashtext(:code))"),
        {"ns": _LOCK_NS_OT, "code": code},
    )
    columns = ", ".join(sorted(set(OT_HEADER_COLUMNS.values())))
    po = db.execute(
        text(
            f"""
            SELECT po_id, po_number, status, warehouse_id, {columns}
            FROM purchase_orders
            WHERE po_number = :code OR po_barcode = :code
            ORDER BY po_id LIMIT 1
            FOR UPDATE
            """
        ),
        {"code": code},
    ).fetchone()

    divergences = []
    created = po is None
    if created:
        if not header.get("service_order_type"):
            raise SeaError(
                "Informe o tipo da ordem de serviço (PM11 ou PM12) para cadastrar a OT.",
                status=400, field="service_order_type",
            )
        values = {col: header.get(fld) for fld, col in OT_HEADER_COLUMNS.items()}
        values["receiver_name"] = db.execute(
            text("SELECT COALESCE(NULLIF(full_name, ''), username) FROM users "
                 "WHERE username = :u"),
            {"u": username},
        ).scalar() or username
        po_id = db.execute(
            text(
                f"""
                INSERT INTO purchase_orders
                    (po_number, po_barcode, warehouse_id, status, created_by, data_source,
                     external_id, {', '.join(values)})
                VALUES (:po_number, :po_barcode, :wid, 'OPEN', :user, :source,
                        :ext, {', '.join(':' + c for c in values)})
                RETURNING po_id
                """
            ),
            {"po_number": code, "po_barcode": header.get("barcode") or code,
             "wid": warehouse_id, "user": username, "source": source,
             "ext": str(uuid.uuid4()), **values},
        ).scalar()
        po_number = code
    else:
        po_id, po_number = po.po_id, po.po_number
        if po.order_type is None:
            raise SeaError(
                f"O código {code} pertence a um pedido que não é uma OT do SEA.", status=409
            )
        if po.warehouse_id != warehouse_id:
            raise SeaError(f"A OT {po_number} pertence a outro armazém.", status=409)
        if po.status in PO_LOCKED_STATUSES:
            raise SeaError(
                f"A OT {po_number} está fechada e não aceita novos materiais.", status=409
            )
        fills = {}
        for fld, col in OT_HEADER_COLUMNS.items():
            new, current = header.get(fld), getattr(po, col)
            if new is None:
                continue
            if current is None:
                fills[col] = new
            elif not _same(current, new):
                divergences.append({"field": fld, "label": OT_FIELD_LABELS[fld],
                                    "registered": _text(current), "received": _text(new)})
        if fills:
            db.execute(
                text(
                    "UPDATE purchase_orders SET "
                    + ", ".join(f"{c} = :{c}" for c in fills)
                    + " WHERE po_id = :id"
                ),
                {"id": po_id, **fills},
            )

    added = []
    for m in materials:
        sku = m["material_code"]
        conflict = "NOVO" if created else material_conflict(db, po_id, sku, m.get("lot_number"))
        if conflict == "DUPLICADO":
            raise SeaError(
                f"O material {sku} (lote {m.get('lot_number') or 'não informado'}) já está "
                f"cadastrado na OT {po_number}. Nenhum registro foi criado.",
                status=409, duplicate=True, material_code=sku,
            )
        if conflict == "LOTE_DIFERENTE":
            raise SeaError(
                f"O material {sku} já está cadastrado na OT {po_number} com outro lote. "
                "Confira a etiqueta: o SEA mantém um registro por material em cada OT.",
                status=409, duplicate=True, material_code=sku,
            )
        item = db.execute(
            text("SELECT item_id, item_name, uom FROM items WHERE sku = :sku"), {"sku": sku}
        ).fetchone()
        if item is None:
            if not m.get("description"):
                raise SeaError(
                    f"Informe a descrição do material {sku}: ele ainda não está cadastrado.",
                    status=400, field="description", material_code=sku,
                )
            item_id = db.execute(
                text(
                    """
                    INSERT INTO items (sku, item_name, uom, external_id)
                    VALUES (:sku, :name, :uom, :ext) RETURNING item_id
                    """
                ),
                {"sku": sku, "name": m["description"], "uom": m.get("uom"),
                 "ext": str(uuid.uuid4())},
            ).scalar()
        else:
            item_id = item.item_id
            if m.get("description") and not _same(item.item_name, m["description"]):
                divergences.append({
                    "field": "description", "label": OT_FIELD_LABELS["description"],
                    "material_code": sku, "registered": item.item_name,
                    "received": m["description"],
                })
            if item.uom is None and m.get("uom"):
                db.execute(text("UPDATE items SET uom = :u WHERE item_id = :id"),
                           {"u": m["uom"], "id": item_id})
        db.execute(
            text(
                """
                INSERT INTO purchase_order_lines
                    (po_id, item_id, quantity_ordered, line_number, lot_number, expiry_date, uom,
                     service_order_number, service_order_type)
                VALUES (:po, :item, :qty,
                        (SELECT COALESCE(MAX(line_number), 0) + 1
                           FROM purchase_order_lines WHERE po_id = :po),
                        :lot, :expiry, :uom, :so_number, :so_type)
                """
            ),
            # The order of the material; the one on the label / header
            # when the material does not bring its own.
            {"po": po_id, "item": item_id, "qty": m["quantity"], "lot": m.get("lot_number"),
             "expiry": m.get("expiry_date"), "uom": m.get("uom"),
             "so_number": m.get("service_order_number") or header.get("service_order_number"),
             "so_type": m.get("service_order_type") or header.get("service_order_type")},
        )
        added.append({"sku": sku, "quantity": m["quantity"], "lot_number": m.get("lot_number")})

    if not created:
        # A fully received OT that gains a material has something to receive again.
        db.execute(
            text("UPDATE purchase_orders SET status = 'PARTIAL' "
                 "WHERE po_id = :id AND status = 'RECEIVED'"),
            {"id": po_id},
        )

    notes = [
        (f"Divergência em {d['label']}"
         + (f" do material {d['material_code']}" if d.get("material_code") else "")
         + f": cadastrado \"{d['registered']}\", recebido \"{d['received']}\".")
        for d in divergences
    ] + [f"Não reconhecido na etiqueta: {line}" for line in unrecognized]
    if notes:
        db.execute(
            text(
                """
                UPDATE purchase_orders
                SET review_notes = concat_ws(E'\\n', review_notes, CAST(:notes AS TEXT))
                WHERE po_id = :id
                """
            ),
            {"notes": "\n".join(notes), "id": po_id},
        )

    write_audit_log(
        db, ACTION_OT_REGISTERED if created else ACTION_OT_MATERIAL_ADDED, "PO", po_id,
        username, warehouse_id,
        details={"ot": po_number, "source": source, "materials": added,
                 "divergences": divergences},
    )
    return {"po_id": po_id, "ot": po_number, "created": created,
            "materials_added": added, "divergences": divergences}


def update_ot_data(db, po_id, changes, username, scope=("", None)):
    """Correct header fields of an OT. ``changes`` holds only the fields
    the operator sent; None clears a field back to pending."""
    po = _lock_ot_row(db, po_id, *scope)
    if "service_order_type" in changes and changes["service_order_type"] is None:
        raise SeaError("O tipo da ordem de serviço (PM11 ou PM12) é obrigatório.", status=400)
    updates, diff = {}, {}
    for fld, value in changes.items():
        col = "po_barcode" if fld == "barcode" else OT_HEADER_COLUMNS[fld]
        current = getattr(po, col)
        if _text(current) != _text(value):
            updates[col] = value
            diff[fld] = {"from": _text(current), "to": _text(value)}
    if "po_barcode" in updates and updates["po_barcode"] is None:
        updates["po_barcode"] = po.po_number
    if updates:
        db.execute(
            text(
                "UPDATE purchase_orders SET "
                + ", ".join(f"{c} = :{c}" for c in updates)
                + " WHERE po_id = :id"
            ),
            {"id": po_id, **updates},
        )
        write_audit_log(db, ACTION_OT_DATA_EDITED, "PO", po_id, username, po.warehouse_id,
                        details={"ot": po.po_number, "changes": diff})
    return diff


def _lock_ot_line(db, po_id, po_line_id):
    line = db.execute(
        text(
            """
            SELECT l.po_line_id, l.quantity_ordered, l.quantity_received, l.uom,
                   l.lot_number, l.expiry_date, i.sku
            FROM purchase_order_lines l JOIN items i ON i.item_id = l.item_id
            WHERE l.po_line_id = :line AND l.po_id = :po
            FOR UPDATE OF l
            """
        ),
        {"line": po_line_id, "po": po_id},
    ).fetchone()
    if line is None:
        raise SeaError("Material não encontrado nesta OT", status=404)
    return line


def update_ot_material(db, po_id, po_line_id, changes, username, scope=("", None)):
    """Correct one material of an OT. The quantity can only change while
    nothing of it has been received."""
    po = _lock_ot_row(db, po_id, *scope)
    line = _lock_ot_line(db, po_id, po_line_id)
    updates, diff = {}, {}
    for fld, value in changes.items():
        col = OT_MATERIAL_COLUMNS[fld]
        current = getattr(line, col)
        if _text(current) != _text(value):
            updates[col] = value
            diff[fld] = {"from": _text(current), "to": _text(value)}
    if "quantity_ordered" in updates:
        if updates["quantity_ordered"] is None:
            raise SeaError("A quantidade é obrigatória.", status=400)
        if line.quantity_received:
            raise SeaError(
                f"O material {line.sku} já teve {line.quantity_received} unidade(s) recebida(s); "
                "estorne o recebimento antes de corrigir a quantidade.",
                status=409,
            )
    if updates:
        db.execute(
            text(
                "UPDATE purchase_order_lines SET "
                + ", ".join(f"{c} = :{c}" for c in updates)
                + " WHERE po_line_id = :line"
            ),
            {"line": po_line_id, **updates},
        )
        write_audit_log(db, ACTION_OT_MATERIAL_EDITED, "PO", po_id, username, po.warehouse_id,
                        details={"ot": po.po_number, "sku": line.sku, "changes": diff})
    return diff


def remove_ot_material(db, po_id, po_line_id, username, scope=("", None)):
    """Remove a material registered by mistake, before any receipt."""
    po = _lock_ot_row(db, po_id, *scope)
    line = _lock_ot_line(db, po_id, po_line_id)
    if line.quantity_received:
        raise SeaError(
            f"O material {line.sku} já foi recebido e não pode ser removido da OT.", status=409
        )
    remaining = db.execute(
        text("SELECT COUNT(*) FROM purchase_order_lines WHERE po_id = :po AND po_line_id <> :l"),
        {"po": po_id, "l": po_line_id},
    ).scalar()
    if remaining == 0:
        raise SeaError("A OT precisa de ao menos um material.", status=409)
    db.execute(text("DELETE FROM purchase_order_lines WHERE po_line_id = :l"), {"l": po_line_id})
    # Removing the only pending material leaves the OT fully received.
    db.execute(
        text(
            """
            UPDATE purchase_orders SET status = 'RECEIVED'
            WHERE po_id = :po AND status = 'PARTIAL'
              AND NOT EXISTS (SELECT 1 FROM purchase_order_lines
                              WHERE po_id = :po AND quantity_received < quantity_ordered)
            """
        ),
        {"po": po_id},
    )
    write_audit_log(db, ACTION_OT_MATERIAL_REMOVED, "PO", po_id, username, po.warehouse_id,
                    details={"ot": po.po_number, "sku": line.sku,
                             "quantity": line.quantity_ordered, "lot_number": line.lot_number})


# ------------------------------------------------------------ Deletion
#
# Removing an order or a material takes everything that belongs to it
# (stock, receipts, movements, withdrawals). The audit log is append-only
# and keeps the record of what was removed and by whom.

ACTION_OT_DELETED = "OT_DELETED"
ACTION_MATERIAL_DELETED = "MATERIAL_DELETED"

# SEA tables the SEA does not use. A material referenced there is
# left alone instead of having unrelated records removed.
_FOREIGN_ITEM_TABLES = (
    "sales_order_lines", "pick_tasks", "item_fulfillment_lines", "transfer_order_lines",
)


def _delete_order_rows(db, po_id, po_number):
    """Delete an order and what hangs on it. Returns the units of stock removed."""
    params = {"po": po_id, "lot": po_number}
    db.execute(
        text(
            """
            DELETE FROM withdrawal_lines
            WHERE withdrawal_id IN (SELECT withdrawal_id FROM withdrawals WHERE po_id = :po)
               OR inventory_id IN (SELECT inventory_id FROM inventory WHERE lot_number = :lot)
            """
        ),
        params,
    )
    db.execute(text("DELETE FROM withdrawals WHERE po_id = :po"), params)
    db.execute(text("DELETE FROM bin_transfers WHERE lot_number = :lot"), params)
    db.execute(text("DELETE FROM item_receipts WHERE po_id = :po"), params)
    units = db.execute(
        text(
            """
            WITH gone AS (DELETE FROM inventory WHERE lot_number = :lot
                          RETURNING quantity_on_hand)
            SELECT COALESCE(SUM(quantity_on_hand), 0) FROM gone
            """
        ),
        params,
    ).scalar()
    db.execute(text("DELETE FROM sea_notifications WHERE ot = :lot"), params)
    db.execute(text("DELETE FROM purchase_order_lines WHERE po_id = :po"), params)
    db.execute(text("DELETE FROM purchase_orders WHERE po_id = :po"), params)
    return int(units)


def delete_ot(db, po_id, username):
    """Delete an order with its materials' records, stock, receipts,
    movements and withdrawals. The materials stay in the master."""
    po = db.execute(
        text(
            """
            SELECT po_id, po_number, warehouse_id, status FROM purchase_orders
            WHERE po_id = :id AND order_type IS NOT NULL FOR UPDATE
            """
        ),
        {"id": po_id},
    ).fetchone()
    if po is None:
        raise SeaError("Ordem não encontrada", status=404)
    lines = db.execute(
        text("SELECT COUNT(*) FROM purchase_order_lines WHERE po_id = :id"), {"id": po_id}
    ).scalar()
    units = _delete_order_rows(db, po.po_id, po.po_number)
    write_audit_log(db, ACTION_OT_DELETED, "PO", po.po_id, username, po.warehouse_id,
                    details={"ot": po.po_number, "status": po.status, "materials": lines,
                             "stock_units_removed": units})
    return {"ot": po.po_number, "materials": lines, "stock_units_removed": units}


def delete_material(db, item_id, username):
    """Delete a material everywhere: master record, the orders it is in,
    its stock, receipts, movements and withdrawals. An order left with no
    material is deleted too."""
    item = db.execute(
        text("SELECT item_id, sku FROM items WHERE item_id = :id FOR UPDATE"), {"id": item_id}
    ).fetchone()
    if item is None:
        raise SeaError("Material não encontrado", status=404)
    for table in _FOREIGN_ITEM_TABLES:  # names come from the constant above
        if db.execute(text(f"SELECT 1 FROM {table} WHERE item_id = :id LIMIT 1"),
                      {"id": item_id}).fetchone():
            raise SeaError(
                f"O material {item.sku} tem registros de expedição de pedidos e não pode ser "
                "excluído. Desative-o no cadastro.",
                status=409,
            )
    params = {"id": item_id}
    orders = db.execute(
        text(
            """
            SELECT p.po_id, p.po_number FROM purchase_orders p
            WHERE EXISTS (SELECT 1 FROM purchase_order_lines l
                          WHERE l.po_id = p.po_id AND l.item_id = :id)
            ORDER BY p.po_id FOR UPDATE
            """
        ),
        params,
    ).fetchall()
    db.execute(text("DELETE FROM withdrawal_lines WHERE item_id = :id"), params)
    db.execute(
        text(
            """
            DELETE FROM withdrawals w
            WHERE NOT EXISTS (SELECT 1 FROM withdrawal_lines l
                              WHERE l.withdrawal_id = w.withdrawal_id)
            """
        )
    )
    db.execute(text("DELETE FROM bin_transfers WHERE item_id = :id"), params)
    db.execute(text("DELETE FROM item_receipts WHERE item_id = :id"), params)
    units = int(db.execute(
        text(
            """
            WITH gone AS (DELETE FROM inventory WHERE item_id = :id RETURNING quantity_on_hand)
            SELECT COALESCE(SUM(quantity_on_hand), 0) FROM gone
            """
        ),
        params,
    ).scalar())
    db.execute(text("DELETE FROM purchase_order_lines WHERE item_id = :id"), params)
    removed_orders = []
    for o in orders:
        left = db.execute(
            text("SELECT COUNT(*) FROM purchase_order_lines WHERE po_id = :po"), {"po": o.po_id}
        ).scalar()
        if left == 0:
            _delete_order_rows(db, o.po_id, o.po_number)
            removed_orders.append(o.po_number)
        else:
            # The material that was still pending is gone: the order may be complete.
            db.execute(
                text(
                    """
                    UPDATE purchase_orders SET status = 'RECEIVED'
                    WHERE po_id = :po AND status = 'PARTIAL'
                      AND NOT EXISTS (SELECT 1 FROM purchase_order_lines
                                      WHERE po_id = :po AND quantity_received < quantity_ordered)
                    """
                ),
                {"po": o.po_id},
            )
    for table in ("preferred_bins", "cycle_count_lines", "inventory_adjustments",
                  "channel_availability"):
        db.execute(text(f"DELETE FROM {table} WHERE item_id = :id"), params)
    db.execute(text("DELETE FROM items WHERE item_id = :id"), params)
    write_audit_log(db, ACTION_MATERIAL_DELETED, "ITEM", item_id, username, None,
                    details={"sku": item.sku, "stock_units_removed": units,
                             "orders": [o.po_number for o in orders],
                             "orders_removed": removed_orders})
    return {"sku": item.sku, "stock_units_removed": units,
            "orders": [o.po_number for o in orders], "orders_removed": removed_orders}


def ot_movements(db, ot):
    """Every movement of an OT's materials, oldest first: receipt,
    storage / transfer between addresses, and withdrawal."""
    params = {"po": ot.po_id, "lot": ot.po_number}
    rows = db.execute(
        text(
            """
            SELECT 'RECEBIMENTO' AS kind, i.sku, r.quantity_received AS quantity,
                   NULL AS origin, b.bin_code AS destination,
                   r.received_by AS responsible, r.received_at AS moved_at, 1 AS stage
            FROM item_receipts r
            JOIN items i ON i.item_id = r.item_id
            JOIN bins b ON b.bin_id = r.bin_id
            WHERE r.po_id = :po
            UNION ALL
            SELECT CASE WHEN t.transfer_type = 'PUTAWAY' THEN 'ARMAZENAMENTO'
                        ELSE 'TRANSFERENCIA' END,
                   i.sku, t.quantity, fb.bin_code, tb.bin_code,
                   t.transferred_by, t.transferred_at, 2
            FROM bin_transfers t
            JOIN items i ON i.item_id = t.item_id
            JOIN bins fb ON fb.bin_id = t.from_bin_id
            JOIN bins tb ON tb.bin_id = t.to_bin_id
            WHERE t.lot_number = :lot
            UNION ALL
            SELECT 'RETIRADA', i.sku, wl.quantity, b.bin_code,
                   COALESCE(u.full_name, u.username), w.confirmed_by, w.delivered_at, 3
            FROM withdrawals w
            JOIN withdrawal_lines wl ON wl.withdrawal_id = w.withdrawal_id
            JOIN items i ON i.item_id = wl.item_id
            JOIN bins b ON b.bin_id = wl.bin_id
            LEFT JOIN users u ON u.user_id = w.delivered_to_user_id
            WHERE w.po_id = :po AND w.status = 'DELIVERED'
            ORDER BY moved_at, stage
            """
        ),
        params,
    ).fetchall()
    return [
        {"kind": r.kind, "sku": r.sku, "quantity": r.quantity, "origin": r.origin,
         "destination": r.destination, "responsible": r.responsible,
         "moved_at": r.moved_at.isoformat() if r.moved_at else None}
        for r in rows
    ]


def ot_materials(db, ot):
    """One record per material of the OT with its full trace: what was
    registered (code, lot, quantity), what came in, where it is stored,
    how much is still available and how much was withdrawn."""
    lines = db.execute(
        text(
            """
            SELECT l.po_line_id, l.line_number, l.item_id, i.sku, i.item_name,
                   COALESCE(l.uom, i.uom) AS uom, l.lot_number, l.expiry_date,
                   l.quantity_ordered, l.quantity_received, l.status, l.created_at,
                   COALESCE(l.service_order_number, p.service_order_number)
                       AS service_order_number,
                   COALESCE(l.service_order_type, p.order_type) AS service_order_type
            FROM purchase_order_lines l JOIN items i ON i.item_id = l.item_id
            JOIN purchase_orders p ON p.po_id = l.po_id
            WHERE l.po_id = :po ORDER BY l.line_number, l.po_line_id
            """
        ),
        {"po": ot.po_id},
    ).fetchall()
    stock = ot_stock(db, ot)
    movements = ot_movements(db, ot)
    result = []
    for ln in lines:
        places = [s for s in stock if s["item_id"] == ln.item_id]
        moves = [m for m in movements if m["sku"] == ln.sku]
        result.append({
            "po_line_id": ln.po_line_id, "line_number": ln.line_number, "item_id": ln.item_id,
            "sku": ln.sku, "item_name": ln.item_name, "uom": ln.uom,
            "lot_number": ln.lot_number,
            "service_order_number": ln.service_order_number,
            "service_order_type": ln.service_order_type,
            "expiry_date": ln.expiry_date.isoformat() if ln.expiry_date else None,
            "quantity_ordered": ln.quantity_ordered, "quantity_received": ln.quantity_received,
            "quantity_remaining": max(0, ln.quantity_ordered - ln.quantity_received),
            "status": ln.status,
            "created_at": ln.created_at.isoformat() if ln.created_at else None,
            "locations": [
                {"bin_code": s["bin_code"], "warehouse_code": s["warehouse_code"],
                 "stored": s["stored"],
                 "quantity_on_hand": s["quantity_on_hand"],
                 "quantity_allocated": s["quantity_allocated"], "available": s["available"]}
                for s in places
            ],
            "quantity_in_stock": sum(s["quantity_on_hand"] for s in places),
            "quantity_available": sum(s["available"] for s in places if s["stored"]),
            "quantity_withdrawn": sum(m["quantity"] for m in moves if m["kind"] == "RETIRADA"),
            "movements": moves,
        })
    return result


# ------------------------------------------------------- SP12 storage

def _bin(db, bin_id):
    return db.execute(
        text(
            """
            SELECT bin_id, bin_code, bin_type, warehouse_id, is_active,
                   capacity_units, size_class
            FROM bins WHERE bin_id = :bid
            """
        ),
        {"bid": bin_id},
    ).fetchone()


def _item(db, item_id):
    return db.execute(
        text("SELECT item_id, sku, size_class, compat_group FROM items WHERE item_id = :iid"),
        {"iid": item_id},
    ).fetchone()


def storage_problems(db, *, item, target_bin, quantity):
    """List the storage rules a put-away of ``quantity`` units would
    break (address type, size class, capacity, compatibility). An order
    may be spread over any number of addresses. Returns [] when the move
    is allowed.
    """
    problems = []
    if target_bin.bin_type in STAGING_TYPES:
        problems.append(
            f"{target_bin.bin_code} é área de recebimento, não endereço de armazenagem."
        )
    if target_bin.is_active is False:
        problems.append(f"O endereço {target_bin.bin_code} está inativo.")

    if target_bin.size_class and item.size_class != target_bin.size_class:
        problems.append(
            f"O endereço {target_bin.bin_code} é reservado a materiais de tamanho "
            f"{target_bin.size_class}; o material {item.sku} é "
            f"{item.size_class or 'sem classe definida'}."
        )

    occupants = db.execute(
        text(
            """
            SELECT inv.item_id, i.sku, i.compat_group, inv.lot_number,
                   SUM(inv.quantity_on_hand) AS units
            FROM inventory inv JOIN items i ON i.item_id = inv.item_id
            WHERE inv.bin_id = :bid AND inv.quantity_on_hand > 0
            GROUP BY inv.item_id, i.sku, i.compat_group, inv.lot_number
            """
        ),
        {"bid": target_bin.bin_id},
    ).fetchall()

    if target_bin.capacity_units is not None:
        used = sum(int(o.units) for o in occupants)
        if used + quantity > target_bin.capacity_units:
            problems.append(
                f"Capacidade excedida em {target_bin.bin_code}: {used} de "
                f"{target_bin.capacity_units} unidades ocupadas, tentando adicionar {quantity}."
            )

    for o in occupants:
        if o.item_id == item.item_id:
            continue
        if not (item.compat_group and o.compat_group == item.compat_group):
            problems.append(
                f"{item.sku} não é compatível com {o.sku}, já armazenado em {target_bin.bin_code}."
            )
            break

    return problems


def _staging_param():
    return bindparam("staging", expanding=True)


# Advisory-lock namespace for put-away checks (two-int form).
_LOCK_NS_BIN = 8202


def check_putaway(db, *, item_id, to_bin_id, quantity, lot_number):
    """Raise SeaError when a put-away of an OT lot breaks a storage rule.

    No-op for stock that is not an SEA OT lot, so plain SEA put-aways
    keep their original behaviour.
    """
    if ot_for_lot(db, lot_number) is None:
        return
    # Serialize concurrent put-aways into the same address (capacity,
    # compatibility) until commit.
    db.execute(
        text("SELECT pg_advisory_xact_lock(:ns, :bin)"),
        {"ns": _LOCK_NS_BIN, "bin": int(to_bin_id)},
    )
    item = _item(db, item_id)
    target = _bin(db, to_bin_id)
    if item is None or target is None:
        return  # the caller already returns 404 for these
    problems = storage_problems(db, item=item, target_bin=target, quantity=quantity)
    if problems:
        raise SeaError(problems[0], status=409, problems=problems)


def suggest_storage(db, *, inventory_id, warehouse_ids=None):
    """Suggest a storage address for a staging inventory row.

    Addresses of every location are candidates (``warehouse_ids`` limits
    them to the locations the user may use; None = all). Preference: an
    address already holding this OT (only a suggestion: the operator may
    choose any other); then the material's own location; otherwise the first active storage address,
    in put-away sequence, that satisfies size class, capacity and
    compatibility.
    """
    inv = db.execute(
        text(
            """
            SELECT inv.inventory_id, inv.item_id, inv.bin_id, inv.warehouse_id,
                   inv.lot_number, inv.quantity_on_hand, inv.quantity_allocated
            FROM inventory inv WHERE inv.inventory_id = :id
            """
        ),
        {"id": inventory_id},
    ).fetchone()
    if inv is None:
        raise SeaError("Registro de estoque não encontrado", status=404)
    item = _item(db, inv.item_id)
    quantity = int(inv.quantity_on_hand - inv.quantity_allocated)

    candidates = db.execute(
        text(
            """
            SELECT b.bin_id, w.warehouse_code
            FROM bins b JOIN warehouses w ON w.warehouse_id = b.warehouse_id
            WHERE b.is_active = TRUE AND w.is_active = TRUE
              AND b.bin_type NOT IN :staging
              AND (CAST(:wids AS INT[]) IS NULL OR b.warehouse_id = ANY(:wids))
            ORDER BY
              -- the address already holding this OT comes first
              (EXISTS (SELECT 1 FROM inventory x
                       WHERE x.bin_id = b.bin_id AND x.lot_number = :lot
                         AND x.quantity_on_hand > 0)) DESC,
              (b.warehouse_id = :wid) DESC, b.warehouse_id,
              b.putaway_sequence, b.bin_code
            """
        ).bindparams(_staging_param()),
        {"wid": inv.warehouse_id, "staging": list(STAGING_TYPES), "lot": inv.lot_number,
         "wids": list(warehouse_ids) if warehouse_ids is not None else None},
    ).fetchall()

    rejected = []
    for c in candidates:
        target = _bin(db, c.bin_id)
        problems = storage_problems(db, item=item, target_bin=target, quantity=quantity)
        if not problems:
            return {
                "bin_id": target.bin_id,
                "bin_code": target.bin_code,
                "warehouse_id": target.warehouse_id,
                "warehouse_code": c.warehouse_code,
                "quantity": quantity,
                "rejected": rejected,
            }
        rejected.append({"bin_code": target.bin_code, "warehouse_code": c.warehouse_code,
                         "reason": problems[0]})
    return {"bin_id": None, "bin_code": None, "warehouse_id": None, "warehouse_code": None,
            "quantity": quantity, "rejected": rejected}


# -------------------------------------------------------- Withdrawals

def order_label(ot):
    """Text that names an order in messages: OT plus its PM order."""
    number = getattr(ot, "service_order_number", None)
    detail = " ".join(x for x in (ot.order_type, number) if x)
    return f"OT {ot.po_number} ({detail})" if detail else f"OT {ot.po_number}"


def find_employee(db, user_id):
    """Active user who is confirming a withdrawal, or None."""
    return db.execute(
        text(
            """
            SELECT user_id, username, full_name, email FROM users
            WHERE user_id = :id AND is_active = TRUE
            """
        ),
        {"id": user_id},
    ).fetchone()


def notify_receipt(db, po, receipt_ids, username):
    """Announce the materials just received for an order (no-op for
    purchase orders that are not SEA orders)."""
    if not po.order_type or not receipt_ids:
        return
    row = db.execute(
        text(
            """
            SELECT COALESCE(SUM(r.quantity_received), 0) AS units,
                   COUNT(DISTINCT r.item_id) AS materials,
                   string_agg(DISTINCT b.bin_code, ', ') AS bins
            FROM item_receipts r JOIN bins b ON b.bin_id = r.bin_id
            WHERE r.receipt_id = ANY(:ids)
            """
        ),
        {"ids": list(receipt_ids)},
    ).fetchone()
    notifications.create(
        db, kind=notifications.KIND_RECEIPT, warehouse_id=po.warehouse_id,
        title=f"Recebimento de materiais: OT {po.po_number} ({po.order_type})",
        message=(f"{int(row.units)} unidade(s) de {row.materials} material(is) recebida(s) "
                 f"em {row.bins}. Aguardando armazenagem."),
        ot=po.po_number, username=username,
    )


def notify_storage_done(db, *, warehouse_id, lot_number, username):
    """Announce that an order has no unit left in the receiving area.
    Called after each put-away; no-op while something is still waiting."""
    ot = ot_for_lot(db, lot_number)
    if ot is None:
        return
    waiting = db.execute(
        text(
            """
            SELECT COALESCE(SUM(inv.quantity_on_hand), 0)
            FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
            WHERE inv.lot_number = :lot AND b.bin_type IN :staging
            """
        ).bindparams(bindparam("staging", expanding=True)),
        {"lot": lot_number, "staging": list(STAGING_TYPES)},
    ).scalar()
    if waiting:
        return
    # Every address holding the order (it may be spread over several).
    places = db.execute(
        text(
            """
            SELECT string_agg(DISTINCT w.warehouse_code || ' · ' || b.bin_code, ', ')
            FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
            JOIN warehouses w ON w.warehouse_id = inv.warehouse_id
            WHERE inv.lot_number = :lot AND inv.quantity_on_hand > 0
            """
        ),
        {"lot": lot_number},
    ).scalar()
    notifications.create(
        db, kind=notifications.KIND_STORAGE_DONE, warehouse_id=warehouse_id,
        title=f"Armazenamento concluído: {order_label(ot)}",
        message=(f"Todo o material recebido da {order_label(ot)} está armazenado em "
                 f"{places}."),
        ot=ot.po_number, username=username,
    )


def order_stock(db, order_number, warehouse_ids=None):
    """Materials of a PM order that can be withdrawn now: what is stored
    (not in a receiving area) with unreserved quantity, in the locations
    the user may use (``warehouse_ids``; None = all).

    The order of a material is the one registered on it; an OT registered
    without an order number answers by its own number. Returns None when
    no material belongs to ``order_number``; otherwise
    {"order_number", "order_type", "stock": [...]} where each stock row
    carries the OT (``ot``) it was received with.
    """
    rows = db.execute(
        text(
            """
            SELECT p.po_number, l.item_id, i.sku, i.item_name,
                   COALESCE(l.service_order_type, p.order_type) AS order_type,
                   inv.inventory_id, inv.bin_id, b.bin_code, inv.warehouse_id,
                   w.warehouse_code,
                   GREATEST(0, inv.quantity_on_hand - inv.quantity_allocated) AS available
            FROM purchase_order_lines l
            JOIN purchase_orders p ON p.po_id = l.po_id AND p.order_type IS NOT NULL
            JOIN items i ON i.item_id = l.item_id
            LEFT JOIN (inventory inv
                       JOIN bins b ON b.bin_id = inv.bin_id AND b.bin_type NOT IN :staging
                       JOIN warehouses w ON w.warehouse_id = inv.warehouse_id)
              ON inv.item_id = l.item_id AND inv.lot_number = p.po_number
             AND inv.quantity_on_hand > inv.quantity_allocated
             AND (CAST(:wids AS INT[]) IS NULL OR inv.warehouse_id = ANY(:wids))
            WHERE COALESCE(l.service_order_number, p.service_order_number, p.po_number) = :n
            ORDER BY w.warehouse_code, b.bin_code, i.sku
            """
        ).bindparams(_staging_param()),
        {"n": order_number, "staging": list(STAGING_TYPES),
         "wids": list(warehouse_ids) if warehouse_ids is not None else None},
    ).fetchall()
    if not rows:
        return None
    return {
        "order_number": order_number,
        "order_type": rows[0].order_type,
        "stock": [
            {"inventory_id": r.inventory_id, "ot": r.po_number, "item_id": r.item_id,
             "sku": r.sku, "item_name": r.item_name, "bin_id": r.bin_id,
             "bin_code": r.bin_code, "warehouse_id": r.warehouse_id,
             "warehouse_code": r.warehouse_code, "available": int(r.available)}
            for r in rows if r.inventory_id is not None
        ],
    }


def create_withdrawal(db, *, ot, lines, username, note=None):
    """Reserve stock of an OT and open a withdrawal request.

    ``lines``: [{"inventory_id": int, "quantity": int}]. Each inventory
    row must belong to the OT (lot = OT number), sit in a storage
    address and have enough unreserved quantity.
    """
    if ot.status == "CLOSED":
        raise SeaError(f"A OT {ot.po_number} está fechada.", status=400)
    seen = set()
    for line in lines:
        if line["inventory_id"] in seen:
            raise SeaError("Material repetido na solicitação.", status=400)
        seen.add(line["inventory_id"])

    locked = {}
    # Lock in a stable order so two concurrent requests cannot deadlock.
    for inventory_id in sorted(seen):
        row = db.execute(
            text(
                """
                SELECT inv.inventory_id, inv.item_id, inv.bin_id, inv.warehouse_id,
                       inv.lot_number, inv.quantity_on_hand, inv.quantity_allocated,
                       b.bin_type, b.bin_code, i.sku
                FROM inventory inv
                JOIN bins b ON b.bin_id = inv.bin_id
                JOIN items i ON i.item_id = inv.item_id
                WHERE inv.inventory_id = :id
                FOR UPDATE OF inv
                """
            ),
            {"id": inventory_id},
        ).fetchone()
        if row is None or row.lot_number != ot.po_number:
            raise SeaError(
                f"O estoque {inventory_id} não pertence à OT {ot.po_number}.", status=400
            )
        if row.bin_type in STAGING_TYPES:
            raise SeaError(
                f"{row.sku} ainda está na área de recebimento; armazene-o antes da retirada.",
                status=409,
            )
        locked[inventory_id] = row

    # The withdrawal belongs to the location where the material is stored
    # (its stock keeper separates it), not where the order was received.
    locations = {row.warehouse_id for row in locked.values()}
    if len(locations) != 1:
        raise SeaError("Os materiais de uma retirada devem estar no mesmo local.", status=400)
    stock_warehouse_id = locations.pop()

    for line in lines:
        row = locked[line["inventory_id"]]
        available = row.quantity_on_hand - row.quantity_allocated
        if line["quantity"] > available:
            raise SeaError(
                f"Quantidade solicitada de {row.sku} ({line['quantity']}) maior que o saldo "
                f"disponível em {row.bin_code} ({max(0, available)}).",
                status=409, inventory_id=row.inventory_id, available=max(0, available),
            )

    withdrawal_id = db.execute(
        text(
            """
            INSERT INTO withdrawals (warehouse_id, po_id, status, requested_by, requester_note)
            VALUES (:wid, :po_id, :status, :user, :note)
            RETURNING withdrawal_id
            """
        ),
        {"wid": stock_warehouse_id, "po_id": ot.po_id, "status": W_REQUESTED,
         "user": username, "note": note},
    ).scalar()

    for line in lines:
        row = locked[line["inventory_id"]]
        db.execute(
            text(
                """
                UPDATE inventory
                SET quantity_allocated = quantity_allocated + :q, updated_at = NOW()
                WHERE inventory_id = :id
                """
            ),
            {"q": line["quantity"], "id": row.inventory_id},
        )
        db.execute(
            text(
                """
                INSERT INTO withdrawal_lines (withdrawal_id, inventory_id, item_id, bin_id,
                                              lot_number, quantity)
                VALUES (:w, :inv, :item, :bin, :lot, :q)
                """
            ),
            {"w": withdrawal_id, "inv": row.inventory_id, "item": row.item_id,
             "bin": row.bin_id, "lot": row.lot_number, "q": line["quantity"]},
        )

    write_audit_log(
        db, ACTION_WITHDRAWAL_REQUESTED, "WITHDRAWAL", withdrawal_id, username,
        stock_warehouse_id,
        details={
            "ot": ot.po_number,
            "order_type": ot.order_type,
            "lines": [{"inventory_id": ln["inventory_id"], "sku": locked[ln["inventory_id"]].sku,
                       "bin_code": locked[ln["inventory_id"]].bin_code, "quantity": ln["quantity"]}
                      for ln in lines],
            "note": note,
        },
    )
    notifications.create(
        db, kind=notifications.KIND_WITHDRAWAL_REQUESTED, warehouse_id=stock_warehouse_id,
        title=f"Retirada nº {withdrawal_id} solicitada: {order_label(ot)}",
        message="Solicitada por {}: {}.".format(
            username,
            "; ".join(
                f"{ln['quantity']} x {locked[ln['inventory_id']].sku} "
                f"({locked[ln['inventory_id']].bin_code})" for ln in lines
            ),
        ),
        ot=ot.po_number, username=username,
    )
    return withdrawal_id


def _lock_withdrawal(db, withdrawal_id, scope_clause="", scope_params=None):
    row = db.execute(
        text(
            f"""
            SELECT w.withdrawal_id, w.status, w.warehouse_id, w.po_id, w.requested_by,
                   p.po_number
            FROM withdrawals w JOIN purchase_orders p ON p.po_id = w.po_id
            WHERE w.withdrawal_id = :id {scope_clause}
            FOR UPDATE OF w
            """
        ),
        {"id": withdrawal_id, **(scope_params or {})},
    ).fetchone()
    if row is None:
        raise SeaError("Retirada não encontrada", status=404)
    return row


_STATUS_TEXT = {
    W_REQUESTED: "solicitada",
    W_PICKING: "em separação",
    W_READY: "pronta para entrega",
    W_DELIVERED: "já entregue",
    W_CANCELLED: "cancelada",
}


def _require_status(w, allowed, action):
    if w.status not in allowed:
        raise SeaError(
            f"Não é possível {action}: a retirada nº {w.withdrawal_id} está "
            f"{_STATUS_TEXT.get(w.status, w.status)}.",
            status=409, status_atual=w.status,
        )


def start_picking(db, withdrawal_id, username, scope=("", None)):
    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, (W_REQUESTED,), "iniciar a separação")
    db.execute(
        text(
            """
            UPDATE withdrawals SET status = :s, picked_by = :u, picking_started_at = NOW()
            WHERE withdrawal_id = :id
            """
        ),
        {"s": W_PICKING, "u": username, "id": withdrawal_id},
    )
    write_audit_log(db, ACTION_WITHDRAWAL_PICKING, "WITHDRAWAL", withdrawal_id, username,
                    w.warehouse_id, details={"ot": w.po_number})


def mark_ready(db, withdrawal_id, username, scope=("", None)):
    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, (W_PICKING,), "marcar como pronta")
    db.execute(
        text("UPDATE withdrawals SET status = :s, ready_at = NOW() WHERE withdrawal_id = :id"),
        {"s": W_READY, "id": withdrawal_id},
    )
    write_audit_log(db, ACTION_WITHDRAWAL_READY, "WITHDRAWAL", withdrawal_id, username,
                    w.warehouse_id, details={"ot": w.po_number})


def _withdrawal_lines(db, withdrawal_id):
    return db.execute(
        text(
            """
            SELECT wl.withdrawal_line_id, wl.inventory_id, wl.quantity, i.sku, b.bin_code
            FROM withdrawal_lines wl
            JOIN items i ON i.item_id = wl.item_id
            JOIN bins b ON b.bin_id = wl.bin_id
            WHERE wl.withdrawal_id = :id
            ORDER BY wl.inventory_id
            """
        ),
        {"id": withdrawal_id},
    ).fetchall()


def deliver(db, withdrawal_id, employee_user_id, scope=("", None)):
    """Confirm the handover and remove the stock.

    The employee is the logged-in user (corporate login at the terminal)
    and must be the one who requested the withdrawal.

    Runs entirely under row locks: the withdrawal row first (so a second
    confirmation waits and then sees DELIVERED), then each inventory row
    in a stable order.
    """
    employee = find_employee(db, employee_user_id)
    if employee is None:
        raise SeaError("Usuário não identificado. Entre novamente no terminal.", status=403)

    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, (W_READY,), "confirmar a entrega")
    if w.requested_by != employee.username:
        raise SeaError(
            f"A retirada nº {withdrawal_id} foi solicitada por {w.requested_by}. "
            "Somente quem solicitou pode confirmar o recebimento.",
            status=403,
        )

    lines = _withdrawal_lines(db, withdrawal_id)
    for line in lines:
        inv = db.execute(
            text(
                """
                SELECT inventory_id, quantity_on_hand, quantity_allocated
                FROM inventory WHERE inventory_id = :id FOR UPDATE
                """
            ),
            {"id": line.inventory_id},
        ).fetchone()
        short = inv is None or min(inv.quantity_on_hand, inv.quantity_allocated) < line.quantity
        if short:
            # Stock changed under the reservation (e.g. an adjustment):
            # refuse rather than drive on-hand negative.
            raise SeaError(
                f"Saldo de {line.sku} em {line.bin_code} insuficiente para a baixa; "
                f"verifique o estoque antes de entregar.",
                status=409,
            )
        db.execute(
            text(
                """
                UPDATE inventory
                SET quantity_on_hand = quantity_on_hand - :q,
                    quantity_allocated = quantity_allocated - :q,
                    updated_at = NOW()
                WHERE inventory_id = :id
                """
            ),
            {"q": line.quantity, "id": line.inventory_id},
        )

    db.execute(
        text(
            """
            UPDATE withdrawals
            SET status = :s, delivered_to_user_id = :emp,
                delivered_at = NOW(), confirmed_by = :u
            WHERE withdrawal_id = :id
            """
        ),
        {"s": W_DELIVERED, "emp": employee.user_id, "u": employee.username,
         "id": withdrawal_id},
    )
    write_audit_log(
        db, ACTION_WITHDRAWAL_DELIVERED, "WITHDRAWAL", withdrawal_id, employee.username,
        w.warehouse_id,
        details={
            "ot": w.po_number,
            "employee_user_id": employee.user_id,
            "employee_name": employee.full_name,
            "identified_by": "login",
            "lines": [{"sku": ln.sku, "bin_code": ln.bin_code, "quantity": ln.quantity}
                      for ln in lines],
        },
    )
    return employee


def cancel(db, withdrawal_id, username, reason, scope=("", None)):
    reason = (reason or "").strip()
    if not reason:
        raise SeaError("Informe o motivo do cancelamento.", status=400)
    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, W_OPEN_STATUSES, "cancelar")
    for line in _withdrawal_lines(db, withdrawal_id):
        db.execute(
            text(
                """
                UPDATE inventory
                SET quantity_allocated = GREATEST(0, quantity_allocated - :q), updated_at = NOW()
                WHERE inventory_id = :id
                """
            ),
            {"q": line.quantity, "id": line.inventory_id},
        )
    db.execute(
        text(
            """
            UPDATE withdrawals SET status = :s, cancelled_by = :u, cancelled_at = NOW(),
                   cancel_reason = :r
            WHERE withdrawal_id = :id
            """
        ),
        {"s": W_CANCELLED, "u": username, "r": reason, "id": withdrawal_id},
    )
    write_audit_log(db, ACTION_WITHDRAWAL_CANCELLED, "WITHDRAWAL", withdrawal_id, username,
                    w.warehouse_id, details={"ot": w.po_number, "reason": reason})
