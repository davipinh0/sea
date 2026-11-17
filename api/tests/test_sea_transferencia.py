"""SEA: moving stored material between addresses and between locations."""

import pytest
from sqlalchemy import text

from tests.test_sea import WAREHOUSE, _request, sp12, stored_ot  # noqa: F401
from tests.test_sea_acesso import _user
from tests.test_sea_notificacoes import other_location  # noqa: F401


def _move(client, headers, inventory_id, to_bin, quantity):
    return client.post(
        "/api/sea/transferencias", headers=headers,
        json={"inventory_id": inventory_id, "to_bin_id": to_bin, "quantity": quantity},
    )


def _qty(conn, bin_id, lot="OT-W-1"):
    return conn.execute(
        text("SELECT COALESCE(SUM(quantity_on_hand), 0) FROM inventory "
             "WHERE bin_id = :b AND lot_number = :l"), {"b": bin_id, "l": lot},
    ).scalar()


class TestTransfer:
    """stored_ot: 10 units of 'small' (order OT-W-1) stored in T-C0."""

    def test_between_shelves_of_the_same_location(self, client, auth_headers, stored_ot, sp12):
        conn = stored_ot["conn"]
        stock = client.get(
            f"/api/sea/materiais/{stored_ot['small']}/estoque", headers=auth_headers
        ).get_json()["stock"]
        (row,) = [s for s in stock if s["inventory_id"] == stored_ot["inventory_id"]]
        assert (row["bin_code"], row["ot"], row["available"], row["stored"]) == ("T-C0", "OT-W-1", 10, True)

        resp = _move(client, auth_headers, row["inventory_id"], sp12["b0"], 4)
        assert resp.status_code == 200, resp.get_json()
        body = resp.get_json()
        assert body["from"].endswith("T-C0") and body["to"].endswith("T-B0")
        assert _qty(conn, sp12["c0"]) == 6 and _qty(conn, sp12["b0"]) == 4
        # The order still sees all of its stock, and the move is on its history.
        detail = client.get("/api/sea/ots/OT-W-1", headers=auth_headers).get_json()
        assert sum(s["quantity_on_hand"] for s in detail["stock"]) == 10
        assert "TRANSFERENCIA" in [m["kind"] for m in detail["movements"]]
        assert conn.execute(
            text("SELECT details->>'to' FROM audit_log WHERE action_type = 'STOCK_TRANSFERRED' "
                 "ORDER BY log_id DESC LIMIT 1")
        ).scalar().endswith("T-B0")

    def test_to_another_location(self, client, auth_headers, stored_ot, other_location):
        conn = stored_ot["conn"]
        resp = _move(client, auth_headers, stored_ot["inventory_id"], other_location["shelf"], 10)
        assert resp.status_code == 200, resp.get_json()
        row = conn.execute(
            text("SELECT warehouse_id, quantity_on_hand FROM inventory "
                 "WHERE lot_number = 'OT-W-1' AND quantity_on_hand > 0")
        ).fetchone()
        assert (row.warehouse_id, row.quantity_on_hand) == (other_location["warehouse_id"], 10)

    def test_what_is_reserved_for_a_withdrawal_does_not_move(
        self, client, auth_headers, stored_ot, sp12
    ):
        assert _request(client, auth_headers, stored_ot["inventory_id"], 7).status_code == 201
        refused = _move(client, auth_headers, stored_ot["inventory_id"], sp12["b0"], 5)
        assert refused.status_code == 409
        body = refused.get_json()
        assert body["user_facing"] is True and body["available"] == 3
        assert "reservado" in body["error"]
        assert _move(client, auth_headers, stored_ot["inventory_id"], sp12["b0"], 3).status_code == 200
        assert _qty(stored_ot["conn"], sp12["c0"]) == 7

    def test_storage_rules_and_invalid_destinations(self, client, auth_headers, stored_ot, sp12):
        inv = stored_ot["inventory_id"]
        # A switched-off address is refused.
        from tests.test_sea import _bin
        off = _bin(stored_ot["conn"], "T-OFF1")
        stored_ot["conn"].execute(text("UPDATE bins SET is_active = FALSE WHERE bin_id = :b"),
                                  {"b": off})
        refused = _move(client, auth_headers, inv, off, 2)
        assert refused.status_code == 409 and "inativo" in refused.get_json()["error"]
        assert _move(client, auth_headers, inv, sp12["c0"], 1).status_code == 400   # same address
        assert _move(client, auth_headers, inv, 99999999, 1).status_code == 404
        from tests.test_sea import STAGING_BIN
        staging = _move(client, auth_headers, inv, STAGING_BIN, 1)
        assert staging.status_code == 409 and "recebimento" in staging.get_json()["error"]
        assert _qty(stored_ot["conn"], sp12["c0"]) == 10

    def test_box_material_moves_in_whole_boxes(self, client, auth_headers, stored_ot, sp12):
        conn = stored_ot["conn"]
        conn.execute(text("UPDATE items SET uom = 'KG', pack_weight_kg = 5 WHERE item_id = :i"),
                     {"i": stored_ot["small"]})
        part = _move(client, auth_headers, stored_ot["inventory_id"], sp12["b0"], 3)
        assert part.status_code == 400 and "caixa de 5 KG" in part.get_json()["error"]
        assert _move(client, auth_headers, stored_ot["inventory_id"], sp12["b0"], 5).status_code == 200

    def test_permissions_and_location_scope(
        self, client, stored_ot, sp12, other_location
    ):
        conn = stored_ot["conn"]
        inv = stored_ot["inventory_id"]
        no_page = _user(client, conn, "sea.transf.1", ["retirada"], [WAREHOUSE])
        assert _move(client, no_page, inv, sp12["b0"], 1).status_code == 403
        local = _user(client, conn, "sea.transf.2", ["items"], [WAREHOUSE])
        # Same location: allowed. Another location the user does not work in: refused.
        assert _move(client, local, inv, sp12["b0"], 1).status_code == 200
        assert _move(client, local, inv, other_location["shelf"], 1).status_code == 403
        assert _qty(conn, sp12["c0"]) == 9


class TestOrderIsTheMainName:
    """The operation names a material by its order (PM11 / PM12); the OT
    is the document it arrived with."""

    def test_stock_rows_carry_the_order(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        resp = client.post(
            "/api/sea/recebimentos", headers=auth_headers,
            json={"warehouse_id": WAREHOUSE,
                  "header": {"ot_code": "OT-ORD-N1", "service_order_type": "PM11"},
                  "materials": [
                      {"material_code": "ON-A", "description": "A", "quantity": 6,
                       "service_order_number": "2000000801", "service_order_type": "PM11"},
                      {"material_code": "ON-B", "description": "B", "quantity": 4,
                       "service_order_number": "2000000802", "service_order_type": "PM12"},
                  ]},
        )
        assert resp.status_code == 201, resp.get_json()
        po_id = resp.get_json()["po_id"]
        items = {r.sku: r.item_id for r in conn.execute(
            text("SELECT sku, item_id FROM items WHERE sku IN ('ON-A', 'ON-B')")).fetchall()}
        from tests.test_sea import STAGING_BIN
        received = client.post("/api/receiving/receive", headers=auth_headers, json={
            "po_id": po_id, "items": [
                {"item_id": items["ON-A"], "quantity": 6, "bin_id": STAGING_BIN},
                {"item_id": items["ON-B"], "quantity": 2, "bin_id": STAGING_BIN}]})
        assert received.status_code == 200, received.get_json()

        # Waiting for storage: each material with its own order.
        pending = client.get("/api/sea/armazenagem/pendentes", headers=auth_headers).get_json()
        mine = {p["sku"]: (p["order_type"], p["order_number"], p["ot"])
                for p in pending["pending_items"] if p["ot"] == "OT-ORD-N1"}
        assert mine == {"ON-A": ("PM11", "2000000801", "OT-ORD-N1"),
                        "ON-B": ("PM12", "2000000802", "OT-ORD-N1")}

        from tests.test_sea import _putaway
        assert _putaway(client, auth_headers, items["ON-A"], sp12["c0"], 6, "OT-ORD-N1").status_code == 200

        # One row per order, with the OT as a reference.
        rows = {r["order_number"]: r for r in client.get(
            f"/api/sea/ordens?warehouse_id={WAREHOUSE}&q=20000008", headers=auth_headers
        ).get_json()["orders"]}
        a, b = rows["2000000801"], rows["2000000802"]
        assert (a["order_type"], a["ot"], a["status"], a["qty_ordered"], a["qty_received"],
                a["qty_staging"], a["qty_stored"]) == ("PM11", "OT-ORD-N1", "RECEIVED", 6, 6, 0, 6)
        assert a["bins"].endswith("T-C0") and a["received_at"]
        assert (b["order_type"], b["status"], b["qty_ordered"], b["qty_received"],
                b["qty_staging"], b["qty_stored"], b["bins"]) == ("PM12", "PARTIAL", 4, 2, 2, 0, None)
        only_pm12 = client.get(
            f"/api/sea/ordens?warehouse_id={WAREHOUSE}&order_type=PM12&q=20000008",
            headers=auth_headers).get_json()["orders"]
        assert [r["order_number"] for r in only_pm12] == ["2000000802"]

        # Address contents and the transfer list name the order too.
        estoque = client.get(f"/api/sea/estoque?warehouse_id={WAREHOUSE}",
                             headers=auth_headers).get_json()
        stored = next(c for bin_ in estoque["bins"] for c in bin_["contents"] if c["sku"] == "ON-A")
        assert (stored["order_number"], stored["order_type"], stored["ot"]) == (
            "2000000801", "PM11", "OT-ORD-N1")
        (row,) = client.get(f"/api/sea/materiais/{items['ON-A']}/estoque",
                            headers=auth_headers).get_json()["stock"]
        assert (row["order_number"], row["order_type"]) == ("2000000801", "PM11")

        # A withdrawal is named by the order of what was requested.
        wd = _request(client, auth_headers, row["inventory_id"], 1, ot="OT-ORD-N1")
        assert wd.status_code == 201, wd.get_json()
        body = wd.get_json()["withdrawal"]
        assert body["orders"] == ["PM11 2000000801"]
        assert body["lines"][0]["order_number"] == "2000000801"
        title = conn.execute(
            text("SELECT title FROM sea_notifications WHERE kind = 'RETIRADA_SOLICITADA' "
                 "ORDER BY notification_id DESC LIMIT 1")).scalar()
        assert "Ordem PM11 2000000801 (OT OT-ORD-N1)" in title
