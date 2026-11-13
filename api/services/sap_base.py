"""SAP base: the mirror of SAP data kept inside the SEA (mig 085).

Three data sets come from SAP: orders (PM11 / PM12), materials and the
open OTs / reservations with their materials. Receiving reads the OT
barcode and looks it up here; what is found goes through the same
registration as a label (sea_service.register_ot_materials).

The base is loaded by import today and by the SAP integration later.
Operation never writes to it.
"""

from __future__ import annotations

from pydantic import ValidationError
from sqlalchemy import text

from schemas.sap_base import SapMaterialRow, SapOrderRow, SapReservationRow
from services.ot_source import OtData, OtMaterialData

IMPORT_KINDS = ("ordens", "materiais", "reservas")
MAX_IMPORT_ROWS = 5000

_HEADER_FIELDS = (
    "reservation_number", "requester_name", "needed_date", "department",
    "pickup_location", "unload_location",
)


def _items(db, ot_number: str):
    return db.execute(
        text(
            """
            SELECT ri.order_number, o.order_type, ri.material_code, m.description,
                   ri.quantity, COALESCE(ri.uom, m.uom) AS uom
            FROM sap_reservation_items ri
            JOIN sap_orders o ON o.order_number = ri.order_number
            JOIN sap_materials m ON m.material_code = ri.material_code
            WHERE ri.ot_number = :ot
            ORDER BY ri.order_number, ri.material_code
            """
        ),
        {"ot": ot_number},
    ).fetchall()


def lookup(db, ot_code: str) -> OtData | None:
    """The OT as the SAP base knows it, with every material and the
    order each one belongs to; None when the code is not in the base."""
    head = db.execute(
        text(
            """
            SELECT ot_number, reservation_number, requester_name, needed_date,
                   department, pickup_location, unload_location
            FROM sap_reservations WHERE ot_number = :ot
            """
        ),
        {"ot": ot_code},
    ).fetchone()
    if head is None:
        return None
    items = _items(db, head.ot_number)
    if not items:
        return None
    orders = {(i.order_type, i.order_number) for i in items}
    return OtData(
        ot_code=head.ot_number,
        barcode=head.ot_number,
        reservation_number=head.reservation_number,
        needed_date=head.needed_date.isoformat() if head.needed_date else None,
        department=head.department,
        pickup_location=head.pickup_location,
        unload_location=head.unload_location,
        requester_name=head.requester_name,
        # The OT keeps one type on its header; each material carries its
        # own order. The order number goes on the header only when the
        # whole OT belongs to a single order.
        service_order_type=items[0].order_type,
        service_order_number=items[0].order_number if len(orders) == 1 else None,
        materials=tuple(
            OtMaterialData(
                material_code=i.material_code, description=i.description,
                quantity=i.quantity, uom=i.uom,
                service_order_type=i.order_type, service_order_number=i.order_number,
            )
            for i in items
        ),
    )


def summary(db) -> dict[str, int]:
    row = db.execute(
        text(
            """
            SELECT (SELECT COUNT(*) FROM sap_orders) AS orders,
                   (SELECT COUNT(*) FROM sap_materials) AS materials,
                   (SELECT COUNT(*) FROM sap_reservations) AS reservations
            """
        )
    ).fetchone()
    return {"orders": row.orders, "materials": row.materials, "reservations": row.reservations}


def list_reservations(db, q: str = "", limit: int = 200) -> list[dict]:
    """OTs of the base with their materials. ``registered`` tells whether
    the SEA already registered the delivery of that OT."""
    params: dict[str, object] = {"limit": limit}
    where = ""
    if q:
        where = """
            WHERE r.ot_number ILIKE :q OR r.reservation_number ILIKE :q
               OR r.requester_name ILIKE :q
               OR EXISTS (SELECT 1 FROM sap_reservation_items x
                          WHERE x.ot_number = r.ot_number
                            AND (x.order_number ILIKE :q OR x.material_code ILIKE :q))
        """
        params["q"] = f"%{q}%"
    heads = db.execute(
        text(
            f"""
            SELECT r.ot_number, r.reservation_number, r.requester_name, r.needed_date,
                   r.department,
                   EXISTS (SELECT 1 FROM purchase_orders p
                           WHERE p.po_number = r.ot_number) AS registered
            FROM sap_reservations r
            {where}
            ORDER BY registered, r.ot_number
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    result = []
    for h in heads:
        result.append({
            "ot": h.ot_number, "reservation_number": h.reservation_number,
            "requester_name": h.requester_name,
            "needed_date": h.needed_date.isoformat() if h.needed_date else None,
            "department": h.department, "registered": h.registered,
            "materials": [
                {"service_order_number": i.order_number, "service_order_type": i.order_type,
                 "material_code": i.material_code, "description": i.description,
                 "quantity": i.quantity, "uom": i.uom}
                for i in _items(db, h.ot_number)
            ],
        })
    return result


# ------------------------------------------------------------- Import

class _RowError(Exception):
    pass


def _import_order(db, row: SapOrderRow) -> None:
    db.execute(
        text(
            """
            INSERT INTO sap_orders (order_number, order_type, description)
            VALUES (:n, :t, :d)
            ON CONFLICT (order_number) DO UPDATE
            SET order_type = EXCLUDED.order_type, description = EXCLUDED.description,
                updated_at = NOW()
            """
        ),
        {"n": row.order_number, "t": row.order_type, "d": row.description},
    )


def _import_material(db, row: SapMaterialRow) -> None:
    db.execute(
        text(
            """
            INSERT INTO sap_materials (material_code, description, uom)
            VALUES (:c, :d, :u)
            ON CONFLICT (material_code) DO UPDATE
            SET description = EXCLUDED.description, uom = EXCLUDED.uom, updated_at = NOW()
            """
        ),
        {"c": row.material_code, "d": row.description, "u": row.uom},
    )


def _import_reservation(db, row: SapReservationRow) -> None:
    if db.execute(text("SELECT 1 FROM sap_orders WHERE order_number = :n"),
                  {"n": row.order_number}).fetchone() is None:
        raise _RowError(f"A ordem {row.order_number} não está na base. Importe as ordens antes.")
    if db.execute(text("SELECT 1 FROM sap_materials WHERE material_code = :c"),
                  {"c": row.material_code}).fetchone() is None:
        raise _RowError(
            f"O material {row.material_code} não está na base. Importe os materiais antes."
        )
    other = db.execute(
        text(
            "SELECT order_number FROM sap_reservation_items "
            "WHERE ot_number = :ot AND material_code = :c AND order_number <> :n"
        ),
        {"ot": row.ot_number, "c": row.material_code, "n": row.order_number},
    ).scalar()
    if other:
        raise _RowError(
            f"O material {row.material_code} já está na OT {row.ot_number} pela ordem {other}. "
            "O SEA mantém um registro por material em cada OT."
        )
    header = {f: getattr(row, f) for f in _HEADER_FIELDS}
    # A blank header cell on a later row keeps what an earlier row informed.
    db.execute(
        text(
            f"""
            INSERT INTO sap_reservations (ot_number, {', '.join(_HEADER_FIELDS)})
            VALUES (:ot, {', '.join(':' + f for f in _HEADER_FIELDS)})
            ON CONFLICT (ot_number) DO UPDATE
            SET {', '.join(f'{f} = COALESCE(EXCLUDED.{f}, sap_reservations.{f})'
                           for f in _HEADER_FIELDS)},
                updated_at = NOW()
            """
        ),
        {"ot": row.ot_number, **header},
    )
    db.execute(
        text(
            """
            INSERT INTO sap_reservation_items (ot_number, order_number, material_code, quantity, uom)
            VALUES (:ot, :n, :c, :q, :u)
            ON CONFLICT (ot_number, material_code) DO UPDATE
            SET quantity = EXCLUDED.quantity, uom = EXCLUDED.uom
            """
        ),
        {"ot": row.ot_number, "n": row.order_number, "c": row.material_code,
         "q": row.quantity, "u": row.uom},
    )


_IMPORTERS = {
    "ordens": (SapOrderRow, _import_order),
    "materiais": (SapMaterialRow, _import_material),
    "reservas": (SapReservationRow, _import_reservation),
}


def import_rows(db, kind: str, records: list) -> dict[str, object]:
    """Load ``records`` into the base. A row already in the base is
    updated; a bad row is reported and the others still go in."""
    schema, importer = _IMPORTERS[kind]
    imported, errors = 0, []
    for idx, rec in enumerate(records, 1):
        try:
            row = schema(**(rec if isinstance(rec, dict) else {}))
        except ValidationError as exc:
            first = exc.errors()[0]
            column = ".".join(str(p) for p in first.get("loc", ()))
            errors.append({"row": idx, "error": f"coluna {column}: valor ausente ou inválido"})
            continue
        try:
            importer(db, row)
        except _RowError as exc:
            errors.append({"row": idx, "error": str(exc)})
            continue
        imported += 1
    return {"total": len(records), "imported": imported, "skipped": len(errors),
            "errors": errors}
