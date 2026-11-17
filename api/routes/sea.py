"""SEA endpoints: Painel, Estoque SP12, OTs, materials, put-away suggestion,
notifications and the withdrawal (Retirada) terminal. Business rules live in
services/sea_service.py; this module only handles HTTP, permissions and
warehouse scoping.
"""

from functools import wraps

from flask import Blueprint, g, jsonify, request
from sqlalchemy import bindparam, text

from middleware.auth_middleware import (
    check_warehouse_access,
    require_admin_or_page_permission,
    require_auth,
    require_role,
    warehouse_scope_clause,
)
from middleware.db import with_db
from schemas.sea import (
    CancelWithdrawalRequest,
    CreateBaseOtRequest,
    CreateCatalogMaterialRequest,
    RegisterPushTokenRequest,
    UpdateCatalogMaterialRequest,
    CreateWithdrawalRequest,
    InterpretLabelRequest,
    RegisterFromBaseRequest,
    RegisterOtRequest,
    TransferStockRequest,
    UpdateOtDataRequest,
    UpdateOtMaterialRequest,
)
from services import notification_service as notifications
from services import sap_base
from services import sea_service as sea
from services.audit_service import write_audit_log
from services.label_parser import parse_label
from services.ot_source import get_ot_source
from utils.validation import validate_body

sea_bp = Blueprint("sea", __name__)

STAGING = list(sea.STAGING_TYPES)


# A mobile module granted to the user opens the same data as the page of
# the panel that does the same work.
FUNCTION_PAGES = {"receive": "receiving", "putaway": "putaway"}


def require_any_page(*page_keys):
    """ADMIN passes; other users need at least one of ``page_keys`` (or the
    mobile module that corresponds to one of them)."""

    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            allowed = g.current_user.get("allowed_pages")
            if allowed is None or any(k in allowed for k in page_keys):
                return f(*args, **kwargs)
            functions = g.current_user.get("allowed_functions") or []
            if any(FUNCTION_PAGES.get(fn) in page_keys for fn in functions):
                return f(*args, **kwargs)
            return jsonify({"error": "Permission denied", "page_key": page_keys[0]}), 403

        return decorated

    return decorator


def _user_error(message, status, **extra):
    """Error written for the operator. ``user_facing`` lets the admin UI show
    the text instead of its generic fallback (V-021 hides unflagged errors)."""
    return jsonify({"error": message, "user_facing": True, **extra}), status


def _sea_error(exc):
    return _user_error(str(exc), exc.status, **exc.context)


def _warehouse_arg():
    """Required ?warehouse_id=, validated against the user's warehouses."""
    warehouse_id = request.args.get("warehouse_id", type=int)
    if not warehouse_id:
        return None, _user_error("warehouse_id é obrigatório", 400)
    ok, denied = check_warehouse_access(warehouse_id)
    if not ok:
        return None, denied
    return warehouse_id, None


def _iso(value):
    return value.isoformat() if value else None


def _user_warehouse_ids():
    """Locations the user may use: None = all (ADMIN)."""
    if g.current_user.get("role") == "ADMIN":
        return None
    return list(g.current_user.get("warehouse_ids") or [])


# ------------------------------------------------------------- Locais

@sea_bp.route("/locais")
@require_auth
@with_db
def locais():
    """Locations the logged-in user can work in. Every panel user needs
    this list (location selector); /api/admin/warehouses is restricted to
    users who administer warehouses."""
    scope_clause, scope_params = warehouse_scope_clause("warehouse_id")
    rows = g.db.execute(
        text(
            f"""
            SELECT warehouse_id, warehouse_code, warehouse_name FROM warehouses
            WHERE is_active = TRUE {scope_clause}
            ORDER BY warehouse_id
            """
        ),
        scope_params,
    ).fetchall()
    return jsonify({
        "warehouses": [
            {"warehouse_id": r.warehouse_id, "warehouse_code": r.warehouse_code,
             "warehouse_name": r.warehouse_name}
            for r in rows
        ],
    })


# ------------------------------------------------------------- Painel

# Audit details shown on the Painel (visible to every warehouse user):
# only these display fields, never badge UIDs or other raw payload.
_PAINEL_DETAIL_KEYS = ("ot", "po_number", "sku", "quantity", "to_bin_code", "employee_name",
                       "lot_number", "reason")


def _public_details(details):
    if not isinstance(details, dict):
        return {}
    return {k: details[k] for k in _PAINEL_DETAIL_KEYS if k in details}


@sea_bp.route("/painel")
@require_auth
@with_db
def painel():
    warehouse_id, err = _warehouse_arg()
    if err:
        return err
    params = {"wid": warehouse_id, "staging": STAGING}

    ots = g.db.execute(
        text(
            """
            SELECT order_type, status, COUNT(*) AS n FROM purchase_orders
            WHERE warehouse_id = :wid AND order_type IS NOT NULL
            GROUP BY order_type, status
            """
        ),
        params,
    ).fetchall()
    ot_counts = {}
    for r in ots:
        ot_counts.setdefault(r.order_type, {})[r.status] = r.n

    stock = g.db.execute(
        text(
            """
            SELECT
              COALESCE(SUM(inv.quantity_on_hand)
                       FILTER (WHERE b.bin_type NOT IN :staging), 0) AS stored_units,
              COALESCE(SUM(inv.quantity_on_hand)
                       FILTER (WHERE b.bin_type IN :staging), 0) AS staging_units,
              COUNT(DISTINCT inv.lot_number) FILTER (WHERE b.bin_type IN :staging
                                                   AND inv.quantity_on_hand > 0) AS staging_ots,
              COUNT(DISTINCT inv.bin_id) FILTER (WHERE b.bin_type NOT IN :staging
                                               AND inv.quantity_on_hand > 0) AS occupied_bins
            FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
            WHERE inv.warehouse_id = :wid
            """
        ).bindparams(bindparam("staging", expanding=True)),
        params,
    ).fetchone()
    storage_bins = g.db.execute(
        text(
            "SELECT COUNT(*) FROM bins WHERE warehouse_id = :wid AND is_active = TRUE "
            "AND bin_type NOT IN :staging"
        ).bindparams(bindparam("staging", expanding=True)),
        params,
    ).scalar()

    withdrawals = g.db.execute(
        text(
            """
            SELECT status, COUNT(*) AS n FROM withdrawals
            WHERE warehouse_id = :wid
              AND (status IN ('REQUESTED', 'PICKING', 'READY')
                   OR COALESCE(delivered_at, cancelled_at, requested_at) >= CURRENT_DATE)
            GROUP BY status
            """
        ),
        params,
    ).fetchall()
    w_counts = {r.status: r.n for r in withdrawals}

    recent = g.db.execute(
        text(
            """
            SELECT log_id, action_type, entity_type, entity_id, user_id, details, created_at
            FROM audit_log WHERE warehouse_id = :wid
            ORDER BY log_id DESC LIMIT 12
            """
        ),
        params,
    ).fetchall()

    open_ots = sum(n for t in ot_counts.values() for s, n in t.items() if s in ("OPEN", "PARTIAL"))
    pending_withdrawals = sum(w_counts.get(s, 0) for s in sea.W_OPEN_STATUSES)
    scope_clause, scope_params = warehouse_scope_clause("warehouse_id")
    pending_everywhere = g.db.execute(
        text(
            "SELECT COUNT(*) FROM withdrawals "
            f"WHERE status IN ('REQUESTED', 'PICKING', 'READY') {scope_clause}"
        ),
        scope_params,
    ).scalar()
    return jsonify({
        "pending_withdrawals_all": int(pending_everywhere),
        "ots": ot_counts,
        "open_ots": open_ots,
        # Orders with nothing received yet: what the "Receber" counters
        # show. An order received in part leaves the counter (it is still
        # listed as waiting for the rest).
        "unreceived_ots": sum(t.get("OPEN", 0) for t in ot_counts.values()),
        "pending_withdrawals": pending_withdrawals,
        "withdrawals": w_counts,
        "stored_units": int(stock.stored_units),
        "staging_units": int(stock.staging_units),
        "staging_ots": int(stock.staging_ots),
        "occupied_bins": int(stock.occupied_bins),
        "storage_bins": int(storage_bins),
        "recent": [
            {"log_id": r.log_id, "action_type": r.action_type, "entity_type": r.entity_type,
             "entity_id": r.entity_id, "user": r.user_id,
             "details": _public_details(r.details),
             "created_at": _iso(r.created_at)}
            for r in recent
        ],
    })


# ------------------------------------------------------- Estoque SP12

@sea_bp.route("/estoque")
@require_auth
@require_admin_or_page_permission("inventory")
@with_db
def estoque():
    warehouse_id, err = _warehouse_arg()
    if err:
        return err
    bins = g.db.execute(
        text(
            """
            SELECT bin_id, bin_code, bin_type, aisle, level_num, capacity_units, size_class,
                   is_active, description
            FROM bins WHERE warehouse_id = :wid
            ORDER BY (bin_type IN :staging) DESC, putaway_sequence, bin_code
            """
        ).bindparams(bindparam("staging", expanding=True)),
        {"wid": warehouse_id, "staging": STAGING},
    ).fetchall()
    contents = g.db.execute(
        text(
            f"""
            SELECT inv.bin_id, inv.inventory_id, inv.item_id, i.sku, i.item_name,
                   inv.lot_number, inv.quantity_on_hand, inv.quantity_allocated,
                   {sea.ORDER_OF_STOCK_COLUMNS}
            FROM inventory inv
            JOIN items i ON i.item_id = inv.item_id
            {sea.ORDER_OF_STOCK_JOIN}
            WHERE inv.warehouse_id = :wid AND inv.quantity_on_hand > 0
            ORDER BY i.sku
            """
        ),
        {"wid": warehouse_id},
    ).fetchall()
    by_bin = {}
    for c in contents:
        by_bin.setdefault(c.bin_id, []).append({
            "inventory_id": c.inventory_id, "item_id": c.item_id, "sku": c.sku,
            "item_name": c.item_name, "ot": c.lot_number, "order_type": c.order_type,
            "order_number": c.order_number,
            "quantity_on_hand": c.quantity_on_hand, "quantity_allocated": c.quantity_allocated,
            "available": max(0, c.quantity_on_hand - c.quantity_allocated),
        })
    result = []
    for b in bins:
        items = by_bin.get(b.bin_id, [])
        units = sum(i["quantity_on_hand"] for i in items)
        result.append({
            "bin_id": b.bin_id, "bin_code": b.bin_code, "bin_type": b.bin_type,
            "staging": b.bin_type in sea.STAGING_TYPES,
            "aisle": b.aisle, "level": b.level_num, "description": b.description,
            "capacity_units": b.capacity_units, "size_class": b.size_class,
            "is_active": b.is_active, "units": units,
            "occupancy_pct": (round(100 * units / b.capacity_units) if b.capacity_units else None),
            "contents": items,
        })
    stored = [r for r in result if not r["staging"]]
    return jsonify({
        "bins": result,
        "totals": {
            "stored_units": sum(r["units"] for r in stored),
            "staging_units": sum(r["units"] for r in result if r["staging"]),
            "storage_bins": len(stored),
            "occupied_bins": sum(1 for r in stored if r["units"] > 0),
        },
    })


# ---------------------------------------------------------- Materiais

@sea_bp.route("/materiais")
@require_auth
@require_admin_or_page_permission("items")
@with_db
def list_materiais():
    """Materials as the stock keeper sees them: one row per material of
    each order in this warehouse, plus the materials of the master that
    are in no order here (order columns null)."""
    warehouse_id, err = _warehouse_arg()
    if err:
        return err
    page = max(1, request.args.get("page", 1, type=int))
    per_page = min(max(1, request.args.get("per_page", 50, type=int)), 200)
    where, params = [], {"wid": warehouse_id}
    q = (request.args.get("q") or "").strip()
    if q:
        where.append(
            "(i.sku ILIKE :q OR i.item_name ILIKE :q OR p.po_number ILIKE :q "
            "OR p.service_order_number ILIKE :q OR l.service_order_number ILIKE :q)"
        )
        params["q"] = f"%{q}%"
    active = request.args.get("active")
    if active in ("true", "false"):
        where.append("i.is_active = :active")
        params["active"] = active == "true"
    base = f"""
        FROM items i
        LEFT JOIN (purchase_order_lines l
                   JOIN purchase_orders p
                     ON p.po_id = l.po_id AND p.order_type IS NOT NULL
                    AND (p.warehouse_id = :wid
                         OR EXISTS (SELECT 1 FROM inventory x
                                    WHERE x.lot_number = p.po_number AND x.warehouse_id = :wid
                                      AND x.quantity_on_hand > 0)))
          ON l.item_id = i.item_id
        {('WHERE ' + ' AND '.join(where)) if where else ''}
    """
    total = g.db.execute(text(f"SELECT COUNT(*) {base}"), params).scalar()
    rows = g.db.execute(
        text(
            f"""
            SELECT i.item_id, i.sku, i.item_name, i.upc, i.mpn, i.category, i.size_class,
                   i.compat_group, i.weight_lbs, i.default_bin_id, i.is_active,
                   i.uom AS item_uom, i.pack_weight_kg, l.po_line_id, l.quantity_ordered, l.uom AS line_uom,
                   p.po_number,
                   COALESCE(l.service_order_type, p.order_type) AS order_type,
                   COALESCE(l.service_order_number, p.service_order_number)
                       AS service_order_number
            {base}
            ORDER BY p.po_id DESC NULLS LAST, l.line_number, i.sku
            LIMIT :limit OFFSET :offset
            """
        ),
        {**params, "limit": per_page, "offset": (page - 1) * per_page},
    ).fetchall()
    return jsonify({
        "items": [
            {"row_id": f"{r.item_id}-{r.po_line_id or 0}", "item_id": r.item_id, "sku": r.sku,
             "item_name": r.item_name, "upc": r.upc, "mpn": r.mpn, "category": r.category,
             "size_class": r.size_class, "compat_group": r.compat_group,
             "weight_lbs": float(r.weight_lbs) if r.weight_lbs is not None else None,
             "default_bin_id": r.default_bin_id, "is_active": r.is_active,
             "uom": r.line_uom or r.item_uom, "item_uom": r.item_uom,
             # Box weight of the material (applies when its unit is KG).
             "pack_weight_kg": r.pack_weight_kg,
             "quantity": r.quantity_ordered,
             # The PM order when the label informed it; otherwise the OT number.
             "order": r.service_order_number or r.po_number,
             "ot": r.po_number, "order_type": r.order_type}
            for r in rows
        ],
        "total": total, "page": page, "per_page": per_page,
        "pages": max(1, -(-total // per_page)),
    })


# ------------------------------------------------------- Notificações

@sea_bp.route("/notificacoes/limpar", methods=["POST"])
@require_auth
@with_db
def limpar_notificacoes():
    """Clear the user's own notification list. The records stay."""
    cleared = g.db.execute(
        text(
            """
            UPDATE users
            SET notifications_cleared_id =
                (SELECT COALESCE(MAX(notification_id), 0) FROM sea_notifications)
            WHERE user_id = :uid
            RETURNING notifications_cleared_id
            """
        ),
        {"uid": g.current_user["user_id"]},
    ).scalar()
    g.db.commit()
    return jsonify({"message": "Notificações limpas", "cleared_id": cleared})


@sea_bp.route("/notificacoes")
@require_auth
@with_db
def list_notificacoes():
    """Latest notifications of the warehouses the user can see. ``after``
    returns only the ones newer than a known id (panel polling)."""
    scope_clause, scope_params = warehouse_scope_clause("n.warehouse_id")
    after = request.args.get("after", type=int)
    limit = min(max(1, request.args.get("limit", 20, type=int)), 50)
    rows = g.db.execute(
        text(
            f"""
            SELECT n.notification_id, n.kind, n.title, n.message, n.ot, n.created_by,
                   n.created_at, n.email_status, n.warehouse_id, w.warehouse_code
            FROM sea_notifications n JOIN warehouses w ON w.warehouse_id = n.warehouse_id
            WHERE (CAST(:after AS INT) IS NULL OR n.notification_id > :after)
              -- what this user cleared no longer shows for them
              AND n.notification_id > (SELECT notifications_cleared_id FROM users
                                       WHERE user_id = :uid)
              {scope_clause}
            ORDER BY n.notification_id DESC
            LIMIT :limit
            """
        ),
        {"after": after, "limit": limit, "uid": g.current_user["user_id"], **scope_params},
    ).fetchall()
    return jsonify({
        "notifications": [
            {"notification_id": r.notification_id, "kind": r.kind, "title": r.title,
             "message": r.message, "ot": r.ot, "created_by": r.created_by,
             "created_at": _iso(r.created_at), "email_status": r.email_status,
             "warehouse_id": r.warehouse_id, "warehouse_code": r.warehouse_code}
            for r in rows
        ],
        "email_configured": notifications.smtp_config() is not None,
    })


# ---------------------------------------------------------------- OTs

OT_PAGE_KEYS = ("inventory", "purchase-orders", "receiving", "putaway", "retirada")


@sea_bp.route("/ots")
@require_auth
@require_any_page(*OT_PAGE_KEYS)
@with_db
def list_ots():
    warehouse_id, err = _warehouse_arg()
    if err:
        return err
    where = [
        "(p.warehouse_id = :wid OR EXISTS (SELECT 1 FROM inventory x WHERE x.lot_number = "
        "p.po_number AND x.warehouse_id = :wid AND x.quantity_on_hand > 0))",
        "p.order_type IS NOT NULL",
    ]
    params = {"wid": warehouse_id, "staging": STAGING}
    order_type = request.args.get("order_type")
    if order_type:
        if order_type not in sea.OT_TYPES:
            return _user_error("order_type deve ser PM11 ou PM12", 400)
        where.append("p.order_type = :ot_type")
        params["ot_type"] = order_type
    status = request.args.get("status")
    if status:
        where.append("p.status = :status")
        params["status"] = status
    q = (request.args.get("q") or "").strip()
    if q:
        where.append("p.po_number ILIKE :q")
        params["q"] = f"%{q}%"

    rows = g.db.execute(
        text(
            f"""
            SELECT p.po_id, p.po_number, p.order_type, p.status, p.expected_date,
                   p.created_at, p.received_at,
                   (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = p.po_id) AS lines,
                   (SELECT COALESCE(SUM(quantity_ordered), 0) FROM purchase_order_lines l
                     WHERE l.po_id = p.po_id) AS qty_ordered,
                   (SELECT COALESCE(SUM(quantity_received), 0) FROM purchase_order_lines l
                     WHERE l.po_id = p.po_id) AS qty_received,
                   (SELECT COALESCE(SUM(inv.quantity_on_hand), 0)
                      FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
                     WHERE inv.lot_number = p.po_number
                       AND b.bin_type NOT IN :staging) AS qty_stored,
                   (SELECT COALESCE(SUM(inv.quantity_on_hand), 0)
                      FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
                     WHERE inv.lot_number = p.po_number
                       AND b.bin_type IN :staging) AS qty_staging,
                   (SELECT string_agg(DISTINCT sw.warehouse_code || ' · ' || b.bin_code, ', ')
                      FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
                      JOIN warehouses sw ON sw.warehouse_id = inv.warehouse_id
                     WHERE inv.lot_number = p.po_number
                       AND inv.quantity_on_hand > 0 AND b.bin_type NOT IN :staging) AS bins,
                   (SELECT COALESCE(SUM(wl.quantity), 0)
                      FROM withdrawals w JOIN withdrawal_lines wl
                        ON wl.withdrawal_id = w.withdrawal_id
                     WHERE w.po_id = p.po_id AND w.status = 'DELIVERED') AS qty_withdrawn
            FROM purchase_orders p
            WHERE {' AND '.join(where)}
            ORDER BY p.po_id DESC
            LIMIT 500
            """
        ).bindparams(bindparam("staging", expanding=True)),
        params,
    ).fetchall()
    return jsonify({
        "ots": [
            {"po_id": r.po_id, "ot": r.po_number, "order_type": r.order_type,
             "status": r.status, "expected_date": _iso(r.expected_date),
             "created_at": _iso(r.created_at), "received_at": _iso(r.received_at),
             "lines": r.lines, "qty_ordered": int(r.qty_ordered),
             "qty_received": int(r.qty_received), "qty_stored": int(r.qty_stored),
             "qty_staging": int(r.qty_staging), "qty_withdrawn": int(r.qty_withdrawn),
             "bins": r.bins}
            for r in rows
        ],
    })


@sea_bp.route("/ots/<path:code>")
@require_auth
@require_any_page(*OT_PAGE_KEYS)
@with_db
def get_ot(code):
    scope_clause, scope_params = warehouse_scope_clause("warehouse_id")
    ot = sea.find_ot(g.db, code.strip(), scope_clause, scope_params)
    if ot is None:
        return _user_error(f"OT {code} não encontrada", 404)
    lines = g.db.execute(
        text(
            """
            SELECT l.line_number, l.item_id, i.sku, i.item_name, l.quantity_ordered,
                   l.quantity_received, l.status
            FROM purchase_order_lines l JOIN items i ON i.item_id = l.item_id
            WHERE l.po_id = :po ORDER BY l.line_number
            """
        ),
        {"po": ot.po_id},
    ).fetchall()
    receipts = g.db.execute(
        text(
            """
            SELECT r.receipt_id, i.sku, r.quantity_received, b.bin_code, r.received_by,
                   r.received_at
            FROM item_receipts r
            JOIN items i ON i.item_id = r.item_id
            JOIN bins b ON b.bin_id = r.bin_id
            WHERE r.po_id = :po ORDER BY r.receipt_id
            """
        ),
        {"po": ot.po_id},
    ).fetchall()
    return jsonify({
        "ot": {
            "po_id": ot.po_id, "ot": ot.po_number, "order_type": ot.order_type,
            "status": ot.status, "warehouse_id": ot.warehouse_id,
            "origin": ot.vendor_name, "expected_date": _iso(ot.expected_date),
            "created_at": _iso(ot.created_at), "received_at": _iso(ot.received_at),
            "created_by": ot.created_by,
            # Label data (mig 083). None = pending.
            "barcode": ot.po_barcode,
            "origin_company": ot.vendor_name,
            "label_date": _iso(ot.label_date),
            "reservation_number": ot.reservation_number,
            "needed_date": _iso(ot.expected_date),
            "department": ot.department,
            "pickup_location": ot.pickup_location,
            "unload_location": ot.unload_location,
            "requester_name": ot.requester_name,
            "receiver_name": ot.receiver_name,
            "service_order_type": ot.order_type,
            "service_order_number": ot.service_order_number,
            "data_source": ot.data_source,
            "review_notes": ot.review_notes.split("\n") if ot.review_notes else [],
        },
        "lines": [
            {"line_number": r.line_number, "item_id": r.item_id, "sku": r.sku,
             "item_name": r.item_name, "quantity_ordered": r.quantity_ordered,
             "quantity_received": r.quantity_received, "status": r.status}
            for r in lines
        ],
        # One record per material, with lot, locations and movements.
        "materials": sea.ot_materials(g.db, ot),
        "movements": sea.ot_movements(g.db, ot),
        "receipts": [
            {"receipt_id": r.receipt_id, "sku": r.sku, "quantity": r.quantity_received,
             "bin_code": r.bin_code, "received_by": r.received_by,
             "received_at": _iso(r.received_at)}
            for r in receipts
        ],
        "stock": sea.ot_stock(g.db, ot),
        "withdrawals": _withdrawals(po_id=ot.po_id),
    })


@sea_bp.route("/ordens")
@require_auth
@require_any_page(*OT_PAGE_KEYS)
@with_db
def list_ordens():
    """The orders (PM11 / PM12) of a location, one row per order and OT."""
    warehouse_id, err = _warehouse_arg()
    if err:
        return err
    order_type = request.args.get("order_type") or None
    if order_type and order_type not in sea.OT_TYPES:
        return _user_error("order_type deve ser PM11 ou PM12", 400)
    return jsonify({"orders": sea.order_rows(
        g.db, warehouse_id, order_type=order_type,
        status=request.args.get("status") or None, q=request.args.get("q"),
    )})


@sea_bp.route("/ordens/<path:number>")
@require_auth
@require_any_page(*OT_PAGE_KEYS)
@with_db
def get_ordem(number):
    """Withdrawal terminal: the materials of a PM order available now,
    wherever they are stored. The employee who withdraws does not work in
    a location: the request goes to the stock keeper of the location that
    holds the material."""
    number = number.strip()
    found = sea.order_stock(g.db, number) if number else None
    if found is None:
        return _user_error(f"Ordem {number} não encontrada.", 404)
    return jsonify(found)


# ------------------------------------- Recebimento por etiqueta da OT

RECEIVING_PAGE_KEYS = ("receiving", "purchase-orders")


@sea_bp.route("/recebimentos/areas")
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@with_db
def areas_de_recebimento():
    """Receiving areas of a location, for the receiving screen. Whoever
    receives needs this list without the permission to manage addresses."""
    warehouse_id, err = _warehouse_arg()
    if err:
        return err
    rows = g.db.execute(
        text(
            """
            SELECT bin_id, bin_code, description FROM bins
            WHERE warehouse_id = :wid AND is_active = TRUE AND bin_type IN :staging
            ORDER BY bin_code
            """
        ).bindparams(bindparam("staging", expanding=True)),
        {"wid": warehouse_id, "staging": STAGING},
    ).fetchall()
    return jsonify({
        "bins": [{"bin_id": r.bin_id, "bin_code": r.bin_code, "description": r.description}
                 for r in rows],
    })


@sea_bp.route("/recebimentos/consulta")
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@with_db
def consultar_recebimento():
    """Step 2 of receiving: is this OT already registered?

    When it is not, the OT source (services.ot_source; by default the
    SAP base kept in the SEA) is asked. ``integration.data`` is the OT
    with its materials, or null when the code is not in the base.
    """
    code = (request.args.get("codigo") or "").strip()
    if not code or len(code) > 100:
        return _user_error("Informe o código da OT.", 400)
    scope_clause, scope_params = warehouse_scope_clause("warehouse_id")
    ot = sea.find_ot(g.db, code, scope_clause, scope_params)
    if ot is not None:
        return jsonify({"found": True, "ot": ot.po_number, "po_id": ot.po_id,
                        "status": ot.status, "integration": None})
    source = get_ot_source()
    data = source.lookup(g.db, code)
    return jsonify({
        "found": False, "ot": code,
        "integration": {"source": source.name, "data": data.to_dict() if data else None},
    })


@sea_bp.route("/etiquetas/interpretar", methods=["POST"])
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@validate_body(InterpretLabelRequest)
@with_db
def interpretar_etiqueta(validated):
    """Turn label text into structured fields. Writes nothing: the
    operator reviews and confirms through POST /recebimentos."""
    parsed = parse_label(validated.text).to_dict()
    existing = None
    code = parsed["header"]["ot_code"]
    if code:
        scope_clause, scope_params = warehouse_scope_clause("warehouse_id")
        ot = sea.find_ot(g.db, code, scope_clause, scope_params)
        if ot is not None:
            material = parsed["materials"][0]
            existing = {
                "ot": ot.po_number, "po_id": ot.po_id, "status": ot.status,
                "material": (
                    sea.material_conflict(g.db, ot.po_id, material["material_code"],
                                          material["lot_number"])
                    if material["material_code"] else None
                ),
            }
    return jsonify({**parsed, "existing": existing})


@sea_bp.route("/recebimentos", methods=["POST"])
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@validate_body(RegisterOtRequest)
@with_db
def registrar_recebimento(validated):
    """Create the OT (when new) and register each material on it."""
    ok, denied = check_warehouse_access(validated.warehouse_id)
    if not ok:
        return denied
    try:
        result = sea.register_ot_materials(
            g.db,
            warehouse_id=validated.warehouse_id,
            header=validated.header.model_dump(),
            materials=[m.model_dump() for m in validated.materials],
            username=g.current_user["username"],
            source=validated.source,
            unrecognized=validated.unrecognized,
        )
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc)
    g.db.commit()
    message = "OT cadastrada" if result["created"] else "Material adicionado à OT"
    return jsonify({"message": message, **result}), 201


@sea_bp.route("/recebimentos/base", methods=["POST"])
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@validate_body(RegisterFromBaseRequest)
@with_db
def registrar_recebimento_da_base(validated):
    """Register the delivery of an OT found in the SAP base. The data is
    read from the base here, never taken from the request."""
    ok, denied = check_warehouse_access(validated.warehouse_id)
    if not ok:
        return denied
    data = get_ot_source().lookup(g.db, validated.ot_code)
    if data is None:
        return _user_error(f"A OT {validated.ot_code} não está na base do SAP.", 404)
    if sea.find_ot(g.db, data.ot_code) is not None:
        return _user_error(f"A entrega da OT {data.ot_code} já foi registrada.", 409)
    payload = data.to_dict()
    try:
        result = sea.register_ot_materials(
            g.db,
            warehouse_id=validated.warehouse_id,
            header=payload["header"],
            materials=payload["materials"],
            username=g.current_user["username"],
            source="INTEGRACAO",
        )
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc)
    g.db.commit()
    return jsonify({"message": "Entrega da OT registrada", **result}), 201


# ------------------------------------------------------------ Base SAP

@sea_bp.route("/sap/base")
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS, "imports")
@with_db
def base_sap():
    """What the SAP base holds: totals and the OTs with their materials."""
    q = (request.args.get("q") or "").strip()[:100]
    return jsonify({
        "summary": sap_base.summary(g.db),
        "reservations": sap_base.list_reservations(g.db, q),
    })


CATALOG_PAGE = "material-catalog"
# Who reads the catalogue: who maintains it and who puts OTs together.
CATALOG_READ_KEYS = (CATALOG_PAGE, *RECEIVING_PAGE_KEYS)


def _catalog_change(fn, *args, message, status=200):
    try:
        result = fn(g.db, *args)
    except sap_base.CatalogError as exc:
        g.db.rollback()
        return _user_error(str(exc), exc.status)
    g.db.commit()
    return jsonify({"message": message, **(result or {})}), status


@sea_bp.route("/catalogo")
@require_auth
@require_any_page(*CATALOG_READ_KEYS)
@with_db
def listar_catalogo():
    page = max(1, request.args.get("page", 1, type=int))
    per_page = min(max(1, request.args.get("per_page", 50, type=int)), 200)
    q = (request.args.get("q") or "").strip()[:100]
    return jsonify(sap_base.list_materials(g.db, q, page, per_page))


@sea_bp.route("/catalogo/<path:code>")
@require_auth
@require_any_page(*CATALOG_READ_KEYS)
@with_db
def consultar_catalogo(code):
    """What a material code brings (description, unit, box weight)."""
    found = sap_base.find_material(g.db, code.strip())
    if found is None:
        return _user_error(f"Material {code} não encontrado no cadastro.", 404)
    return jsonify(found)


@sea_bp.route("/catalogo", methods=["POST"])
@require_auth
@require_admin_or_page_permission(CATALOG_PAGE)
@validate_body(CreateCatalogMaterialRequest)
@with_db
def criar_material_catalogo(validated):
    resp = _catalog_change(sap_base.create_material, validated.model_dump(),
                           message="Material cadastrado", status=201)
    return resp


@sea_bp.route("/catalogo/<path:code>", methods=["PUT"])
@require_auth
@require_admin_or_page_permission(CATALOG_PAGE)
@validate_body(UpdateCatalogMaterialRequest)
@with_db
def alterar_material_catalogo(code, validated):
    return _catalog_change(sap_base.update_material, code.strip(), validated.model_dump(),
                           message="Material atualizado")


@sea_bp.route("/catalogo/<path:code>", methods=["DELETE"])
@require_auth
@require_admin_or_page_permission(CATALOG_PAGE)
@with_db
def excluir_material_catalogo(code):
    return _catalog_change(sap_base.delete_material, code.strip(), message="Material excluído")


@sea_bp.route("/sap/ots", methods=["POST"])
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@validate_body(CreateBaseOtRequest)
@with_db
def criar_ot_na_base(validated):
    """Put an OT together in the SAP base (materials from the catalogue)."""
    return _catalog_change(sap_base.create_reservation, validated.model_dump(mode="json"),
                           message="OT criada na base do SAP", status=201)


@sea_bp.route("/push/registrar", methods=["POST"])
@require_auth
@validate_body(RegisterPushTokenRequest)
@with_db
def registrar_push(validated):
    """This device receives the SEA notifications of the logged-in user."""
    g.db.execute(
        text(
            """
            INSERT INTO sea_push_tokens (token, user_id) VALUES (:t, :u)
            ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = NOW()
            """
        ),
        {"t": validated.token, "u": g.current_user["user_id"]},
    )
    g.db.commit()
    return jsonify({"message": "Aparelho registrado"})


@sea_bp.route("/push/remover", methods=["POST"])
@require_auth
@validate_body(RegisterPushTokenRequest)
@with_db
def remover_push(validated):
    """Called on logout: the device stops receiving notifications."""
    g.db.execute(text("DELETE FROM sea_push_tokens WHERE token = :t AND user_id = :u"),
                 {"t": validated.token, "u": g.current_user["user_id"]})
    g.db.commit()
    return jsonify({"message": "Aparelho removido"})


@sea_bp.route("/sap/importar/<kind>", methods=["POST"])
@require_auth
@require_admin_or_page_permission("imports")
@with_db
def importar_base_sap(kind):
    if kind not in sap_base.IMPORT_KINDS:
        return _user_error("Tipo de importação desconhecido.", 400)
    data = request.get_json(silent=True)
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list) or not records:
        return _user_error("O arquivo não tem nenhuma linha para importar.", 400)
    if len(records) > sap_base.MAX_IMPORT_ROWS:
        return _user_error(
            f"Importação limitada a {sap_base.MAX_IMPORT_ROWS} linhas por arquivo.", 400
        )
    result = sap_base.import_rows(g.db, kind, records)
    write_audit_log(
        g.db, "SAP_BASE_IMPORTED", "SAP_BASE", 0, g.current_user["username"], None,
        details={"kind": kind, "imported": result["imported"], "skipped": result["skipped"]},
    )
    g.db.commit()
    return jsonify({"message": "Importação concluída", **result})


@sea_bp.route("/ots/<int:po_id>", methods=["DELETE"])
@require_auth
@require_role("ADMIN")
@with_db
def excluir_ot(po_id):
    """Delete an order with everything that belongs to it (administrator)."""
    try:
        result = sea.delete_ot(g.db, po_id, g.current_user["username"])
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc)
    g.db.commit()
    return jsonify({"message": "Ordem excluída", **result})


@sea_bp.route("/materiais/<int:item_id>", methods=["DELETE"])
@require_auth
@require_role("ADMIN")
@with_db
def excluir_material(item_id):
    """Delete a material everywhere it appears (administrator)."""
    try:
        result = sea.delete_material(g.db, item_id, g.current_user["username"])
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc)
    g.db.commit()
    return jsonify({"message": "Material excluído", **result})


def _ot_change(fn, *args, message):
    scope = warehouse_scope_clause("warehouse_id")
    try:
        result = fn(g.db, *args, g.current_user["username"], scope=scope)
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc)
    g.db.commit()
    return jsonify({"message": message, "changes": result})


@sea_bp.route("/ots/<int:po_id>/dados", methods=["PUT"])
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@validate_body(UpdateOtDataRequest)
@with_db
def corrigir_ot(po_id, validated):
    return _ot_change(sea.update_ot_data, po_id, validated.model_dump(exclude_unset=True),
                      message="Dados da OT atualizados")


@sea_bp.route("/ots/<int:po_id>/materiais/<int:po_line_id>", methods=["PUT"])
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@validate_body(UpdateOtMaterialRequest)
@with_db
def corrigir_material(po_id, po_line_id, validated):
    return _ot_change(sea.update_ot_material, po_id, po_line_id,
                      validated.model_dump(exclude_unset=True),
                      message="Material atualizado")


@sea_bp.route("/ots/<int:po_id>/materiais/<int:po_line_id>", methods=["DELETE"])
@require_auth
@require_any_page(*RECEIVING_PAGE_KEYS)
@with_db
def remover_material(po_id, po_line_id):
    return _ot_change(sea.remove_ot_material, po_id, po_line_id,
                      message="Material removido da OT")


# ------------------------------------------------- Armazenagem (SP12)

@sea_bp.route("/armazenagem/sugestao/<int:inventory_id>")
@require_auth
@require_any_page("putaway", "receiving")
@with_db
def sugestao(inventory_id):
    wh = g.db.execute(
        text("SELECT warehouse_id FROM inventory WHERE inventory_id = :id"), {"id": inventory_id}
    ).scalar()
    if wh is None:
        return _user_error("Registro de estoque não encontrado", 404)
    ok, denied = check_warehouse_access(wh)
    if not ok:
        return denied
    try:
        return jsonify(sea.suggest_storage(g.db, inventory_id=inventory_id,
                                           warehouse_ids=_user_warehouse_ids()))
    except sea.SeaError as exc:
        return _sea_error(exc)


TRANSFER_PAGE_KEYS = ("items", "inventory", "putaway")


@sea_bp.route("/materiais/<int:item_id>/estoque")
@require_auth
@require_any_page(*TRANSFER_PAGE_KEYS)
@with_db
def estoque_do_material(item_id):
    """Where a material is, address by address."""
    return jsonify({"stock": sea.item_stock(g.db, item_id, _user_warehouse_ids())})


@sea_bp.route("/transferencias", methods=["POST"])
@require_auth
@require_any_page(*TRANSFER_PAGE_KEYS)
@validate_body(TransferStockRequest)
@with_db
def transferir_estoque(validated):
    """Move stored material between addresses, in the same location or to
    another one."""
    try:
        result = sea.transfer_stock(
            g.db, inventory_id=validated.inventory_id, to_bin_id=validated.to_bin_id,
            quantity=validated.quantity, reason=validated.reason,
            username=g.current_user["username"], warehouse_ids=_user_warehouse_ids(),
        )
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc)
    g.db.commit()
    return jsonify({"message": "Transferência concluída", **result})


@sea_bp.route("/armazenagem/pendentes")
@require_auth
@require_any_page("putaway", "receiving")
@with_db
def pendentes_de_armazenagem():
    """What waits for storage in every location of the user, with the
    order of each material."""
    return jsonify({"pending_items": sea.pending_storage(g.db, _user_warehouse_ids())})


@sea_bp.route("/armazenagem/destinos")
@require_auth
@require_any_page("putaway", "receiving", *TRANSFER_PAGE_KEYS)
@with_db
def destinos():
    """Storage addresses of every location the user can use, for the
    put-away destination list (an order received in the Expedição is
    stored in the SP12 or in the Contêiner de Solda)."""
    scope_clause, scope_params = warehouse_scope_clause("b.warehouse_id")
    rows = g.db.execute(
        text(
            f"""
            SELECT b.bin_id, b.bin_code, b.description, b.size_class, b.capacity_units,
                   w.warehouse_id, w.warehouse_code, w.warehouse_name
            FROM bins b JOIN warehouses w ON w.warehouse_id = b.warehouse_id
            WHERE b.is_active = TRUE AND w.is_active = TRUE
              AND b.bin_type NOT IN :staging {scope_clause}
            ORDER BY w.warehouse_id, b.putaway_sequence, b.bin_code
            """
        ).bindparams(bindparam("staging", expanding=True)),
        {"staging": STAGING, **scope_params},
    ).fetchall()
    return jsonify({
        "bins": [
            {"bin_id": r.bin_id, "bin_code": r.bin_code, "description": r.description,
             "size_class": r.size_class, "capacity_units": r.capacity_units,
             "warehouse_id": r.warehouse_id, "warehouse_code": r.warehouse_code,
             "warehouse_name": r.warehouse_name}
            for r in rows
        ],
    })


@sea_bp.route("/armazenagem/sugestao")
@require_auth
@require_any_page("putaway", "receiving")
@with_db
def sugestao_por_material():
    """Same suggestion keyed by (item_id, staging bin_id, lot) for the
    mobile app, whose put-away queue does not carry inventory_id."""
    item_id = request.args.get("item_id", type=int)
    bin_id = request.args.get("bin_id", type=int)
    lot = request.args.get("lot") or None
    if not item_id or not bin_id:
        return _user_error("item_id e bin_id são obrigatórios", 400)
    inv = g.db.execute(
        text(
            """
            SELECT inventory_id, warehouse_id FROM inventory
            WHERE item_id = :i AND bin_id = :b AND lot_number IS NOT DISTINCT FROM :l
            """
        ),
        {"i": item_id, "b": bin_id, "l": lot},
    ).fetchone()
    if inv is None:
        return _user_error("Registro de estoque não encontrado", 404)
    ok, denied = check_warehouse_access(inv.warehouse_id)
    if not ok:
        return denied
    try:
        return jsonify(sea.suggest_storage(g.db, inventory_id=inv.inventory_id,
                                           warehouse_ids=_user_warehouse_ids()))
    except sea.SeaError as exc:
        return _sea_error(exc)


# ---------------------------------------------------------- Retiradas

def _withdrawals(*, warehouse_id=None, status=None, po_id=None, withdrawal_id=None, limit=200,
                 scoped=False):
    where = ["TRUE"]
    params = {"limit": limit}
    if scoped:
        scope_clause, scope_params = warehouse_scope_clause("w.warehouse_id")
        where.append("TRUE " + scope_clause)
        params.update(scope_params)
    if warehouse_id:
        where.append("w.warehouse_id = :wid")
        params["wid"] = warehouse_id
    if withdrawal_id:
        where.append("w.withdrawal_id = :wdid")
        params["wdid"] = withdrawal_id
    if status:
        where.append("w.status = ANY(:statuses)")
        params["statuses"] = status
    if po_id:
        where.append("w.po_id = :po")
        params["po"] = po_id
    rows = g.db.execute(
        text(
            f"""
            SELECT w.*, p.po_number, p.order_type, p.service_order_number,
                   u.full_name AS delivered_to_name,
                   r.full_name AS requested_by_name, r.email AS requested_by_email,
                   sw.warehouse_code
            FROM withdrawals w
            JOIN purchase_orders p ON p.po_id = w.po_id
            JOIN warehouses sw ON sw.warehouse_id = w.warehouse_id
            LEFT JOIN users u ON u.user_id = w.delivered_to_user_id
            LEFT JOIN users r ON r.username = w.requested_by
            WHERE {' AND '.join(where)}
            ORDER BY w.withdrawal_id DESC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    ids = [r.withdrawal_id for r in rows]
    lines = {}
    if ids:
        for ln in g.db.execute(
            text(
                """
                SELECT wl.withdrawal_id, wl.inventory_id, wl.quantity, i.sku, i.item_name,
                       i.uom, i.pack_weight_kg, b.bin_code,
                       COALESCE(ol.service_order_number, op.service_order_number, op.po_number)
                           AS order_number,
                       COALESCE(ol.service_order_type, op.order_type) AS order_type
                FROM withdrawal_lines wl
                JOIN items i ON i.item_id = wl.item_id
                JOIN bins b ON b.bin_id = wl.bin_id
                JOIN withdrawals wd ON wd.withdrawal_id = wl.withdrawal_id
                JOIN purchase_orders op ON op.po_id = wd.po_id
                LEFT JOIN purchase_order_lines ol
                  ON ol.po_id = op.po_id AND ol.item_id = wl.item_id
                WHERE wl.withdrawal_id = ANY(:ids)
                ORDER BY b.bin_code, i.sku
                """
            ),
            {"ids": ids},
        ).fetchall():
            lines.setdefault(ln.withdrawal_id, []).append({
                "inventory_id": ln.inventory_id, "sku": ln.sku, "item_name": ln.item_name,
                "bin_code": ln.bin_code, "quantity": ln.quantity, "uom": ln.uom,
                "order_number": ln.order_number, "order_type": ln.order_type,
                "pack_weight_kg": sea.pack_weight(ln.uom, ln.pack_weight_kg),
            })
    return [
        {
            "withdrawal_id": r.withdrawal_id, "ot": r.po_number, "order_type": r.order_type,
            "service_order_number": r.service_order_number,
            "warehouse_id": r.warehouse_id, "warehouse_code": r.warehouse_code,
            "status": r.status, "requested_by": r.requested_by,
            "requested_by_name": r.requested_by_name, "requested_by_email": r.requested_by_email,
            "requested_at": _iso(r.requested_at), "requester_note": r.requester_note,
            "picked_by": r.picked_by, "picking_started_at": _iso(r.picking_started_at),
            "ready_at": _iso(r.ready_at), "delivered_to": r.delivered_to_name,
            "delivered_at": _iso(r.delivered_at),
            "confirmed_by": r.confirmed_by, "cancelled_by": r.cancelled_by,
            "cancelled_at": _iso(r.cancelled_at), "cancel_reason": r.cancel_reason,
            "lines": lines.get(r.withdrawal_id, []),
            # The order(s) of the materials requested, e.g. ["PM12 2002349234"].
            "orders": sorted({
                " ".join(x for x in (ln["order_type"], ln["order_number"]) if x)
                for ln in lines.get(r.withdrawal_id, []) if ln["order_number"]
            }),
        }
        for r in rows
    ]


@sea_bp.route("/retiradas")
@require_auth
@require_admin_or_page_permission("retirada")
@with_db
def list_retiradas():
    """Withdrawals of one location (?warehouse_id=) or, without it, of
    every location the user works in: the stock keeper sees a request
    whatever location is selected in the top bar."""
    warehouse_id = request.args.get("warehouse_id", type=int)
    if warehouse_id:
        ok, denied = check_warehouse_access(warehouse_id)
        if not ok:
            return denied
    raw = request.args.get("status")
    statuses = [s for s in raw.split(",") if s] if raw else None
    return jsonify({
        "withdrawals": _withdrawals(warehouse_id=warehouse_id, status=statuses, scoped=True),
    })


@sea_bp.route("/retiradas/<int:withdrawal_id>")
@require_auth
@require_admin_or_page_permission("retirada")
@with_db
def get_retirada(withdrawal_id):
    """One withdrawal, whatever its status (the terminal follows its own
    request with this)."""
    scope_clause, scope_params = _withdrawal_scope(withdrawal_id)
    wh = g.db.execute(
        text(f"SELECT w.warehouse_id FROM withdrawals w WHERE w.withdrawal_id = :id {scope_clause}"),
        {"id": withdrawal_id, **(scope_params or {})},
    ).scalar()
    if wh is None:
        return _user_error("Retirada não encontrada", 404)
    return jsonify({"withdrawal": _withdrawals(warehouse_id=wh, withdrawal_id=withdrawal_id)[0]})


@sea_bp.route("/retiradas", methods=["POST"])
@require_auth
@require_admin_or_page_permission("retirada")
@validate_body(CreateWithdrawalRequest)
@with_db
def create_retirada(validated):
    # Not limited to the requester's locations (see get_ordem): the
    # withdrawal belongs to the location where the material is stored.
    ot = sea.find_ot(g.db, validated.ot.strip())
    if ot is None:
        return _user_error(f"OT {validated.ot} não encontrada", 404)
    try:
        withdrawal_id = sea.create_withdrawal(
            g.db, ot=ot, lines=[ln.model_dump() for ln in validated.lines],
            username=g.current_user["username"], note=validated.note,
        )
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc)
    g.db.commit()
    notifications.dispatch(g.db)
    return jsonify({
        "message": "Retirada solicitada",
        "withdrawal": _withdrawals(withdrawal_id=withdrawal_id)[0],
    }), 201


def _withdrawal_scope(withdrawal_id):
    """Who may act on a withdrawal: its requester, wherever the material
    is, and otherwise the users of the location that holds it."""
    requested_by = g.db.execute(
        text("SELECT requested_by FROM withdrawals WHERE withdrawal_id = :id"),
        {"id": withdrawal_id},
    ).scalar()
    if requested_by is not None and requested_by == g.current_user["username"]:
        return "", None
    return warehouse_scope_clause("w.warehouse_id")


def _transition(withdrawal_id, fn, *args, message, own=False):
    # ``own``: steps the requester takes on their own request (confirm,
    # cancel). Separating is always the work of the location's users.
    scope = _withdrawal_scope(withdrawal_id) if own else warehouse_scope_clause("w.warehouse_id")
    try:
        result = fn(g.db, withdrawal_id, *args, scope=scope)
    except sea.SeaError as exc:
        g.db.rollback()
        return _sea_error(exc), None
    g.db.commit()
    wh = g.db.execute(
        text("SELECT warehouse_id FROM withdrawals WHERE withdrawal_id = :id"),
        {"id": withdrawal_id},
    ).scalar()
    current = _withdrawals(warehouse_id=wh, withdrawal_id=withdrawal_id)
    return jsonify({"message": message, "withdrawal": current[0] if current else None}), result


@sea_bp.route("/retiradas/<int:withdrawal_id>/separar", methods=["POST"])
@require_auth
@require_admin_or_page_permission("retirada")
@with_db
def separar(withdrawal_id):
    resp, _ = _transition(withdrawal_id, sea.start_picking, g.current_user["username"],
                          message="Separação iniciada")
    return resp


@sea_bp.route("/retiradas/<int:withdrawal_id>/pronta", methods=["POST"])
@require_auth
@require_admin_or_page_permission("retirada")
@with_db
def pronta(withdrawal_id):
    resp, _ = _transition(withdrawal_id, sea.mark_ready, g.current_user["username"],
                          message="Retirada pronta para entrega")
    return resp


@sea_bp.route("/retiradas/<int:withdrawal_id>/entregar", methods=["POST"])
@require_auth
@require_admin_or_page_permission("retirada")
@with_db
def entregar(withdrawal_id):
    """The logged-in employee confirms they received what they requested."""
    resp, _ = _transition(withdrawal_id, sea.deliver, g.current_user["user_id"],
                          message="Entrega confirmada e baixa realizada", own=True)
    return resp


@sea_bp.route("/retiradas/<int:withdrawal_id>/cancelar", methods=["POST"])
@require_auth
@require_admin_or_page_permission("retirada")
@validate_body(CancelWithdrawalRequest)
@with_db
def cancelar(withdrawal_id, validated):
    resp, _ = _transition(withdrawal_id, sea.cancel, g.current_user["username"],
                          validated.reason, message="Retirada cancelada", own=True)
    return resp
