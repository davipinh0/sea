"""Terminal de retirada: o que a ordem informada tem e por que um material não está disponível."""

from sqlalchemy import text

from services import sea_service as sea
from tests.test_sea import STAGING_BIN, _putaway, _request, sp12  # noqa: F401
from tests.test_sea_ordem import _register

URL = "/api/sea/ordens/{}"


def _lines(conn, po_id):
    return conn.execute(
        text("SELECT item_id, quantity_ordered FROM purchase_order_lines WHERE po_id = :p "
             "ORDER BY line_number"), {"p": po_id},
    ).fetchall()


def _receive(client, headers, po_id, items):
    resp = client.post(
        "/api/receiving/receive", headers=headers,
        json={"po_id": po_id, "items": [
            {"item_id": item_id, "quantity": qty, "bin_id": STAGING_BIN} for item_id, qty in items]},
    )
    assert resp.status_code == 200, resp.get_json()


def _deliver(client, headers, inventory_id, qty, ot):
    resp = _request(client, headers, inventory_id, qty, ot=ot)
    assert resp.status_code == 201, resp.get_json()
    wid = resp.get_json()["withdrawal"]["withdrawal_id"]
    for action in ("avaliar", "separar", "pronta", "entregar"):
        body = {"approve": True} if action == "avaliar" else {}
        step = client.post(f"/api/sea/retiradas/{wid}/{action}", headers=headers, json=body)
        assert step.status_code == 200, step.get_json()


def _by_sku(body):
    return {m["sku"]: m for m in body["materials"]}


def _sap_order(conn, order, ot, materials):
    conn.execute(text("INSERT INTO sap_orders (order_number, order_type) VALUES (:n, 'PM12')"),
                 {"n": order})
    conn.execute(text("INSERT INTO sap_reservations (ot_number) VALUES (:ot)"), {"ot": ot})
    for code, qty in materials:
        conn.execute(
            text("INSERT INTO sap_materials (material_code, description, uom) "
                 "VALUES (:c, :d, 'PC') ON CONFLICT DO NOTHING"),
            {"c": code, "d": f"Material {code}"},
        )
        conn.execute(
            text("INSERT INTO sap_reservation_items (ot_number, order_number, material_code, "
                 "quantity) VALUES (:ot, :n, :c, :q)"),
            {"ot": ot, "n": order, "c": code, "q": qty},
        )


class TestMaterialSituation:
    def test_each_material_says_where_it_is(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        order = "2000000970"
        po_id = _register(client, auth_headers, "OT-SIT-1", [
            {"material_code": f"SIT-{c}", "description": f"Peça {c}", "quantity": 4,
             "service_order_number": order} for c in "ABC"])
        (a, _), (b, _), _c = _lines(conn, po_id)
        _receive(client, auth_headers, po_id, [(a, 4), (b, 4)])
        assert _putaway(client, auth_headers, a, sp12["c0"], 4, "OT-SIT-1").status_code == 200

        body = client.get(URL.format(order), headers=auth_headers).get_json()
        mats = _by_sku(body)
        assert mats["SIT-A"]["status"] == sea.MAT_AVAILABLE and mats["SIT-A"]["available"] == 4
        assert mats["SIT-B"]["status"] == sea.MAT_AWAITING_STORAGE
        assert mats["SIT-B"]["awaiting_storage"] == 4
        assert mats["SIT-C"]["status"] == sea.MAT_AWAITING_RECEIPT
        assert body["status"] == sea.MAT_AVAILABLE
        assert [s["sku"] for s in body["stock"]] == ["SIT-A"]

    def test_withdrawn_material_is_sold_out_and_the_whole_order_says_so(
        self, client, auth_headers, sp12
    ):
        conn = sp12["conn"]
        order = "2000000971"
        po_id = _register(client, auth_headers, "OT-SIT-2", [
            {"material_code": "SIT-D", "description": "Peça D", "quantity": 3,
             "service_order_number": order}])
        ((item, _),) = _lines(conn, po_id)
        _receive(client, auth_headers, po_id, [(item, 3)])
        assert _putaway(client, auth_headers, item, sp12["c0"], 3, "OT-SIT-2").status_code == 200
        (row,) = client.get(URL.format(order), headers=auth_headers).get_json()["stock"]

        # Retirada em parte: o resto continua disponível.
        _deliver(client, auth_headers, row["inventory_id"], 1, "OT-SIT-2")
        part = client.get(URL.format(order), headers=auth_headers).get_json()
        assert part["status"] == sea.MAT_AVAILABLE
        assert (part["materials"][0]["available"], part["materials"][0]["withdrawn"]) == (2, 1)

        _deliver(client, auth_headers, row["inventory_id"], 2, "OT-SIT-2")
        done = client.get(URL.format(order), headers=auth_headers).get_json()
        assert done["status"] == sea.ORDER_WITHDRAWN and done["stock"] == []
        (mat,) = done["materials"]
        assert mat["status"] == sea.MAT_SOLD_OUT and mat["withdrawn"] == 3
        assert done["withdrawn_at"] and done["withdrawn_at"] == mat["withdrawn_at"]

    def test_material_reserved_by_another_request_is_in_withdrawal(
        self, client, auth_headers, sp12
    ):
        conn = sp12["conn"]
        order = "2000000972"
        po_id = _register(client, auth_headers, "OT-SIT-3", [
            {"material_code": "SIT-E", "description": "Peça E", "quantity": 2,
             "service_order_number": order}])
        ((item, _),) = _lines(conn, po_id)
        _receive(client, auth_headers, po_id, [(item, 2)])
        assert _putaway(client, auth_headers, item, sp12["c0"], 2, "OT-SIT-3").status_code == 200
        (row,) = client.get(URL.format(order), headers=auth_headers).get_json()["stock"]
        assert _request(client, auth_headers, row["inventory_id"], 2, ot="OT-SIT-3").status_code == 201

        body = client.get(URL.format(order), headers=auth_headers).get_json()
        assert body["status"] == sea.MAT_IN_WITHDRAWAL
        assert body["materials"][0]["status"] == sea.MAT_IN_WITHDRAWAL and body["stock"] == []

    def test_registered_but_not_received_waits_for_receipt(self, client, auth_headers, sp12):
        _register(client, auth_headers, "OT-SIT-4", [
            {"material_code": "SIT-F", "description": "Peça F", "quantity": 1,
             "service_order_number": "2000000973"}])
        body = client.get(URL.format("2000000973"), headers=auth_headers).get_json()
        assert body["status"] == sea.MAT_AWAITING_RECEIPT and body["stock"] == []


class TestOrderOnlyInTheSapBase:
    def test_order_not_delivered_yet_is_awaiting_receipt(self, client, auth_headers, sp12):
        _sap_order(sp12["conn"], "2000000980", "OT-SAP-SIT-1", [("SAP-SIT-A", 5)])
        resp = client.get(URL.format("2000000980"), headers=auth_headers)
        assert resp.status_code == 200, resp.get_json()
        body = resp.get_json()
        assert (body["status"], body["order_type"], body["stock"]) == (
            sea.MAT_AWAITING_RECEIPT, "PM12", [])
        (mat,) = body["materials"]
        assert (mat["ot"], mat["sku"], mat["item_name"], mat["quantity_ordered"]) == (
            "OT-SAP-SIT-1", "SAP-SIT-A", "Material SAP-SIT-A", 5)

    def test_sap_material_already_registered_is_not_counted_twice(
        self, client, auth_headers, sp12
    ):
        conn = sp12["conn"]
        _sap_order(conn, "2000000981", "OT-SAP-SIT-2", [("SAP-SIT-B", 2), ("SAP-SIT-C", 1)])
        po_id = _register(client, auth_headers, "OT-SAP-SIT-2", [
            {"material_code": "SAP-SIT-B", "description": "Material B", "quantity": 2,
             "service_order_number": "2000000981", "service_order_type": "PM12"}])
        ((item, _),) = _lines(conn, po_id)
        _receive(client, auth_headers, po_id, [(item, 2)])

        body = client.get(URL.format("2000000981"), headers=auth_headers).get_json()
        assert {m["sku"]: m["status"] for m in body["materials"]} == {
            "SAP-SIT-B": sea.MAT_AWAITING_STORAGE, "SAP-SIT-C": sea.MAT_AWAITING_RECEIPT}
        assert body["status"] == sea.MAT_AWAITING_STORAGE

    def test_unknown_everywhere_is_still_not_found(self, client, auth_headers, sp12):
        resp = client.get(URL.format("2000000989"), headers=auth_headers)
        assert resp.status_code == 404 and resp.get_json()["user_facing"] is True


def test_situation_rules():
    base = {"ordered": 5, "received": 5, "staging": 0, "stored": 0, "available": 0,
            "withdrawn": 0}
    assert sea.material_situation(**{**base, "available": 1, "staging": 2}) == sea.MAT_AVAILABLE
    assert sea.material_situation(**{**base, "staging": 2}) == sea.MAT_AWAITING_STORAGE
    assert sea.material_situation(**{**base, "stored": 2}) == sea.MAT_IN_WITHDRAWAL
    # Chegou uma parte e ela já saiu: o resto ainda não chegou.
    assert sea.material_situation(**{**base, "received": 2, "withdrawn": 2}) == \
        sea.MAT_AWAITING_RECEIPT
    assert sea.material_situation(**{**base, "withdrawn": 5}) == sea.MAT_SOLD_OUT
    assert sea.material_situation(**base) == sea.MAT_UNAVAILABLE
    mats = [{"status": sea.MAT_SOLD_OUT}, {"status": sea.MAT_AWAITING_RECEIPT}]
    assert sea.order_situation(mats) == sea.MAT_AWAITING_RECEIPT
    assert sea.order_situation([{"status": sea.MAT_SOLD_OUT}]) == sea.ORDER_WITHDRAWN
