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
                   ri.quantity, COALESCE(ri.uom, m.uom) AS uom, ri.lot_number,
                   m.pack_weight_kg
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
                quantity=i.quantity, uom=i.uom, lot_number=i.lot_number,
                # mig 098: the box weight of the catalogue goes with the material.
                pack_weight_kg=i.pack_weight_kg,
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
                 "quantity": i.quantity, "uom": i.uom, "lot_number": i.lot_number}
                for i in _items(db, h.ot_number)
            ],
        })
    return result


# ------------------------------------------------- Cadastro de materiais
#
# sap_materials is the material catalogue: what the code of a material
# brings (description, unit, box weight) when an OT is put together. It
# is maintained in Sistema > Cadastro de materiais.

class CatalogError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def _material_dict(row) -> dict[str, object]:
    return {"material_code": row.material_code, "description": row.description,
            "uom": row.uom, "pack_weight_kg": row.pack_weight_kg}


def list_materials(db, q: str = "", page: int = 1, per_page: int = 50) -> dict[str, object]:
    params: dict[str, object] = {"limit": per_page, "offset": (page - 1) * per_page}
    where = ""
    if q:
        where = "WHERE material_code ILIKE :q OR description ILIKE :q"
        params["q"] = f"%{q}%"
    total = db.execute(text(f"SELECT COUNT(*) FROM sap_materials {where}"), params).scalar()
    rows = db.execute(
        text(
            f"""
            SELECT material_code, description, uom, pack_weight_kg FROM sap_materials
            {where} ORDER BY material_code LIMIT :limit OFFSET :offset
            """
        ),
        params,
    ).fetchall()
    return {"materials": [_material_dict(r) for r in rows], "total": total, "page": page,
            "per_page": per_page, "pages": max(1, -(-total // per_page))}


def find_material(db, code: str) -> dict[str, object] | None:
    """What a material code brings: the catalogue entry or, failing that,
    a material already registered in the SEA (``source`` says which)."""
    row = db.execute(
        text("SELECT material_code, description, uom, pack_weight_kg FROM sap_materials "
             "WHERE material_code = :c"),
        {"c": code},
    ).fetchone()
    if row is not None:
        return {**_material_dict(row), "source": "cadastro"}
    row = db.execute(
        text("SELECT sku AS material_code, item_name AS description, uom, pack_weight_kg "
             "FROM items WHERE sku = :c"),
        {"c": code},
    ).fetchone()
    return {**_material_dict(row), "source": "estoque"} if row is not None else None


def _clean_material(data: dict) -> dict[str, object]:
    uom = (data.get("uom") or "").strip().upper() or None
    pack = data.get("pack_weight_kg")
    # The box weight only applies to a material kept in KG.
    return {"description": data["description"].strip(), "uom": uom,
            "pack_weight_kg": pack if uom == "KG" else None}


def _sync_stock_material(db, code: str, clean: dict) -> None:
    """mig 098: the material in stock follows the catalogue: the box
    weight (KG por caixa) and the unit are what the withdrawal reads."""
    db.execute(
        text("UPDATE items SET pack_weight_kg = :pack_weight_kg, uom = COALESCE(:uom, uom) "
             "WHERE sku = :c"),
        {"c": code, "pack_weight_kg": clean["pack_weight_kg"], "uom": clean["uom"]},
    )


def create_material(db, data: dict) -> dict[str, object]:
    code = data["material_code"].strip()
    if db.execute(text("SELECT 1 FROM sap_materials WHERE material_code = :c"),
                  {"c": code}).fetchone():
        raise CatalogError(f"O material {code} já está no cadastro.")
    db.execute(
        text("INSERT INTO sap_materials (material_code, description, uom, pack_weight_kg) "
             "VALUES (:c, :description, :uom, :pack_weight_kg)"),
        {"c": code, **_clean_material(data)},
    )
    _sync_stock_material(db, code, _clean_material(data))
    return {"material_code": code, **_clean_material(data)}


def update_material(db, code: str, data: dict) -> dict[str, object]:
    updated = db.execute(
        text(
            """
            UPDATE sap_materials
            SET description = :description, uom = :uom, pack_weight_kg = :pack_weight_kg,
                updated_at = NOW()
            WHERE material_code = :c RETURNING material_code
            """
        ),
        {"c": code, **_clean_material(data)},
    ).fetchone()
    if updated is None:
        raise CatalogError(f"O material {code} não está no cadastro.", status=404)
    _sync_stock_material(db, code, _clean_material(data))
    return {"material_code": code, **_clean_material(data)}


def delete_material(db, code: str) -> None:
    if db.execute(text("SELECT 1 FROM sap_materials WHERE material_code = :c"),
                  {"c": code}).fetchone() is None:
        raise CatalogError(f"O material {code} não está no cadastro.", status=404)
    used = db.execute(
        text("SELECT string_agg(DISTINCT ot_number, ', ') FROM sap_reservation_items "
             "WHERE material_code = :c"),
        {"c": code},
    ).scalar()
    if used:
        raise CatalogError(
            f"O material {code} está em OT(s) da base do SAP ({used}) e não pode ser excluído."
        )
    db.execute(text("DELETE FROM sap_materials WHERE material_code = :c"), {"c": code})


def create_reservation(db, data: dict) -> dict[str, object]:
    """Put together an OT in the base by hand: header plus materials, each
    with its order. The materials come from the catalogue; an order that
    is not in the base yet is added with the type informed."""
    ot = data["ot_number"].strip()
    if db.execute(text("SELECT 1 FROM sap_reservations WHERE ot_number = :ot"),
                  {"ot": ot}).fetchone():
        raise CatalogError(f"A OT {ot} já está na base do SAP.")
    if db.execute(text("SELECT 1 FROM purchase_orders WHERE po_number = :ot OR po_barcode = :ot"),
                  {"ot": ot}).fetchone():
        raise CatalogError(f"A OT {ot} já foi registrada no SEA.")
    codes = [m["material_code"].strip() for m in data["materials"]]
    if len(set(codes)) != len(codes):
        raise CatalogError("O mesmo material aparece mais de uma vez na OT.", status=400)

    db.execute(
        text(
            f"""
            INSERT INTO sap_reservations (ot_number, {', '.join(_HEADER_FIELDS)})
            VALUES (:ot, {', '.join(':' + f for f in _HEADER_FIELDS)})
            """
        ),
        {"ot": ot, **{f: data.get(f) for f in _HEADER_FIELDS}},
    )
    for m in data["materials"]:
        code = m["material_code"].strip()
        order = m["order_number"].strip()
        material = db.execute(
            text("SELECT uom FROM sap_materials WHERE material_code = :c"), {"c": code}
        ).fetchone()
        if material is None:
            raise CatalogError(
                f"O material {code} não está no cadastro de materiais. "
                "Cadastre-o em Sistema > Cadastro de materiais.",
                status=400,
            )
        known = db.execute(
            text("SELECT order_type FROM sap_orders WHERE order_number = :n"), {"n": order}
        ).fetchone()
        if known is None:
            db.execute(
                text("INSERT INTO sap_orders (order_number, order_type) VALUES (:n, :t)"),
                {"n": order, "t": m["order_type"]},
            )
        elif known.order_type != m["order_type"]:
            raise CatalogError(
                f"A ordem {order} está na base como {known.order_type}, não {m['order_type']}.",
                status=400,
            )
        db.execute(
            text(
                """
                INSERT INTO sap_reservation_items
                    (ot_number, order_number, material_code, quantity, uom)
                VALUES (:ot, :n, :c, :q, :u)
                """
            ),
            {"ot": ot, "n": order, "c": code, "q": m["quantity"],
             "u": (m.get("uom") or "").strip().upper() or None},
        )
    return {"ot": ot, "materials": len(codes)}


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
    saved = db.execute(
        text(
            """
            INSERT INTO sap_materials (material_code, description, uom, pack_weight_kg)
            VALUES (:c, :d, :u, :p)
            ON CONFLICT (material_code) DO UPDATE
            SET description = EXCLUDED.description, uom = EXCLUDED.uom,
                -- a sheet without the column keeps the box weight already set
                pack_weight_kg = COALESCE(EXCLUDED.pack_weight_kg, sap_materials.pack_weight_kg),
                updated_at = NOW()
            RETURNING uom, pack_weight_kg
            """
        ),
        {"c": row.material_code, "d": row.description, "u": row.uom,
         "p": row.pack_weight_kg if (row.uom or "").strip().upper() == "KG" else None},
    ).fetchone()
    # A box weight known for a material kept in KG reaches the stock; a
    # sheet without it leaves the stock as it is.
    if saved.pack_weight_kg and (saved.uom or "").strip().upper() == "KG":
        _sync_stock_material(db, row.material_code,
                             {"uom": saved.uom, "pack_weight_kg": saved.pack_weight_kg})


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
            INSERT INTO sap_reservation_items
                (ot_number, order_number, material_code, quantity, uom, lot_number)
            VALUES (:ot, :n, :c, :q, :u, :lot)
            ON CONFLICT (ot_number, material_code) DO UPDATE
            SET quantity = EXCLUDED.quantity, uom = EXCLUDED.uom,
                lot_number = EXCLUDED.lot_number
            """
        ),
        {"ot": row.ot_number, "n": row.order_number, "c": row.material_code,
         "q": row.quantity, "u": row.uom, "lot": row.lot_number},
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
