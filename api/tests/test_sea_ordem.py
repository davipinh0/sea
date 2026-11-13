"""SEA: the withdrawal terminal asks for the order (PM11 / PM12), not the OT."""

from sqlalchemy import text

from tests.test_sea import STAGING_BIN, WAREHOUSE, _putaway, _request, sp12  # noqa: F401
from tests.test_sea_acesso import _user, second_location  # noqa: F401


def _register(client, headers, ot, materials, **header):
    resp = client.post(
        "/api/sea/recebimentos", headers=headers,
        json={"warehouse_id": WAREHOUSE,
              "header": {"ot_code": ot, "service_order_type": "PM11", **header},
              "materials": materials},
    )
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()["po_id"]


def _receive_all(client, headers, conn, po_id):
    lines = conn.execute(
        text("SELECT item_id, quantity_ordered FROM purchase_order_lines WHERE po_id = :p "
             "ORDER BY line_number"), {"p": po_id},
    ).fetchall()
    resp = client.post(
        "/api/receiving/receive", headers=headers,
        json={"po_id": po_id, "items": [
            {"item_id": ln.item_id, "quantity": ln.quantity_ordered, "bin_id": STAGING_BIN}
            for ln in lines]},
    )
    assert resp.status_code == 200, resp.get_json()
    return [ln.item_id for ln in lines]


class TestOrderLookup:
    def test_order_brings_only_its_stored_materials(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        po_id = _register(client, auth_headers, "OT-ORD-1", [
            {"material_code": "ORD-A", "description": "Peça A", "quantity": 5,
             "service_order_number": "2000000901", "service_order_type": "PM11"},
            {"material_code": "ORD-B", "description": "Peça B", "quantity": 3,
             "service_order_number": "2000000902", "service_order_type": "PM12"},
            {"material_code": "ORD-C", "description": "Peça C", "quantity": 2,
             "service_order_number": "2000000901", "service_order_type": "PM11"},
        ])
        item_a, item_b, _item_c = _receive_all(client, auth_headers, conn, po_id)
        assert _putaway(client, auth_headers, item_a, sp12["c0"], 5, "OT-ORD-1").status_code == 200
        assert _putaway(client, auth_headers, item_b, sp12["b0"], 3, "OT-ORD-1").status_code == 200

        body = client.get("/api/sea/ordens/2000000901", headers=auth_headers).get_json()
        assert body["order_number"] == "2000000901" and body["order_type"] == "PM11"
        # ORD-B belongs to another order; ORD-C is still in the receiving area.
        assert [(s["sku"], s["ot"], s["bin_code"], s["available"]) for s in body["stock"]] == [
            ("ORD-A", "OT-ORD-1", "T-C0", 5)
        ]
        other = client.get("/api/sea/ordens/2000000902", headers=auth_headers).get_json()
        assert other["order_type"] == "PM12"
        assert [s["sku"] for s in other["stock"]] == ["ORD-B"]

        # The withdrawal is requested with what the lookup returned.
        row = body["stock"][0]
        resp = _request(client, auth_headers, row["inventory_id"], 2, ot=row["ot"])
        assert resp.status_code == 201, resp.get_json()
        again = client.get("/api/sea/ordens/2000000901", headers=auth_headers).get_json()
        assert again["stock"][0]["available"] == 3

    def test_order_registered_without_a_number_answers_by_the_ot_number(
        self, client, auth_headers, sp12
    ):
        po_id = _register(client, auth_headers, "OT-ORD-2", [
            {"material_code": "ORD-D", "description": "Peça D", "quantity": 1}])
        (item,) = _receive_all(client, auth_headers, sp12["conn"], po_id)
        assert _putaway(client, auth_headers, item, sp12["c0"], 1, "OT-ORD-2").status_code == 200
        body = client.get("/api/sea/ordens/OT-ORD-2", headers=auth_headers).get_json()
        assert [s["sku"] for s in body["stock"]] == ["ORD-D"]

    def test_unknown_order_and_order_with_nothing_available(self, client, auth_headers, sp12):
        resp = client.get("/api/sea/ordens/0000000000", headers=auth_headers)
        assert resp.status_code == 404 and resp.get_json()["user_facing"] is True
        _register(client, auth_headers, "OT-ORD-3", [
            {"material_code": "ORD-E", "description": "Peça E", "quantity": 1,
             "service_order_number": "2000000903"}])
        body = client.get("/api/sea/ordens/2000000903", headers=auth_headers)
        assert body.status_code == 200 and body.get_json()["stock"] == []

    def test_stock_of_a_location_the_user_does_not_work_in_is_not_offered(
        self, client, auth_headers, sp12, second_location
    ):
        conn = sp12["conn"]
        po_id = _register(client, auth_headers, "OT-ORD-4", [
            {"material_code": "ORD-F", "description": "Peça F", "quantity": 4,
             "service_order_number": "2000000904"}])
        (item,) = _receive_all(client, auth_headers, conn, po_id)
        assert _putaway(client, auth_headers, item, sp12["c0"], 4, "OT-ORD-4").status_code == 200
        outsider = _user(client, conn, "sea.ordem.1", ["retirada"], [second_location])
        body = client.get("/api/sea/ordens/2000000904", headers=outsider).get_json()
        assert body["stock"] == []
        insider = _user(client, conn, "sea.ordem.2", ["retirada"], [WAREHOUSE])
        body = client.get("/api/sea/ordens/2000000904", headers=insider).get_json()
        assert [s["available"] for s in body["stock"]] == [4]

    def test_notifications_carry_the_location(self, client, auth_headers, sp12):
        _register(client, auth_headers, "OT-ORD-5", [
            {"material_code": "ORD-G", "description": "Peça G", "quantity": 1}])
        po_id = sp12["conn"].execute(
            text("SELECT po_id FROM purchase_orders WHERE po_number = 'OT-ORD-5'")).scalar()
        _receive_all(client, auth_headers, sp12["conn"], po_id)
        first = client.get("/api/sea/notificacoes", headers=auth_headers).get_json()["notifications"][0]
        assert first["kind"] == "RECEBIMENTO" and first["warehouse_id"] == WAREHOUSE
