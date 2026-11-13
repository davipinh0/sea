"""SEA: deleting an order or a material with everything that belongs to it."""

from sqlalchemy import text

from tests.test_sea import (  # noqa: F401  (fixtures)
    _create_ot,
    _putaway,
    _receive,
    _request,
    sp12,
    stored_ot,
)
from tests.test_sea_acesso import _user
from tests.test_sea import WAREHOUSE


def _count(conn, sql, **params):
    return conn.execute(text(sql), params).scalar()


class TestDeleteOrder:
    def test_order_goes_with_stock_receipts_movements_and_withdrawals(
        self, client, auth_headers, stored_ot
    ):
        conn = stored_ot["conn"]
        po_id = _count(conn, "SELECT po_id FROM purchase_orders WHERE po_number = 'OT-W-1'")
        assert _request(client, auth_headers, stored_ot["inventory_id"], 2).status_code == 201
        item_id = stored_ot["small"]

        resp = client.delete(f"/api/sea/ots/{po_id}", headers=auth_headers)
        assert resp.status_code == 200, resp.get_json()
        assert resp.get_json()["stock_units_removed"] == 10

        assert _count(conn, "SELECT COUNT(*) FROM purchase_orders WHERE po_id = :p", p=po_id) == 0
        assert _count(conn, "SELECT COUNT(*) FROM inventory WHERE lot_number = 'OT-W-1'") == 0
        assert _count(conn, "SELECT COUNT(*) FROM item_receipts WHERE po_id = :p", p=po_id) == 0
        assert _count(conn, "SELECT COUNT(*) FROM withdrawals WHERE po_id = :p", p=po_id) == 0
        assert _count(conn, "SELECT COUNT(*) FROM bin_transfers WHERE lot_number = 'OT-W-1'") == 0
        # The material stays in the master, and the deletion is on record.
        assert _count(conn, "SELECT COUNT(*) FROM items WHERE item_id = :i", i=item_id) == 1
        assert _count(
            conn, "SELECT details->>'ot' FROM audit_log WHERE action_type = 'OT_DELETED' "
                  "ORDER BY log_id DESC LIMIT 1"
        ) == "OT-W-1"
        assert client.get("/api/sea/ots/OT-W-1", headers=auth_headers).status_code == 404

    def test_other_orders_are_untouched(self, client, auth_headers, stored_ot, sp12):
        conn = stored_ot["conn"]
        other = _create_ot(client, auth_headers, "OT-DEL-2", [(sp12["small"], 3)])
        assert _receive(client, auth_headers, other, sp12["small"], 3).status_code == 200
        po_id = _count(conn, "SELECT po_id FROM purchase_orders WHERE po_number = 'OT-W-1'")
        assert client.delete(f"/api/sea/ots/{po_id}", headers=auth_headers).status_code == 200
        assert _count(conn, "SELECT SUM(quantity_on_hand) FROM inventory "
                            "WHERE lot_number = 'OT-DEL-2'") == 3

    def test_only_an_administrator_deletes(self, client, stored_ot):
        conn = stored_ot["conn"]
        po_id = _count(conn, "SELECT po_id FROM purchase_orders WHERE po_number = 'OT-W-1'")
        headers = _user(client, conn, "sea.excl.1", ["purchase-orders", "items"], [WAREHOUSE])
        assert client.delete(f"/api/sea/ots/{po_id}", headers=headers).status_code == 403
        assert client.delete(
            f"/api/sea/materiais/{stored_ot['small']}", headers=headers
        ).status_code == 403
        assert _count(conn, "SELECT COUNT(*) FROM purchase_orders WHERE po_id = :p", p=po_id) == 1

    def test_unknown_order(self, client, auth_headers):
        assert client.delete("/api/sea/ots/99999999", headers=auth_headers).status_code == 404


class TestDeleteMaterial:
    def test_material_in_stock_and_in_an_order_is_deleted_everywhere(
        self, client, auth_headers, stored_ot
    ):
        """The case that used to be refused without any message."""
        conn = stored_ot["conn"]
        item_id = stored_ot["small"]
        assert _request(client, auth_headers, stored_ot["inventory_id"], 2).status_code == 201

        resp = client.delete(f"/api/sea/materiais/{item_id}", headers=auth_headers)
        assert resp.status_code == 200, resp.get_json()
        body = resp.get_json()
        assert body["stock_units_removed"] == 10
        # OT-W-1 had only this material: the order goes too.
        assert "OT-W-1" in body["orders_removed"]
        assert _count(conn, "SELECT COUNT(*) FROM items WHERE item_id = :i", i=item_id) == 0
        assert _count(conn, "SELECT COUNT(*) FROM inventory WHERE item_id = :i", i=item_id) == 0
        assert _count(conn, "SELECT COUNT(*) FROM purchase_orders WHERE po_number = 'OT-W-1'") == 0
        assert _count(conn, "SELECT COUNT(*) FROM withdrawal_lines WHERE item_id = :i", i=item_id) == 0

    def test_order_with_other_materials_is_kept(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        po_id = _create_ot(client, auth_headers, "OT-DEL-3",
                           [(sp12["small"], 2), (sp12["other"], 5)])
        assert _receive(client, auth_headers, po_id, sp12["other"], 5).status_code == 200

        resp = client.delete(f"/api/sea/materiais/{sp12['small']}", headers=auth_headers)
        assert resp.status_code == 200, resp.get_json()
        assert resp.get_json()["orders_removed"] == []
        assert _count(conn, "SELECT COUNT(*) FROM purchase_order_lines WHERE po_id = :p", p=po_id) == 1
        # The pending material is gone, so the order is fully received.
        assert _count(conn, "SELECT status FROM purchase_orders WHERE po_id = :p", p=po_id) == "RECEIVED"
        assert _count(conn, "SELECT SUM(quantity_on_hand) FROM inventory "
                            "WHERE lot_number = 'OT-DEL-3'") == 5

    def test_material_used_by_sales_orders_is_refused_with_a_reason(
        self, client, auth_headers, _db_transaction
    ):
        item_id = _count(_db_transaction, "SELECT item_id FROM sales_order_lines LIMIT 1")
        if item_id is None:
            return  # the test seed has no sales order
        resp = client.delete(f"/api/sea/materiais/{item_id}", headers=auth_headers)
        assert resp.status_code == 409
        assert resp.get_json()["user_facing"] is True
        assert _count(_db_transaction, "SELECT COUNT(*) FROM items WHERE item_id = :i", i=item_id) == 1
