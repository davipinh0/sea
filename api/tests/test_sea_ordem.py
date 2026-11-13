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

    def test_material_stored_in_a_location_the_employee_does_not_work_in(
        self, client, auth_headers, sp12, second_location
    ):
        """Regression: an employee whose locations do not include the one
        that holds the material (e.g. the Contêiner de Solda) saw nothing
        at the terminal. They request it all the same; separating stays
        with the users of that location."""
        conn = sp12["conn"]
        po_id = _register(client, auth_headers, "OT-ORD-4", [
            {"material_code": "ORD-F", "description": "Peça F", "quantity": 4,
             "service_order_number": "2000000904"}])
        (item,) = _receive_all(client, auth_headers, conn, po_id)
        assert _putaway(client, auth_headers, item, sp12["c0"], 4, "OT-ORD-4").status_code == 200

        employee = _user(client, conn, "sea.ordem.1", ["retirada"], [second_location])
        (row,) = client.get("/api/sea/ordens/2000000904", headers=employee).get_json()["stock"]
        assert row["available"] == 4 and row["warehouse_id"] == WAREHOUSE

        resp = _request(client, employee, row["inventory_id"], 2, ot=row["ot"])
        assert resp.status_code == 201, resp.get_json()
        wid = resp.get_json()["withdrawal"]["withdrawal_id"]
        # The request went to the location that holds the material.
        assert resp.get_json()["withdrawal"]["warehouse_id"] == WAREHOUSE
        assert client.get(f"/api/sea/retiradas/{wid}", headers=employee).status_code == 200

        # The employee does not separate: that is for the location's users.
        assert client.post(f"/api/sea/retiradas/{wid}/separar", headers=employee,
                           json={}).status_code == 404
        for action in ("separar", "pronta"):
            assert client.post(f"/api/sea/retiradas/{wid}/{action}", headers=auth_headers,
                               json={}).status_code == 200
        done = client.post(f"/api/sea/retiradas/{wid}/entregar", headers=employee, json={})
        assert done.status_code == 200, done.get_json()
        assert conn.execute(
            text("SELECT quantity_on_hand FROM inventory WHERE inventory_id = :i"),
            {"i": row["inventory_id"]},
        ).scalar() == 2

        # Someone else from another location still cannot see or touch it.
        stranger = _user(client, conn, "sea.ordem.2", ["retirada"], [second_location])
        assert client.get(f"/api/sea/retiradas/{wid}", headers=stranger).status_code == 404
        again = _request(client, employee, row["inventory_id"], 1, ot=row["ot"])
        other_wid = again.get_json()["withdrawal"]["withdrawal_id"]
        assert client.post(f"/api/sea/retiradas/{other_wid}/cancelar", headers=stranger,
                           json={"reason": "x"}).status_code == 404
        assert client.post(f"/api/sea/retiradas/{other_wid}/cancelar", headers=employee,
                           json={"reason": "desisti"}).status_code == 200

    def test_notifications_carry_the_location(self, client, auth_headers, sp12):
        _register(client, auth_headers, "OT-ORD-5", [
            {"material_code": "ORD-G", "description": "Peça G", "quantity": 1}])
        po_id = sp12["conn"].execute(
            text("SELECT po_id FROM purchase_orders WHERE po_number = 'OT-ORD-5'")).scalar()
        _receive_all(client, auth_headers, sp12["conn"], po_id)
        first = client.get("/api/sea/notificacoes", headers=auth_headers).get_json()["notifications"][0]
        assert first["kind"] == "RECEBIMENTO" and first["warehouse_id"] == WAREHOUSE


class TestBoxWeight:
    """A material kept in KG with a box weight is withdrawn by whole boxes."""

    def _wire(self, client, headers, sp12, ot, order, qty=36, pack=18):
        po_id = _register(client, headers, ot, [
            {"material_code": f"ARAME-{ot}", "description": "Arame de soldagem", "quantity": qty,
             "uom": "KG", "service_order_number": order}])
        (item,) = _receive_all(client, headers, sp12["conn"], po_id)
        resp = client.put(f"/api/admin/items/{item}", headers=headers,
                          json={"uom": "KG", "pack_weight_kg": pack})
        assert resp.status_code == 200, resp.get_json()
        assert _putaway(client, headers, item, sp12["c0"], qty, ot).status_code == 200
        return item

    def test_one_box_of_18_out_of_36_leaves_18(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        self._wire(client, auth_headers, sp12, "OT-CX-1", "2000000951")
        (row,) = client.get("/api/sea/ordens/2000000951", headers=auth_headers).get_json()["stock"]
        assert (row["available"], row["uom"], row["pack_weight_kg"]) == (36, "KG", 18)

        resp = _request(client, auth_headers, row["inventory_id"], 18, ot="OT-CX-1")
        assert resp.status_code == 201, resp.get_json()
        withdrawal = resp.get_json()["withdrawal"]
        assert withdrawal["lines"][0]["quantity"] == 18
        assert withdrawal["lines"][0]["pack_weight_kg"] == 18
        wid = withdrawal["withdrawal_id"]
        for action in ("separar", "pronta", "entregar"):
            step = client.post(f"/api/sea/retiradas/{wid}/{action}", headers=auth_headers, json={})
            assert step.status_code == 200, step.get_json()
        assert conn.execute(
            text("SELECT quantity_on_hand FROM inventory WHERE inventory_id = :i"),
            {"i": row["inventory_id"]},
        ).scalar() == 18
        (left,) = client.get("/api/sea/ordens/2000000951", headers=auth_headers).get_json()["stock"]
        assert left["available"] == 18

    def test_part_of_a_box_is_refused(self, client, auth_headers, sp12):
        self._wire(client, auth_headers, sp12, "OT-CX-2", "2000000952")
        (row,) = client.get("/api/sea/ordens/2000000952", headers=auth_headers).get_json()["stock"]
        resp = _request(client, auth_headers, row["inventory_id"], 10, ot="OT-CX-2")
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["user_facing"] is True and "caixa de 18 KG" in body["error"]
        assert sp12["conn"].execute(
            text("SELECT quantity_allocated FROM inventory WHERE inventory_id = :i"),
            {"i": row["inventory_id"]},
        ).scalar() == 0

    def test_box_weight_only_applies_to_kg(self, client, auth_headers, sp12):
        """PC: withdrawing 1 takes 1, whatever number sits in the box-weight field."""
        conn = sp12["conn"]
        po_id = _register(client, auth_headers, "OT-CX-3", [
            {"material_code": "PECA-CX", "description": "Peça", "quantity": 5, "uom": "PC",
             "service_order_number": "2000000953"}])
        (item,) = _receive_all(client, auth_headers, conn, po_id)
        conn.execute(text("UPDATE items SET pack_weight_kg = 4 WHERE item_id = :i"), {"i": item})
        assert _putaway(client, auth_headers, item, sp12["c0"], 5, "OT-CX-3").status_code == 200
        (row,) = client.get("/api/sea/ordens/2000000953", headers=auth_headers).get_json()["stock"]
        assert row["uom"] == "PC" and row["pack_weight_kg"] is None
        assert _request(client, auth_headers, row["inventory_id"], 1, ot="OT-CX-3").status_code == 201

    def test_materials_list_shows_the_box_weight_and_it_must_be_positive(
        self, client, auth_headers, sp12
    ):
        item = self._wire(client, auth_headers, sp12, "OT-CX-4", "2000000954", qty=150, pack=15)
        rows = client.get(
            f"/api/sea/materiais?warehouse_id={WAREHOUSE}&q=ARAME-OT-CX-4", headers=auth_headers
        ).get_json()["items"]
        assert (rows[0]["quantity"], rows[0]["uom"], rows[0]["pack_weight_kg"]) == (150, "KG", 15)
        bad = client.put(f"/api/admin/items/{item}", headers=auth_headers, json={"pack_weight_kg": 0})
        assert bad.status_code == 400


class TestBoxWeightOnTheLabel:
    def _one(self, conn, sku):
        return conn.execute(
            text("SELECT uom, pack_weight_kg FROM items WHERE sku = :s"), {"s": sku}
        ).fetchone()

    def test_label_registration_completes_the_material(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        _register(client, auth_headers, "OT-ETQ-1", [
            {"material_code": "ARAME-ETQ", "description": "Arame", "quantity": 36, "uom": "kg",
             "pack_weight_kg": 18}])
        assert tuple(self._one(conn, "ARAME-ETQ")) == ("KG", 18)

        # A later label fills an empty box weight and never overwrites one.
        _register(client, auth_headers, "OT-ETQ-2", [
            {"material_code": "ARAME-ETQ2", "description": "Arame 2", "quantity": 30, "uom": "KG"}])
        assert self._one(conn, "ARAME-ETQ2").pack_weight_kg is None
        resp = client.post(
            "/api/sea/recebimentos", headers=auth_headers,
            json={"warehouse_id": WAREHOUSE,
                  "header": {"ot_code": "OT-ETQ-3", "service_order_type": "PM11"},
                  "materials": [
                      {"material_code": "ARAME-ETQ2", "quantity": 15, "uom": "KG",
                       "pack_weight_kg": 15},
                      {"material_code": "ARAME-ETQ", "quantity": 20, "uom": "KG",
                       "pack_weight_kg": 20},
                  ]},
        )
        assert resp.status_code == 201, resp.get_json()
        assert self._one(conn, "ARAME-ETQ2").pack_weight_kg == 15
        assert self._one(conn, "ARAME-ETQ").pack_weight_kg == 18
        (diverged,) = resp.get_json()["divergences"]
        assert (diverged["field"], diverged["registered"], diverged["received"]) == (
            "pack_weight_kg", "18", "20")

    def test_box_weight_is_ignored_for_other_units_and_must_be_positive(
        self, client, auth_headers, sp12
    ):
        _register(client, auth_headers, "OT-ETQ-4", [
            {"material_code": "PECA-ETQ", "description": "Peça", "quantity": 3, "uom": "PC",
             "pack_weight_kg": 9}])
        assert self._one(sp12["conn"], "PECA-ETQ").pack_weight_kg is None
        bad = client.post(
            "/api/sea/recebimentos", headers=auth_headers,
            json={"warehouse_id": WAREHOUSE,
                  "header": {"ot_code": "OT-ETQ-5", "service_order_type": "PM11"},
                  "materials": [{"material_code": "X-ETQ", "description": "X", "quantity": 1,
                                 "uom": "KG", "pack_weight_kg": 0}]},
        )
        assert bad.status_code == 400
