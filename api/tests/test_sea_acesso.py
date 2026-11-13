"""SEA: what a non-administrator needs to work (locations, receiving
areas, the withdrawal queue of every location) and operator messages."""

import uuid

import bcrypt
import pytest
from sqlalchemy import text

from tests.test_sea import (  # noqa: F401  (fixtures)
    STAGING_BIN,
    WAREHOUSE,
    _create_ot,
    _putaway,
    _receive,
    _request,
    sp12,
    stored_ot,
)


def _user(client, conn, username, pages, warehouse_ids):
    user_id = conn.execute(
        text(
            """
            INSERT INTO users (username, password_hash, full_name, role, warehouse_id,
                               warehouse_ids, external_id)
            VALUES (:u, :pw, :u, 'USER', :w, :ws, :ext) RETURNING user_id
            """
        ),
        {"u": username, "pw": bcrypt.hashpw(b"Senha123", bcrypt.gensalt()).decode(),
         "w": warehouse_ids[0], "ws": warehouse_ids, "ext": str(uuid.uuid4())},
    ).scalar()
    for page in pages:
        conn.execute(
            text("INSERT INTO user_page_permissions (user_id, page_key) VALUES (:u, :p)"),
            {"u": user_id, "p": page},
        )
    token = client.post(
        "/api/auth/login", json={"username": username, "password": "Senha123"}
    ).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def second_location(_db_transaction):
    return _db_transaction.execute(
        text(
            "INSERT INTO warehouses (warehouse_code, warehouse_name) "
            "VALUES ('T-OUTRO', 'Outro local') RETURNING warehouse_id"
        )
    ).scalar()


class TestLocations:
    def test_any_user_lists_only_the_locations_they_work_in(
        self, client, auth_headers, sp12, second_location
    ):
        headers = _user(client, sp12["conn"], "sea.acesso.1", ["receiving"], [WAREHOUSE])
        # The administration endpoint stays closed to this user...
        assert client.get("/api/admin/warehouses", headers=headers).status_code == 403
        # ...but the location selector still gets its list.
        mine = client.get("/api/sea/locais", headers=headers).get_json()["warehouses"]
        assert [w["warehouse_id"] for w in mine] == [WAREHOUSE]
        everything = client.get("/api/sea/locais", headers=auth_headers).get_json()["warehouses"]
        assert second_location in [w["warehouse_id"] for w in everything]
        # A client without a session (the shared one keeps the login cookie).
        assert client.application.test_client().get("/api/sea/locais").status_code == 401

    def test_receiving_areas_without_the_addresses_permission(self, client, sp12, second_location):
        headers = _user(client, sp12["conn"], "sea.acesso.2", ["receiving"], [WAREHOUSE])
        resp = client.get(f"/api/sea/recebimentos/areas?warehouse_id={WAREHOUSE}", headers=headers)
        assert resp.status_code == 200
        bins = resp.get_json()["bins"]
        # Only receiving areas: the shelves created by the fixture are not listed.
        assert STAGING_BIN in [b["bin_id"] for b in bins]
        assert sp12["c0"] not in [b["bin_id"] for b in bins]
        other = client.get(
            f"/api/sea/recebimentos/areas?warehouse_id={second_location}", headers=headers
        )
        assert other.status_code in (403, 404)
        no_page = _user(client, sp12["conn"], "sea.acesso.3", ["retirada"], [WAREHOUSE])
        assert (
            client.get(
                f"/api/sea/recebimentos/areas?warehouse_id={WAREHOUSE}", headers=no_page
            ).status_code
            == 403
        )


class TestWithdrawalQueueAcrossLocations:
    def test_queue_without_a_location_shows_every_location_of_the_user(
        self, client, auth_headers, stored_ot, second_location
    ):
        wid = _request(client, auth_headers, stored_ot["inventory_id"], 2).get_json()["withdrawal"][
            "withdrawal_id"
        ]
        everything = client.get("/api/sea/retiradas?status=REQUESTED", headers=auth_headers)
        row = next(
            w for w in everything.get_json()["withdrawals"] if w["withdrawal_id"] == wid
        )
        assert row["warehouse_id"] == WAREHOUSE and row["warehouse_code"]

        # A user of another location does not see it, with or without the filter.
        outsider = _user(
            client, stored_ot["conn"], "sea.acesso.4", ["retirada"], [second_location]
        )
        listed = client.get("/api/sea/retiradas", headers=outsider).get_json()["withdrawals"]
        assert wid not in [w["withdrawal_id"] for w in listed]
        assert (
            client.get(f"/api/sea/retiradas?warehouse_id={WAREHOUSE}", headers=outsider).status_code
            in (403, 404)
        )

        # The menu counter covers every location the user works in.
        painel = client.get(
            f"/api/sea/painel?warehouse_id={second_location}", headers=auth_headers
        ).get_json()
        assert painel["pending_withdrawals"] == 0
        assert painel["pending_withdrawals_all"] >= 1


class TestOperatorMessages:
    def test_reversal_refusal_is_explained_in_portuguese(self, client, auth_headers, stored_ot):
        """The whole receipt was stored and part of it reserved: the
        receipt can no longer be reversed, and the operator is told why."""
        conn = stored_ot["conn"]
        _request(client, auth_headers, stored_ot["inventory_id"], 4)
        receipt_id = conn.execute(
            text(
                "SELECT receipt_id FROM item_receipts r JOIN purchase_orders p USING (po_id) "
                "WHERE p.po_number = 'OT-W-1'"
            )
        ).scalar()
        resp = client.post(
            f"/api/admin/receipts/{receipt_id}/unreceive", headers=auth_headers, json={}
        )
        assert resp.status_code == 409
        body = resp.get_json()
        assert body["user_facing"] is True and body["kind"] == "insufficient_available"
        assert body["error"].startswith("Não é possível estornar")
        assert conn.execute(
            text("SELECT quantity_on_hand FROM inventory WHERE inventory_id = :i"),
            {"i": stored_ot["inventory_id"]},
        ).scalar() == 10

    def test_storage_is_recorded_with_material_and_order(self, client, auth_headers, sp12):
        po_id = _create_ot(client, auth_headers, "OT-MSG-2", [(sp12["small"], 3)])
        _receive(client, auth_headers, po_id, sp12["small"], 3)
        _putaway(client, auth_headers, sp12["small"], sp12["c0"], 3, "OT-MSG-2")
        recent = client.get(
            f"/api/sea/painel?warehouse_id={WAREHOUSE}", headers=auth_headers
        ).get_json()["recent"]
        stored = next(r for r in recent if r["action_type"] == "PUTAWAY")
        assert stored["details"]["sku"] == "SEA-SMALL"
        assert stored["details"]["lot_number"] == "OT-MSG-2"
