"""Regras de negócio do SEA para as OTs (purchase_orders com order_type PM11/PM12). O estoque
recebido de uma OT leva o número dela como lote.
1. Armazenagem: prateleiras livres. Qualquer material vai para qualquer endereço de armazenagem;
só área de recebimento e endereço desligado são recusados.
2. Retirada: pedido reserva estoque (quantity_allocated); a entrega, confirmada por quem pediu,
dá a baixa (quantity_on_hand). Nada é apagado. Toda transição trava as linhas e confere o status
atual, então clique duplo, repetição ou dois terminais ao mesmo tempo nunca baixam duas vezes nem
deixam o estoque negativo.
O estoque de uma ordem é achado pelo lote em qualquer local: a ordem recebida no Recebimento pode
estar guardada no SP12 ou no SP13.
As funções lançam SeaError; quem chama faz o commit.
"""

import uuid

from constants import BIN_PICKABLE_STAGING, BIN_STAGING
from sqlalchemy import bindparam, text

from services import notification_service as notifications
from services.audit_service import write_audit_log
from services.inventory_service import move_inventory

OT_TYPES = ("PM11", "PM12")
STAGING_TYPES = (BIN_STAGING, BIN_PICKABLE_STAGING)

# REQUESTED espera o avaliador; APPROVED espera alguém aceitar (PICKING); REJECTED = negada.
W_REQUESTED = "REQUESTED"
W_APPROVED = "APPROVED"
W_PICKING = "PICKING"
W_READY = "READY"
W_DELIVERED = "DELIVERED"
W_REJECTED = "REJECTED"
W_CANCELLED = "CANCELLED"
W_OPEN_STATUSES = (W_REQUESTED, W_APPROVED, W_PICKING, W_READY)

ACTION_WITHDRAWAL_REQUESTED = "WITHDRAWAL_REQUESTED"
ACTION_WITHDRAWAL_APPROVED = "WITHDRAWAL_APPROVED"
ACTION_WITHDRAWAL_REJECTED = "WITHDRAWAL_REJECTED"
ACTION_WITHDRAWAL_PICKING = "WITHDRAWAL_PICKING"
ACTION_WITHDRAWAL_READY = "WITHDRAWAL_READY"
ACTION_WITHDRAWAL_DELIVERED = "WITHDRAWAL_DELIVERED"
ACTION_WITHDRAWAL_CANCELLED = "WITHDRAWAL_CANCELLED"


UOM_KG = "KG"


def pack_weight(uom, pack_weight_kg):
    """Peso de uma caixa quando o material sai por caixa (unidade KG com peso definido). None = sai
    de unidade em unidade.
    """
    if pack_weight_kg and (uom or "").strip().upper() == UOM_KG:
        return int(pack_weight_kg)
    return None


# A operação fala em ordem (PM11/PM12); a OT é o documento com que o material chegou. O estoque leva
# a OT como lote, então a ordem dele é a do material naquela OT.
ORDER_OF_STOCK_JOIN = """
    LEFT JOIN purchase_orders op
      ON op.po_number = inv.lot_number AND op.order_type IS NOT NULL
    LEFT JOIN purchase_order_lines ol
      ON ol.po_id = op.po_id AND ol.item_id = inv.item_id
"""
ORDER_OF_STOCK_COLUMNS = """
    COALESCE(ol.service_order_number, op.service_order_number, op.po_number) AS order_number,
    COALESCE(ol.service_order_type, op.order_type) AS order_type
"""


class SeaError(Exception):
    """Violação de regra de negócio. ``status`` é o código HTTP da resposta."""

    def __init__(self, message, status=409, **context):
        super().__init__(message)
        self.status = status
        self.context = context


# --- OTs

def find_ot(db, code, scope_clause="", scope_params=None):
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
    """O lote identifica a ordem em qualquer local (po_number é único)."""
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


# --- Recebimento pela etiqueta
# A OT vira um purchase_orders e cada material um purchase_order_lines. A mesma função atende dados
# digitados, lidos da etiqueta ou vindos da fonte de OTs.

ACTION_OT_REGISTERED = "OT_REGISTERED"
ACTION_OT_MATERIAL_ADDED = "OT_MATERIAL_ADDED"
ACTION_OT_DATA_EDITED = "OT_DATA_EDITED"
ACTION_OT_MATERIAL_EDITED = "OT_MATERIAL_EDITED"
ACTION_OT_MATERIAL_REMOVED = "OT_MATERIAL_REMOVED"

PO_LOCKED_STATUSES = ("CLOSED", "ARCHIVED")

# Os nomes de coluna só vêm desta constante, nunca da requisição.
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
    "pack_weight_kg": "KG por caixa",
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
    """Recusa pedidos comuns e OTs fechadas."""
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
    """'NOVO', 'DUPLICADO' (mesmo material e lote) ou 'LOTE_DIFERENTE'."""
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
    """Registra uma etiqueta: cria a OT se for nova e adiciona cada material.
    O recebedor nunca vem de quem chama: é o usuário que registra a entrega.
    Nada é sobrescrito. Campos vazios do cabeçalho são preenchidos; um valor que diverge do
    cadastrado é devolvido e anotado na OT para revisão. Material que já está na OT é recusado
    antes de gravar qualquer coisa, então a mesma etiqueta nunca entra duas vezes.
    """
    code = header["ot_code"]
    header = {**header, "receiver_name": None}
    codes = [m["material_code"] for m in materials]
    if len(set(codes)) != len(codes):
        raise SeaError("O mesmo material aparece mais de uma vez no cadastro.", status=400)

    # Dois operadores lendo etiquetas da mesma OT nova: o segundo espera aqui e encontra a OT criada
    # pelo primeiro.
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
        find_item = text(
            "SELECT item_id, item_name, uom, pack_weight_kg FROM items WHERE sku = :sku")
        item = db.execute(find_item, {"sku": sku}).fetchone()
        pack = pack_weight(m.get("uom"), m.get("pack_weight_kg"))
        item_id = None
        if item is None:
            if not m.get("description"):
                raise SeaError(
                    f"Informe a descrição do material {sku}: ele ainda não está cadastrado.",
                    status=400, field="description", material_code=sku,
                )
            # Outra OT com o mesmo material novo pode estar sendo registrada neste instante: quem
            # chegar depois usa o cadastro que a outra criou (antes virava erro 500).
            item_id = db.execute(
                text(
                    """
                    INSERT INTO items (sku, item_name, uom, pack_weight_kg, external_id)
                    VALUES (:sku, :name, :uom, :pack, :ext)
                    ON CONFLICT (sku) DO NOTHING RETURNING item_id
                    """
                ),
                {"sku": sku, "name": m["description"], "uom": m.get("uom"), "pack": pack,
                 "ext": str(uuid.uuid4())},
            ).scalar()
            if item_id is None:
                item = db.execute(find_item, {"sku": sku}).fetchone()
        if item is not None:
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
            # Peso da caixa vazio é preenchido; um diferente é mantido e informado para revisão.
            if pack and item.pack_weight_kg is None:
                db.execute(text("UPDATE items SET pack_weight_kg = :p WHERE item_id = :id"),
                           {"p": pack, "id": item_id})
            elif pack and item.pack_weight_kg != pack:
                divergences.append({
                    "field": "pack_weight_kg", "label": OT_FIELD_LABELS["pack_weight_kg"],
                    "material_code": sku, "registered": str(item.pack_weight_kg),
                    "received": str(pack),
                })
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
            {"po": po_id, "item": item_id, "qty": m["quantity"], "lot": m.get("lot_number"),
             "expiry": m.get("expiry_date"), "uom": m.get("uom"),
             "so_number": m.get("service_order_number") or header.get("service_order_number"),
             "so_type": m.get("service_order_type") or header.get("service_order_type")},
        )
        added.append({"sku": sku, "quantity": m["quantity"], "lot_number": m.get("lot_number")})

    if not created:
        # OT já recebida que ganha um material volta a ter o que receber.
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
    """``changes`` traz só os campos enviados; None volta o campo para pendente."""
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
    """A quantidade só muda enquanto nada do material foi recebido."""
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


# --- Exclusão
# Apagar uma ordem ou material leva junto o que pertence a ele. O log de auditoria não pode ser
# apagado e guarda o que foi removido e por quem.

ACTION_OT_DELETED = "OT_DELETED"
ACTION_MATERIAL_DELETED = "MATERIAL_DELETED"

# Tabelas que o SEA não usa: um material citado nelas fica onde está, para não apagar registros que
# não são dele.
_FOREIGN_ITEM_TABLES = (
    "sales_order_lines", "pick_tasks", "item_fulfillment_lines", "transfer_order_lines",
)


def _delete_order_rows(db, po_id, po_number):
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
    """Os materiais continuam no cadastro."""
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
    """Uma ordem que fica sem nenhum material também é apagada."""
    item = db.execute(
        text("SELECT item_id, sku FROM items WHERE item_id = :id FOR UPDATE"), {"id": item_id}
    ).fetchone()
    if item is None:
        raise SeaError("Material não encontrado", status=404)
    for table in _FOREIGN_ITEM_TABLES:
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


# --- Armazenagem

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
    """Prateleiras livres: só área de recebimento e endereço desligado são recusados. ``item`` e
    ``quantity`` continuam na assinatura por causa de quem chama.
    """
    problems = []
    if target_bin.bin_type in STAGING_TYPES:
        problems.append(
            f"{target_bin.bin_code} é área de recebimento, não endereço de armazenagem."
        )
    if target_bin.is_active is False:
        problems.append(f"O endereço {target_bin.bin_code} está inativo.")

    return problems


def _staging_param():
    return bindparam("staging", expanding=True)


_LOCK_NS_BIN = 8202


def check_putaway(db, *, item_id, to_bin_id, quantity, lot_number):
    """Não faz nada para estoque que não é de uma OT do SEA."""
    if ot_for_lot(db, lot_number) is None:
        return
    # Serializa armazenagens no mesmo endereço até o commit.
    db.execute(
        text("SELECT pg_advisory_xact_lock(:ns, :bin)"),
        {"ns": _LOCK_NS_BIN, "bin": int(to_bin_id)},
    )
    item = _item(db, item_id)
    target = _bin(db, to_bin_id)
    if item is None or target is None:
        return
    problems = storage_problems(db, item=item, target_bin=target, quantity=quantity)
    if problems:
        raise SeaError(problems[0], status=409, problems=problems)


def suggest_storage(db, *, inventory_id, warehouse_ids=None):
    """Preferência: um endereço que já tem esta OT (é só sugestão), depois o local do próprio
    material, senão o primeiro endereço ativo na sequência de armazenagem.
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


# --- Retiradas

def order_label(db, ot, item_ids=None):
    """Ex.: "Ordem PM12 2002349234 (OT 1003307220)"."""
    rows = db.execute(
        text(
            """
            SELECT DISTINCT
                   COALESCE(l.service_order_type, p.order_type) AS order_type,
                   COALESCE(l.service_order_number, p.service_order_number) AS order_number
            FROM purchase_order_lines l JOIN purchase_orders p ON p.po_id = l.po_id
            WHERE l.po_id = :po
              AND (CAST(:items AS INT[]) IS NULL OR l.item_id = ANY(:items))
            ORDER BY 2, 1
            """
        ),
        {"po": ot.po_id, "items": list(item_ids) if item_ids is not None else None},
    ).fetchall()
    orders = [" ".join(x for x in (r.order_type, r.order_number) if x)
              for r in rows if r.order_number]
    if not orders:
        return f"OT {ot.po_number}"
    return f"{'Ordem' if len(orders) == 1 else 'Ordens'} {', '.join(orders)} (OT {ot.po_number})"


def find_employee(db, user_id):
    return db.execute(
        text(
            """
            SELECT user_id, username, full_name, email FROM users
            WHERE user_id = :id AND is_active = TRUE
            """
        ),
        {"id": user_id},
    ).fetchone()


def amount_label(quantity, uom=None):
    return f"{quantity} {uom}" if uom else f"{quantity} unidade(s)"


def notify_receipt(db, po, receipt_ids, username):
    if not po.order_type or not receipt_ids:
        return
    row = db.execute(
        text(
            """
            SELECT COALESCE(SUM(r.quantity_received), 0) AS units,
                   COUNT(DISTINCT r.item_id) AS materials,
                   string_agg(DISTINCT b.bin_code, ', ') AS bins,
                   COUNT(DISTINCT COALESCE(UPPER(i.uom), '')) AS units_of_measure,
                   MAX(UPPER(i.uom)) AS uom,
                   array_agg(DISTINCT r.item_id) AS item_ids
            FROM item_receipts r JOIN bins b ON b.bin_id = r.bin_id
            JOIN items i ON i.item_id = r.item_id
            WHERE r.receipt_id = ANY(:ids)
            """
        ),
        {"ids": list(receipt_ids)},
    ).fetchone()
    notifications.create(
        db, kind=notifications.KIND_RECEIPT, warehouse_id=po.warehouse_id,
        title=f"Recebimento de materiais: {order_label(db, po, row.item_ids)}",
        # A unidade só aparece quando todo o material recebido tem a mesma; unidades misturadas
        # ficam "unidade(s)".
        message=(f"{amount_label(int(row.units), row.uom if row.units_of_measure == 1 else None)} "
                 f"de {row.materials} material(is) recebida(s) em {row.bins}. "
                 "Aguardando armazenagem."),
        ot=po.po_number, username=username,
    )


def notify_storage_done(db, *, warehouse_id, lot_number, username):
    """Chamado depois de cada armazenagem; não faz nada enquanto ainda há material esperando."""
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
        title=f"Armazenamento concluído: {order_label(db, ot)}",
        message=(f"Todo o material recebido ({order_label(db, ot)}) está armazenado em "
                 f"{places}."),
        ot=ot.po_number, username=username,
    )


# --- Transferência entre endereços

ACTION_STOCK_TRANSFERRED = "STOCK_TRANSFERRED"


def item_stock(db, item_id, warehouse_ids=None):
    rows = db.execute(
        text(
            f"""
            SELECT inv.inventory_id, inv.bin_id, b.bin_code, b.bin_type, inv.warehouse_id,
                   w.warehouse_code, inv.lot_number, inv.quantity_on_hand,
                   inv.quantity_allocated, i.uom, i.pack_weight_kg,
                   {ORDER_OF_STOCK_COLUMNS}
            FROM inventory inv
            JOIN items i ON i.item_id = inv.item_id
            JOIN bins b ON b.bin_id = inv.bin_id
            JOIN warehouses w ON w.warehouse_id = inv.warehouse_id
            {ORDER_OF_STOCK_JOIN}
            WHERE inv.item_id = :item AND inv.quantity_on_hand > 0
              AND (CAST(:wids AS INT[]) IS NULL OR inv.warehouse_id = ANY(:wids))
            ORDER BY w.warehouse_code, b.bin_code, inv.lot_number
            """
        ),
        {"item": item_id,
         "wids": list(warehouse_ids) if warehouse_ids is not None else None},
    ).fetchall()
    return [
        {"inventory_id": r.inventory_id, "bin_id": r.bin_id, "bin_code": r.bin_code,
         "warehouse_id": r.warehouse_id, "warehouse_code": r.warehouse_code,
         "stored": r.bin_type not in STAGING_TYPES, "ot": r.lot_number,
         "order_number": r.order_number, "order_type": r.order_type,
         "quantity_on_hand": r.quantity_on_hand, "quantity_allocated": r.quantity_allocated,
         "available": max(0, r.quantity_on_hand - r.quantity_allocated),
         "uom": r.uom, "pack_weight_kg": pack_weight(r.uom, r.pack_weight_kg)}
        for r in rows
    ]


def transfer_stock(db, *, inventory_id, to_bin_id, quantity, username, reason=None,
                   warehouse_ids=None):
    """Só o que não está reservado para retirada se move. Os dois locais precisam ser do usuário."""
    src = db.execute(
        text(
            """
            SELECT inv.inventory_id, inv.item_id, inv.bin_id, inv.warehouse_id, inv.lot_number,
                   inv.quantity_on_hand, inv.quantity_allocated, b.bin_code, b.bin_type,
                   w.warehouse_code, i.sku, i.uom, i.pack_weight_kg
            FROM inventory inv
            JOIN bins b ON b.bin_id = inv.bin_id
            JOIN warehouses w ON w.warehouse_id = inv.warehouse_id
            JOIN items i ON i.item_id = inv.item_id
            WHERE inv.inventory_id = :id
            FOR UPDATE OF inv
            """
        ),
        {"id": inventory_id},
    ).fetchone()
    if src is None:
        raise SeaError("Registro de estoque não encontrado.", status=404)
    dest = db.execute(
        text(
            """
            SELECT b.bin_id, b.bin_code, b.bin_type, b.is_active, b.warehouse_id,
                   w.warehouse_code
            FROM bins b JOIN warehouses w ON w.warehouse_id = b.warehouse_id
            WHERE b.bin_id = :id
            """
        ),
        {"id": to_bin_id},
    ).fetchone()
    if dest is None:
        raise SeaError("Endereço de destino não encontrado.", status=404)
    if warehouse_ids is not None and not {src.warehouse_id, dest.warehouse_id} <= set(warehouse_ids):
        raise SeaError("Você não tem acesso a um dos locais desta transferência.", status=403)
    if src.bin_type in STAGING_TYPES:
        raise SeaError(
            f"{src.sku} ainda está na área de recebimento ({src.bin_code}); "
            "use Recebimento > Armazenagem para armazená-lo.",
            status=409,
        )
    if dest.bin_id == src.bin_id:
        raise SeaError("O destino é o próprio endereço de origem.", status=400)

    available = src.quantity_on_hand - src.quantity_allocated
    if quantity > available:
        reserved = (f" ({src.quantity_allocated} reservado(s) para retirada)"
                    if src.quantity_allocated else "")
        raise SeaError(
            f"Quantidade ({quantity}) maior que o saldo livre de {src.sku} em "
            f"{src.warehouse_code} · {src.bin_code}: {max(0, available)}{reserved}.",
            status=409, available=max(0, available),
        )
    pack = pack_weight(src.uom, src.pack_weight_kg)
    if pack and quantity % pack:
        raise SeaError(
            f"{src.sku} é movimentado por caixa de {pack} KG: a quantidade ({quantity} KG) "
            "precisa ser de caixas inteiras.",
            status=400, pack_weight_kg=pack,
        )

    # Mesmas regras e mesma trava da armazenagem.
    db.execute(
        text("SELECT pg_advisory_xact_lock(:ns, :bin)"),
        {"ns": _LOCK_NS_BIN, "bin": int(dest.bin_id)},
    )
    problems = storage_problems(
        db, item=_item(db, src.item_id), target_bin=_bin(db, dest.bin_id), quantity=quantity
    )
    if problems:
        raise SeaError(problems[0], status=409, problems=problems)

    try:
        move_inventory(db, src.item_id, src.bin_id, dest.bin_id, dest.warehouse_id, quantity,
                       src.lot_number)
    except ValueError:
        raise SeaError(
            f"Saldo insuficiente de {src.sku} em {src.warehouse_code} · {src.bin_code}.",
            status=409,
        ) from None
    transfer_id = db.execute(
        text(
            """
            INSERT INTO bin_transfers (item_id, from_bin_id, to_bin_id, warehouse_id, quantity,
                                       transfer_type, lot_number, reason, transferred_by,
                                       external_id)
            VALUES (:item, :from_bin, :to_bin, :wid, :qty, 'MOVE', :lot, :reason, :user, :ext)
            RETURNING transfer_id
            """
        ),
        {"item": src.item_id, "from_bin": src.bin_id, "to_bin": dest.bin_id,
         "wid": dest.warehouse_id, "qty": quantity, "lot": src.lot_number, "reason": reason,
         "user": username, "ext": str(uuid.uuid4())},
    ).scalar()
    summary = {
        "transfer_id": transfer_id, "sku": src.sku, "quantity": quantity,
        "lot_number": src.lot_number,
        "from": f"{src.warehouse_code} · {src.bin_code}",
        "to": f"{dest.warehouse_code} · {dest.bin_code}",
    }
    write_audit_log(db, ACTION_STOCK_TRANSFERRED, "ITEM", src.item_id, username,
                    dest.warehouse_id,
                    details={**summary, "to_bin_code": dest.bin_code, "reason": reason})
    return summary


def pending_storage(db, warehouse_ids=None):
    rows = db.execute(
        text(
            f"""
            SELECT inv.inventory_id, inv.item_id, i.sku, i.item_name, i.uom, i.pack_weight_kg,
                   inv.quantity_on_hand AS quantity, inv.bin_id, b.bin_code, inv.lot_number,
                   inv.warehouse_id, w.warehouse_code,
                   {ORDER_OF_STOCK_COLUMNS}
            FROM inventory inv
            JOIN items i ON i.item_id = inv.item_id
            JOIN bins b ON b.bin_id = inv.bin_id
            JOIN warehouses w ON w.warehouse_id = inv.warehouse_id
            {ORDER_OF_STOCK_JOIN}
            WHERE b.bin_type IN :staging AND inv.quantity_on_hand > 0
              AND (CAST(:wids AS INT[]) IS NULL OR inv.warehouse_id = ANY(:wids))
            ORDER BY order_number, i.sku, inv.inventory_id
            """
        ).bindparams(_staging_param()),
        {"staging": list(STAGING_TYPES),
         "wids": list(warehouse_ids) if warehouse_ids is not None else None},
    ).fetchall()
    return [
        {"inventory_id": r.inventory_id, "item_id": r.item_id, "sku": r.sku,
         "item_name": r.item_name, "uom": r.uom,
         "pack_weight_kg": pack_weight(r.uom, r.pack_weight_kg),
         "quantity": r.quantity, "bin_id": r.bin_id, "bin_code": r.bin_code,
         "lot_number": r.lot_number, "ot": r.lot_number,
         "order_number": r.order_number, "order_type": r.order_type,
         "warehouse_id": r.warehouse_id, "warehouse_code": r.warehouse_code}
        for r in rows
    ]


def order_rows(db, warehouse_id, *, order_type=None, status=None, q=None):
    """Uma ordem pertence a um local quando a OT dela foi recebida lá ou parte do estoque dela está
    lá.
    """
    lines = db.execute(
        text(
            """
            SELECT p.po_id, p.po_number, p.status AS po_status,
                   COALESCE(l.service_order_number, p.service_order_number, p.po_number)
                       AS order_number,
                   COALESCE(l.service_order_type, p.order_type) AS order_type,
                   l.item_id, l.quantity_ordered, l.quantity_received
            FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id = p.po_id
            WHERE p.order_type IS NOT NULL
              AND (p.warehouse_id = :wid
                   OR EXISTS (SELECT 1 FROM inventory x
                              WHERE x.lot_number = p.po_number AND x.warehouse_id = :wid
                                AND x.quantity_on_hand > 0))
            ORDER BY p.po_id DESC, l.line_number
            """
        ),
        {"wid": warehouse_id},
    ).fetchall()
    if not lines:
        return []
    po_ids = sorted({ln.po_id for ln in lines})
    lots = sorted({ln.po_number for ln in lines})
    stock = db.execute(
        text(
            """
            SELECT inv.lot_number, inv.item_id, inv.quantity_on_hand, b.bin_code, b.bin_type,
                   w.warehouse_code
            FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
            JOIN warehouses w ON w.warehouse_id = inv.warehouse_id
            WHERE inv.lot_number = ANY(:lots) AND inv.quantity_on_hand > 0
            """
        ),
        {"lots": lots},
    ).fetchall()
    withdrawn = db.execute(
        text(
            """
            SELECT w.po_id, wl.item_id, SUM(wl.quantity) AS quantity
            FROM withdrawals w JOIN withdrawal_lines wl ON wl.withdrawal_id = w.withdrawal_id
            WHERE w.po_id = ANY(:pos) AND w.status = 'DELIVERED'
            GROUP BY w.po_id, wl.item_id
            """
        ),
        {"pos": po_ids},
    ).fetchall()
    received = db.execute(
        text("SELECT po_id, item_id, MAX(received_at) AS at FROM item_receipts "
             "WHERE po_id = ANY(:pos) GROUP BY po_id, item_id"),
        {"pos": po_ids},
    ).fetchall()
    out_by = {(r.po_id, r.item_id): int(r.quantity) for r in withdrawn}
    at_by = {(r.po_id, r.item_id): r.at for r in received}

    grouped = {}
    for ln in lines:
        key = (ln.po_id, ln.order_number, ln.order_type)
        row = grouped.setdefault(key, {
            "row_id": f"{ln.po_id}-{ln.order_number}", "po_id": ln.po_id, "ot": ln.po_number,
            "order_number": ln.order_number, "order_type": ln.order_type,
            "po_status": ln.po_status, "materials": 0, "qty_ordered": 0, "qty_received": 0,
            "qty_staging": 0, "qty_stored": 0, "qty_withdrawn": 0, "_bins": set(),
            "_received_at": None, "_items": set(),
        })
        row["materials"] += 1
        row["qty_ordered"] += ln.quantity_ordered
        row["qty_received"] += ln.quantity_received
        row["qty_withdrawn"] += out_by.get((ln.po_id, ln.item_id), 0)
        row["_items"].add(ln.item_id)
        at = at_by.get((ln.po_id, ln.item_id))
        if at and (row["_received_at"] is None or at > row["_received_at"]):
            row["_received_at"] = at
    by_lot_item = {}
    for row in grouped.values():
        for item_id in row["_items"]:
            by_lot_item[(row["ot"], item_id)] = row
    for s in stock:
        row = by_lot_item.get((s.lot_number, s.item_id))
        if row is None:
            continue
        if s.bin_type in STAGING_TYPES:
            row["qty_staging"] += s.quantity_on_hand
        else:
            row["qty_stored"] += s.quantity_on_hand
            row["_bins"].add(f"{s.warehouse_code} · {s.bin_code}")

    # A ordem pode ter chegado inteira e a OT dela ainda esperar outros materiais: a OT fica em
    # recebimento parcial.
    ot_lines = {}
    for ln in lines:
        ot_lines.setdefault(ln.po_id, []).append(ln)
    ot_status = {}
    for po_id, po_lines in ot_lines.items():
        if all(x.quantity_received >= x.quantity_ordered for x in po_lines):
            ot_status[po_id] = ("RECEIVED", 0)
        else:
            pending = sum(1 for x in po_lines if x.quantity_received < x.quantity_ordered)
            started = any(x.quantity_received > 0 for x in po_lines)
            ot_status[po_id] = ("PARTIAL" if started else "OPEN", pending)

    wanted = (q or "").strip().casefold()
    result = []
    for row in grouped.values():
        row["ot_status"], row["ot_pending_materials"] = ot_status[row["po_id"]]
        if row["po_status"] in PO_LOCKED_STATUSES:
            row["status"] = row["po_status"]
        elif row["qty_received"] <= 0:
            row["status"] = "OPEN"
        elif row["qty_received"] < row["qty_ordered"]:
            row["status"] = "PARTIAL"
        else:
            row["status"] = "RECEIVED"
        if order_type and row["order_type"] != order_type:
            continue
        if status and row["status"] != status:
            continue
        if wanted and wanted not in f"{row['order_number']} {row['ot']}".casefold():
            continue
        row["bins"] = ", ".join(sorted(row.pop("_bins"))) or None
        at = row.pop("_received_at")
        row["received_at"] = at.isoformat() if at else None
        row.pop("_items")
        row.pop("po_status")
        result.append(row)
    return result


def order_stock(db, order_number, warehouse_ids=None):
    """O que está guardado e livre. O terminal não limita locais: o material é oferecido onde
    estiver. Uma OT cadastrada sem número de ordem responde pelo próprio número.
    """
    rows = db.execute(
        text(
            """
            SELECT p.po_number, l.item_id, i.sku, i.item_name, i.uom, i.pack_weight_kg,
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
    materials = _order_materials(db, order_number) + _order_awaiting_receipt(db, order_number)
    if not materials:
        return None
    delivered = [m["withdrawn_at"] for m in materials if m["withdrawn_at"]]
    return {
        "order_number": order_number,
        "order_type": rows[0].order_type if rows else materials[0]["order_type"],
        "status": order_situation(materials),
        "withdrawn_at": max(delivered) if delivered else None,
        "materials": materials,
        "stock": [
            {"inventory_id": r.inventory_id, "ot": r.po_number, "item_id": r.item_id,
             "sku": r.sku, "item_name": r.item_name, "bin_id": r.bin_id,
             "bin_code": r.bin_code, "warehouse_id": r.warehouse_id,
             "warehouse_code": r.warehouse_code, "available": int(r.available),
             "uom": r.uom, "pack_weight_kg": pack_weight(r.uom, r.pack_weight_kg)}
            for r in rows if r.inventory_id is not None
        ],
    }


# Situação de cada material da ordem no terminal, e da ordem inteira.
MAT_AVAILABLE = "DISPONIVEL"
MAT_AWAITING_STORAGE = "AGUARDANDO_ARMAZENAMENTO"
MAT_IN_WITHDRAWAL = "EM_RETIRADA"
MAT_AWAITING_RECEIPT = "AGUARDANDO_RECEBIMENTO"
MAT_SOLD_OUT = "ESGOTADO"
MAT_UNAVAILABLE = "INDISPONIVEL"
ORDER_WITHDRAWN = "RETIRADA"


def material_situation(*, ordered, received, staging, stored, available, withdrawn):
    """O que o funcionário pode esperar deste material agora."""
    if available > 0:
        return MAT_AVAILABLE
    if staging > 0:
        return MAT_AWAITING_STORAGE
    if stored > 0:  # guardado, mas reservado por outro pedido em andamento
        return MAT_IN_WITHDRAWAL
    if received < ordered:
        return MAT_AWAITING_RECEIPT
    if withdrawn > 0:
        return MAT_SOLD_OUT
    return MAT_UNAVAILABLE


def order_situation(materials):
    states = {m["status"] for m in materials}
    if states == {MAT_SOLD_OUT}:
        return ORDER_WITHDRAWN
    for state in (MAT_AVAILABLE, MAT_AWAITING_STORAGE, MAT_IN_WITHDRAWAL, MAT_AWAITING_RECEIPT,
                  MAT_SOLD_OUT):
        if state in states:
            return state
    return MAT_UNAVAILABLE


def _order_materials(db, order_number):
    """Materiais da ordem já cadastrados no SEA, com o que chegou, o que está guardado e o que já
    saiu. Sem filtro de local, como o terminal.
    """
    rows = db.execute(
        text(
            """
            SELECT p.po_number, i.sku, i.item_name, i.uom, i.pack_weight_kg,
                   COALESCE(l.service_order_type, p.order_type) AS order_type,
                   l.quantity_ordered, l.quantity_received,
                   COALESCE(s.staging, 0) AS staging, COALESCE(s.stored, 0) AS stored,
                   COALESCE(s.available, 0) AS available,
                   COALESCE(wd.quantity, 0) AS withdrawn, wd.at AS withdrawn_at
            FROM purchase_order_lines l
            JOIN purchase_orders p ON p.po_id = l.po_id AND p.order_type IS NOT NULL
            JOIN items i ON i.item_id = l.item_id
            LEFT JOIN LATERAL (
                SELECT SUM(inv.quantity_on_hand) FILTER (WHERE b.bin_type IN :staging) AS staging,
                       SUM(inv.quantity_on_hand)
                           FILTER (WHERE b.bin_type NOT IN :staging) AS stored,
                       SUM(GREATEST(0, inv.quantity_on_hand - inv.quantity_allocated))
                           FILTER (WHERE b.bin_type NOT IN :staging) AS available
                FROM inventory inv JOIN bins b ON b.bin_id = inv.bin_id
                WHERE inv.lot_number = p.po_number AND inv.item_id = l.item_id
                  AND inv.quantity_on_hand > 0
            ) s ON TRUE
            LEFT JOIN LATERAL (
                SELECT SUM(wl.quantity) AS quantity, MAX(w.delivered_at) AS at
                FROM withdrawals w JOIN withdrawal_lines wl ON wl.withdrawal_id = w.withdrawal_id
                WHERE w.po_id = p.po_id AND wl.item_id = l.item_id AND w.status = :delivered
            ) wd ON TRUE
            WHERE COALESCE(l.service_order_number, p.service_order_number, p.po_number) = :n
            ORDER BY p.po_id, l.line_number
            """
        ).bindparams(_staging_param()),
        {"n": order_number, "staging": list(STAGING_TYPES), "delivered": W_DELIVERED},
    ).fetchall()
    result = []
    for r in rows:
        amounts = {
            "ordered": int(r.quantity_ordered), "received": int(r.quantity_received),
            "staging": int(r.staging), "stored": int(r.stored),
            "available": int(r.available), "withdrawn": int(r.withdrawn),
        }
        result.append({
            "ot": r.po_number, "sku": r.sku, "item_name": r.item_name, "uom": r.uom,
            "pack_weight_kg": pack_weight(r.uom, r.pack_weight_kg), "order_type": r.order_type,
            "status": material_situation(**amounts),
            "quantity_ordered": amounts["ordered"], "quantity_received": amounts["received"],
            "awaiting_storage": amounts["staging"], "available": amounts["available"],
            "withdrawn": amounts["withdrawn"],
            "withdrawn_at": r.withdrawn_at.isoformat() if r.withdrawn_at else None,
        })
    return result


def _order_awaiting_receipt(db, order_number):
    """Materiais da ordem que a base do SAP conhece e que ainda não chegaram ao SEA (a OT não foi
    registrada no recebimento, ou foi sem este material).
    """
    rows = db.execute(
        text(
            """
            SELECT ri.ot_number, ri.material_code,
                   COALESCE(m.description, ri.material_code) AS description,
                   COALESCE(ri.uom, m.uom) AS uom, m.pack_weight_kg, ri.quantity, o.order_type
            FROM sap_reservation_items ri
            JOIN sap_orders o ON o.order_number = ri.order_number
            LEFT JOIN sap_materials m ON m.material_code = ri.material_code
            WHERE ri.order_number = :n
              AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders p
                  JOIN purchase_order_lines l ON l.po_id = p.po_id
                  JOIN items i ON i.item_id = l.item_id
                  WHERE (p.po_number = ri.ot_number OR p.po_barcode = ri.ot_number)
                    AND i.sku = ri.material_code)
            ORDER BY ri.ot_number, ri.material_code
            """
        ),
        {"n": order_number},
    ).fetchall()
    return [
        {"ot": r.ot_number, "sku": r.material_code, "item_name": r.description, "uom": r.uom,
         "pack_weight_kg": pack_weight(r.uom, r.pack_weight_kg), "order_type": r.order_type,
         "status": MAT_AWAITING_RECEIPT, "quantity_ordered": int(r.quantity),
         "quantity_received": 0, "awaiting_storage": 0, "available": 0, "withdrawn": 0,
         "withdrawn_at": None}
        for r in rows
    ]


def order_display(order_type, number):
    if not number:
        return None
    return f"{order_type} - {number}" if order_type else str(number)


def log_orders(db, rows):
    """O log guarda a OT e o material, mas a operação fala em ordem. Uma retirada responde com as
    ordens dos seus materiais; as demais linhas, com a ordem do material na OT (todas as ordens
    da OT quando a linha não cita material).
    """
    result = {}
    withdrawal_ids = {r.entity_id for r in rows if r.entity_type == "WITHDRAWAL" and r.entity_id}
    by_withdrawal = {}
    if withdrawal_ids:
        for x in db.execute(
            text(
                """
                SELECT DISTINCT wl.withdrawal_id,
                       COALESCE(ol.service_order_type, op.order_type) AS order_type,
                       COALESCE(ol.service_order_number, op.service_order_number, op.po_number)
                           AS order_number
                FROM withdrawal_lines wl
                JOIN withdrawals wd ON wd.withdrawal_id = wl.withdrawal_id
                JOIN purchase_orders op ON op.po_id = wd.po_id
                LEFT JOIN purchase_order_lines ol
                  ON ol.po_id = op.po_id AND ol.item_id = wl.item_id
                WHERE wl.withdrawal_id = ANY(:ids)
                """
            ),
            {"ids": sorted(withdrawal_ids)},
        ):
            by_withdrawal.setdefault(x.withdrawal_id, set()).add(
                order_display(x.order_type, x.order_number))

    wanted = {}
    po_ids, po_numbers = set(), set()
    for r in rows:
        if r.entity_type == "WITHDRAWAL":
            continue
        d = r.details if isinstance(r.details, dict) else {}
        po_id = r.entity_id if r.entity_type == "PO" else None
        ot = d.get("ot") or d.get("po_number") or d.get("lot_number")
        if po_id is None and not ot:
            continue
        skus = {d["sku"]} if d.get("sku") else {
            m.get("sku") for m in d.get("materials") or [] if isinstance(m, dict) and m.get("sku")
        }
        wanted[r.log_id] = (po_id, str(ot) if ot else None, d.get("item_id"), skus)
        if po_id:
            po_ids.add(po_id)
        if ot:
            po_numbers.add(str(ot))
    lines = []
    if po_ids or po_numbers:
        lines = db.execute(
            text(
                """
                SELECT p.po_id, p.po_number, l.item_id, i.sku,
                       COALESCE(l.service_order_type, p.order_type) AS order_type,
                       COALESCE(l.service_order_number, p.service_order_number, p.po_number)
                           AS order_number
                FROM purchase_order_lines l
                JOIN purchase_orders p ON p.po_id = l.po_id
                JOIN items i ON i.item_id = l.item_id
                WHERE p.order_type IS NOT NULL
                  AND (p.po_id = ANY(:ids) OR p.po_number = ANY(:numbers))
                """
            ),
            {"ids": sorted(po_ids), "numbers": sorted(po_numbers)},
        ).fetchall()

    for r in rows:
        if r.entity_type == "WITHDRAWAL":
            found = by_withdrawal.get(r.entity_id, set())
        elif r.log_id in wanted:
            po_id, ot, item_id, skus = wanted[r.log_id]
            same_ot = [ln for ln in lines if ln.po_id == po_id or ln.po_number == ot]
            narrowed = [ln for ln in same_ot
                        if (item_id and ln.item_id == item_id) or (skus and ln.sku in skus)]
            found = {order_display(ln.order_type, ln.order_number)
                     for ln in (narrowed or same_ot)}
        else:
            found = set()
        result[r.log_id] = sorted(x for x in found if x)
    return result


def _unit_suffix(uom):
    return f" {uom.upper()}" if uom else ""


def create_withdrawal(db, *, ot, lines, username, note=None, requester_email=None):
    """Cada linha precisa ser da OT, estar num endereço de armazenagem e ter saldo livre."""
    if ot.status == "CLOSED":
        raise SeaError(f"A OT {ot.po_number} está fechada.", status=400)
    seen = set()
    for line in lines:
        if line["inventory_id"] in seen:
            raise SeaError("Material repetido na solicitação.", status=400)
        seen.add(line["inventory_id"])

    locked = {}
    # Travas numa ordem fixa, para dois pedidos simultâneos não se bloquearem.
    for inventory_id in sorted(seen):
        row = db.execute(
            text(
                """
                SELECT inv.inventory_id, inv.item_id, inv.bin_id, inv.warehouse_id,
                       inv.lot_number, inv.quantity_on_hand, inv.quantity_allocated,
                       b.bin_type, b.bin_code, i.sku, i.uom, i.pack_weight_kg
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

    # A retirada pertence ao local onde o material está (quem separa), não onde a ordem foi
    # recebida.
    locations = {row.warehouse_id for row in locked.values()}
    if len(locations) != 1:
        raise SeaError("Os materiais de uma retirada devem estar no mesmo local.", status=400)
    stock_warehouse_id = locations.pop()

    for line in lines:
        row = locked[line["inventory_id"]]
        available = row.quantity_on_hand - row.quantity_allocated
        pack = pack_weight(row.uom, row.pack_weight_kg)
        if pack and line["quantity"] % pack:
            raise SeaError(
                f"{row.sku} é retirado por caixa de {pack} KG: a quantidade ({line['quantity']} KG) "
                f"precisa ser de caixas inteiras.",
                status=400, inventory_id=row.inventory_id, pack_weight_kg=pack,
            )
        if line["quantity"] > available:
            raise SeaError(
                f"Quantidade solicitada de {row.sku} ({line['quantity']}) maior que o saldo "
                f"disponível em {row.bin_code} ({max(0, available)}).",
                status=409, inventory_id=row.inventory_id, available=max(0, available),
            )

    withdrawal_id = db.execute(
        text(
            """
            INSERT INTO withdrawals (warehouse_id, po_id, status, requested_by, requester_note,
                                     requester_email)
            VALUES (:wid, :po_id, :status, :user, :note, :email)
            RETURNING withdrawal_id
            """
        ),
        {"wid": stock_warehouse_id, "po_id": ot.po_id, "status": W_REQUESTED,
         "user": username, "note": note, "email": requester_email},
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
            "requester_email": requester_email,
        },
    )
    notifications.create(
        db, kind=notifications.KIND_WITHDRAWAL_REQUESTED, warehouse_id=stock_warehouse_id,
        withdrawal_id=withdrawal_id,
        title="Retirada nº {} solicitada: {}".format(
            withdrawal_id, order_label(db, ot, {row.item_id for row in locked.values()})),
        message="Solicitada por {}: {}.".format(
            f"{requester_email} (terminal)" if requester_email else username,
            "; ".join(
                f"{ln['quantity']}{_unit_suffix(locked[ln['inventory_id']].uom)} x "
                f"{locked[ln['inventory_id']].sku} "
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
                   w.requester_email, w.picked_by, p.po_number
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
    W_REQUESTED: "aguardando avaliação",
    W_APPROVED: "aprovada, aguardando quem faça a retirada",
    W_REJECTED: "negada",
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


def evaluate(db, withdrawal_id, username, approve, note=None, scope=("", None)):
    """Aprovar avisa quem faz retirada; negar exige motivo e desfaz a reserva."""
    note = (note or "").strip() or None
    if not approve and not note:
        raise SeaError("Informe o motivo para negar a retirada.", status=400)
    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, (W_REQUESTED,), "avaliar")
    if not approve:
        _release_reservation(db, withdrawal_id)
    db.execute(
        text(
            """
            UPDATE withdrawals SET status = :s, evaluated_by = :u, evaluated_at = NOW(),
                   evaluation_note = :n
            WHERE withdrawal_id = :id
            """
        ),
        {"s": W_APPROVED if approve else W_REJECTED, "u": username, "n": note,
         "id": withdrawal_id},
    )
    write_audit_log(
        db, ACTION_WITHDRAWAL_APPROVED if approve else ACTION_WITHDRAWAL_REJECTED,
        "WITHDRAWAL", withdrawal_id, username, w.warehouse_id,
        details={"ot": w.po_number, "reason": note} if note else {"ot": w.po_number},
    )
    if approve:
        notifications.create(
            db, kind=notifications.KIND_WITHDRAWAL_APPROVED, warehouse_id=w.warehouse_id,
            title=f"Retirada nº {withdrawal_id} aprovada: quem pode fazer?",
            message=f"Solicitada por {w.requester_email or w.requested_by}, OT {w.po_number}. "
                    "Aceite para separar.",
            ot=w.po_number, username=username, withdrawal_id=withdrawal_id,
        )


def start_picking(db, withdrawal_id, username, scope=("", None)):
    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, (W_APPROVED,), "aceitar a retirada")
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


def _require_picker(w, username, action):
    if w.picked_by and w.picked_by != username:
        raise SeaError(
            f"Não é possível {action}: a retirada nº {w.withdrawal_id} foi aceita por "
            f"{w.picked_by}. Somente quem aceitou dá andamento a ela.",
            status=403,
        )


def mark_ready(db, withdrawal_id, username, scope=("", None)):
    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, (W_PICKING,), "marcar como pronta")
    _require_picker(w, username, "marcar como pronta")
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
    """Quem confirma tem de ser quem pediu.
    Tudo roda sob trava: primeiro a retirada (uma segunda confirmação espera e encontra
    DELIVERED), depois cada linha de estoque numa ordem fixa.
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
            # O estoque mudou debaixo da reserva (um ajuste, por exemplo): recusa em vez de deixar o
            # saldo negativo.
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
            SET status = :s, delivered_to_user_id = :emp, delivered_to_name = :name,
                delivered_at = NOW(), confirmed_by = :u
            WHERE withdrawal_id = :id
            """
        ),
        # O nome fica gravado: o registro continua certo mesmo se o usuário for excluído.
        {"s": W_DELIVERED, "emp": employee.user_id, "u": employee.username,
         "name": w.requester_email or employee.full_name or employee.username,
         "id": withdrawal_id},
    )
    write_audit_log(
        db, ACTION_WITHDRAWAL_DELIVERED, "WITHDRAWAL", withdrawal_id, employee.username,
        w.warehouse_id,
        details={
            "ot": w.po_number,
            "employee_user_id": employee.user_id,
            "employee_name": employee.full_name,
            "requester_email": w.requester_email,
            "identified_by": "email" if w.requester_email else "login",
            "lines": [{"sku": ln.sku, "bin_code": ln.bin_code, "quantity": ln.quantity}
                      for ln in lines],
        },
    )
    return employee


def _release_reservation(db, withdrawal_id):
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


def cancel(db, withdrawal_id, username, reason, scope=("", None), any_user=False):
    """Depois do aceite, só quem pediu, quem aceitou ou um administrador (``any_user``) cancela. Se
    quem pediu cancelar, quem aceitou é avisado.
    """
    reason = (reason or "").strip()
    if not reason:
        raise SeaError("Informe o motivo do cancelamento.", status=400)
    w = _lock_withdrawal(db, withdrawal_id, *scope)
    _require_status(w, W_OPEN_STATUSES, "cancelar")
    if not any_user and username != w.requested_by:
        _require_picker(w, username, "cancelar")
    _release_reservation(db, withdrawal_id)
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
    if w.picked_by and username != w.picked_by:
        notifications.create(
            db, kind=notifications.KIND_WITHDRAWAL_CANCELLED, warehouse_id=w.warehouse_id,
            title=f"Retirada nº {withdrawal_id} cancelada",
            message=f"Cancelada por {username}: {reason}. Não é preciso continuar a separação.",
            ot=w.po_number, username=username, withdrawal_id=withdrawal_id,
        )
