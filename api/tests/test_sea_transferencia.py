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
        # The storage rules apply: an address that holds one unit refuses two.
        from tests.test_sea import _bin
        tight = _bin(stored_ot["conn"], "T-CAP1", capacity=1)
        full = _move(client, auth_headers, inv, tight, 2)
        assert full.status_code == 409 and "Capacidade" in full.get_json()["error"]
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
