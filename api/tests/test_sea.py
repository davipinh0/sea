"""SEA: OT (PM11/PM12) receiving, SP12 storage rules and terminal withdrawals.

Each test runs inside the conftest transaction (rolled back afterwards),
so the SP12 fixtures below are created fresh per test on top of the
standard seed (warehouse 1, staging bin 1).
"""

import uuid

import pytest
from sqlalchemy import text

WAREHOUSE = 1
STAGING_BIN = 1


def _bin(conn, code, *, size_class=None, capacity=None):
    zone_id = conn.execute(text("SELECT zone_id FROM bins WHERE bin_id = 3")).scalar()
    return conn.execute(
        text(
            """
            INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type,
                              putaway_sequence, size_class, capacity_units, external_id)
            VALUES (:z, :w, :c, :c, 'Pickable', :seq, :size, :cap, :ext)
            RETURNING bin_id
            """
        ),
        {
            "z": zone_id,
            "w": WAREHOUSE,
            "c": code,
            "seq": 9000 + len(code),
            "size": size_class,
            "cap": capacity,
            "ext": str(uuid.uuid4()),
        },
    ).scalar()


def _item(conn, sku, *, size_class=None, compat_group=None):
    return conn.execute(
        text(
            """
            INSERT INTO items (sku, item_name, size_class, compat_group, external_id)
            VALUES (:s, :s, :size, :grp, :ext) RETURNING item_id
            """
        ),
        {"s": sku, "size": size_class, "grp": compat_group, "ext": str(uuid.uuid4())},
    ).scalar()


def _create_ot(client, headers, number, lines, order_type="PM11"):
    resp = client.post(
        "/api/admin/purchase-orders",
        headers=headers,
        json={
            "po_number": number,
            "warehouse_id": WAREHOUSE,
            "order_type": order_type,
            "lines": [
                {"item_id": i, "quantity_ordered": q, "line_number": n + 1}
                for n, (i, q) in enumerate(lines)
            ],
        },
    )
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()["purchase_order"]["po_id"]


def _receive(client, headers, po_id, item_id, qty, lot=None):
    return client.post(
        "/api/receiving/receive",
        headers=headers,
        json={
            "po_id": po_id,
            "items": [
                {"item_id": item_id, "quantity": qty, "bin_id": STAGING_BIN, "lot_number": lot}
            ],
        },
    )


def _putaway(client, headers, item_id, to_bin, qty, lot):
    return client.post(
        "/api/putaway/confirm",
        headers=headers,
        json={
            "item_id": item_id,
            "from_bin_id": STAGING_BIN,
            "to_bin_id": to_bin,
            "quantity": qty,
            "lot_number": lot,
        },
    )


def _inv(conn, item_id, bin_id, lot):
    return conn.execute(
        text(
            """
            SELECT inventory_id, quantity_on_hand, quantity_allocated FROM inventory
            WHERE item_id = :i AND bin_id = :b AND lot_number IS NOT DISTINCT FROM :l
            """
        ),
        {"i": item_id, "b": bin_id, "l": lot},
    ).fetchone()


@pytest.fixture()
def sp12(_db_transaction):
    conn = _db_transaction
    return {
        "conn": conn,
        "small": _item(conn, "SEA-SMALL", size_class="PEQUENO", compat_group="FIX"),
        "small2": _item(conn, "SEA-SMALL2", size_class="PEQUENO", compat_group="FIX"),
        "other": _item(conn, "SEA-OTHER", compat_group="HIDR"),
        "a3": _bin(conn, "T-A3", size_class="PEQUENO"),
        "b0": _bin(conn, "T-B0", capacity=10),
        "c0": _bin(conn, "T-C0"),
    }


# ------------------------------------------------------------ OT intake


class TestOtReceiving:
    def test_ot_type_is_stored_and_listed(self, client, auth_headers, sp12):
        po_id = _create_ot(client, auth_headers, "OT-T-1", [(sp12["small"], 5)], "PM12")
        detail = client.get(f"/api/admin/purchase-orders/{po_id}", headers=auth_headers).get_json()
        assert detail["purchase_order"]["order_type"] == "PM12"
        listed = client.get(
            f"/api/sea/ots?warehouse_id={WAREHOUSE}&order_type=PM12", headers=auth_headers
        ).get_json()["ots"]
        assert [o["ot"] for o in listed] == ["OT-T-1"]

    def test_invalid_order_type_rejected(self, client, auth_headers, sp12):
        resp = client.post(
            "/api/admin/purchase-orders",
            headers=auth_headers,
            json={
                "po_number": "OT-BAD",
                "warehouse_id": WAREHOUSE,
                "order_type": "PM99",
                "lines": [{"item_id": sp12["small"], "quantity_ordered": 1}],
            },
        )
        assert resp.status_code in (400, 422)

    def test_receipt_is_tagged_with_ot_number(self, client, auth_headers, sp12):
        po_id = _create_ot(client, auth_headers, "OT-T-2", [(sp12["small"], 10)])
        # Partial receipt; the client-supplied lot is overridden by the OT.
        resp = _receive(client, auth_headers, po_id, sp12["small"], 4, lot="IGNORED")
        assert resp.status_code == 200, resp.get_json()
        inv = _inv(sp12["conn"], sp12["small"], STAGING_BIN, "OT-T-2")
        assert inv is not None and inv.quantity_on_hand == 4
        assert _inv(sp12["conn"], sp12["small"], STAGING_BIN, "IGNORED") is None
        status = (
            sp12["conn"]
            .execute(text("SELECT status FROM purchase_orders WHERE po_id = :p"), {"p": po_id})
            .scalar()
        )
        assert status == "PARTIAL"

    def test_ot_lookup_by_barcode(self, client, auth_headers, sp12):
        _create_ot(client, auth_headers, "OT-T-3", [(sp12["small"], 2)])
        resp = client.get("/api/receiving/po/OT-T-3", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["purchase_order"]["order_type"] == "PM11"


# ------------------------------------------------------- SP12 storage


class TestSp12Rules:
    def _staged(self, client, headers, sp12, number, item_key, qty):
        po_id = _create_ot(client, headers, number, [(sp12[item_key], qty)])
        assert _receive(client, headers, po_id, sp12[item_key], qty).status_code == 200
        return number

    def test_an_order_may_be_spread_over_several_addresses(self, client, auth_headers, sp12):
        ot = self._staged(client, auth_headers, sp12, "OT-S-1", "small", 6)
        assert _putaway(client, auth_headers, sp12["small"], sp12["c0"], 3, ot).status_code == 200
        resp = _putaway(client, auth_headers, sp12["small"], sp12["b0"], 3, ot)
        assert resp.status_code == 200, resp.get_json()
        assert _inv(sp12["conn"], sp12["small"], sp12["c0"], ot).quantity_on_hand == 3
        assert _inv(sp12["conn"], sp12["small"], sp12["b0"], ot).quantity_on_hand == 3

    def test_size_class_reserved_address(self, client, auth_headers, sp12):
        ot = self._staged(client, auth_headers, sp12, "OT-S-2", "other", 2)
        resp = _putaway(client, auth_headers, sp12["other"], sp12["a3"], 2, ot)
        assert resp.status_code == 409
        assert "PEQUENO" in resp.get_json()["error"]
        ot2 = self._staged(client, auth_headers, sp12, "OT-S-3", "small", 2)
        assert _putaway(client, auth_headers, sp12["small"], sp12["a3"], 2, ot2).status_code == 200

    def test_capacity_is_enforced_only_when_configured(self, client, auth_headers, sp12):
        ot = self._staged(client, auth_headers, sp12, "OT-S-4", "small", 12)
        resp = _putaway(client, auth_headers, sp12["small"], sp12["b0"], 11, ot)
        assert resp.status_code == 409
        assert "Capacidade" in resp.get_json()["error"]
        assert _putaway(client, auth_headers, sp12["small"], sp12["b0"], 10, ot).status_code == 200

    def test_compatibility_groups(self, client, auth_headers, sp12):
        ot1 = self._staged(client, auth_headers, sp12, "OT-S-5", "small", 2)
        assert _putaway(client, auth_headers, sp12["small"], sp12["c0"], 2, ot1).status_code == 200
        ot2 = self._staged(client, auth_headers, sp12, "OT-S-6", "small2", 2)
        assert _putaway(client, auth_headers, sp12["small2"], sp12["c0"], 2, ot2).status_code == 200
        ot3 = self._staged(client, auth_headers, sp12, "OT-S-7", "other", 2)
        resp = _putaway(client, auth_headers, sp12["other"], sp12["c0"], 2, ot3)
        assert resp.status_code == 409
        assert "compatível" in resp.get_json()["error"]

    def test_suggestion_prefers_address_holding_the_ot(self, client, auth_headers, sp12):
        ot = self._staged(client, auth_headers, sp12, "OT-S-8", "small", 4)
        assert _putaway(client, auth_headers, sp12["small"], sp12["c0"], 2, ot).status_code == 200
        inv = _inv(sp12["conn"], sp12["small"], STAGING_BIN, ot)
        resp = client.get(f"/api/sea/armazenagem/sugestao/{inv.inventory_id}", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json()["bin_code"] == "T-C0"

    def test_non_ot_putaway_is_unaffected(self, client, auth_headers, sp12):
        # Plain stock (no OT lot) ignores SP12 rules, as in Sentry.
        conn = sp12["conn"]
        conn.execute(
            text(
                "INSERT INTO inventory (item_id, bin_id, warehouse_id, quantity_on_hand) "
                "VALUES (:i, :b, :w, 5)"
            ),
            {"i": sp12["other"], "b": STAGING_BIN, "w": WAREHOUSE},
        )
        assert _putaway(client, auth_headers, sp12["other"], sp12["a3"], 5, None).status_code == 200


# ---------------------------------------------------------- Withdrawals


@pytest.fixture()
def stored_ot(client, auth_headers, sp12):
    """OT-W-1: 10 units of 'small' stored in T-C0."""
    po_id = _create_ot(client, auth_headers, "OT-W-1", [(sp12["small"], 10)])
    assert _receive(client, auth_headers, po_id, sp12["small"], 10).status_code == 200
    assert (
        _putaway(client, auth_headers, sp12["small"], sp12["c0"], 10, "OT-W-1").status_code == 200
    )
    inv = _inv(sp12["conn"], sp12["small"], sp12["c0"], "OT-W-1")
    return {**sp12, "inventory_id": inv.inventory_id}


def _request(client, headers, inventory_id, qty, ot="OT-W-1"):
    return client.post(
        "/api/sea/retiradas",
        headers=headers,
        json={"ot": ot, "lines": [{"inventory_id": inventory_id, "quantity": qty}]},
    )


def _step(client, headers, wid, action, body=None):
    return client.post(f"/api/sea/retiradas/{wid}/{action}", headers=headers, json=body or {})


def _stock(conn, inventory_id):
    return conn.execute(
        text("SELECT quantity_on_hand, quantity_allocated FROM inventory WHERE inventory_id = :i"),
        {"i": inventory_id},
    ).fetchone()


class TestWithdrawals:
    def test_terminal_ot_lookup_lists_available_stock(self, client, auth_headers, stored_ot):
        data = client.get("/api/sea/ots/OT-W-1", headers=auth_headers).get_json()
        assert data["ot"]["order_type"] == "PM11"
        stored = [s for s in data["stock"] if s["stored"]]
        assert stored == [
            s for s in data["stock"] if s["inventory_id"] == stored_ot["inventory_id"]
        ]
        assert stored[0]["available"] == 10

    def test_full_flow_reserves_then_decrements_once(self, client, auth_headers, stored_ot):
        inv_id = stored_ot["inventory_id"]
        resp = _request(client, auth_headers, inv_id, 4)
        assert resp.status_code == 201, resp.get_json()
        wid = resp.get_json()["withdrawal"]["withdrawal_id"]
        assert tuple(_stock(stored_ot["conn"], inv_id)) == (10, 4)  # reserved, not removed

        # Cannot deliver before separation is finished.
        assert _step(client, auth_headers, wid, "entregar").status_code == 409
        assert _step(client, auth_headers, wid, "separar").status_code == 200
        assert _step(client, auth_headers, wid, "pronta").status_code == 200

        # The employee who requested it (the logged-in user) confirms.
        resp = _step(client, auth_headers, wid, "entregar")
        assert resp.status_code == 200, resp.get_json()
        body = resp.get_json()["withdrawal"]
        admin_name = (
            stored_ot["conn"]
            .execute(text("SELECT full_name FROM users WHERE username = 'admin'"))
            .scalar()
        )
        assert body["status"] == "DELIVERED" and body["delivered_to"] == admin_name
        assert body["confirmed_by"] == "admin"
        assert tuple(_stock(stored_ot["conn"], inv_id)) == (6, 0)

        # Duplicate confirmation is refused and stock is untouched.
        again = _step(client, auth_headers, wid, "entregar")
        assert again.status_code == 409
        assert tuple(_stock(stored_ot["conn"], inv_id)) == (6, 0)

        audit = (
            stored_ot["conn"]
            .execute(
                text(
                    "SELECT action_type FROM audit_log WHERE entity_type = 'WITHDRAWAL' "
                    "AND entity_id = :w ORDER BY log_id"
                ),
                {"w": wid},
            )
            .scalars()
            .all()
        )
        assert audit == [
            "WITHDRAWAL_REQUESTED",
            "WITHDRAWAL_PICKING",
            "WITHDRAWAL_READY",
            "WITHDRAWAL_DELIVERED",
        ]

    def test_cannot_request_more_than_available(self, client, auth_headers, stored_ot):
        inv_id = stored_ot["inventory_id"]
        assert _request(client, auth_headers, inv_id, 11).status_code == 409
        assert _request(client, auth_headers, inv_id, 7).status_code == 201
        # Only 3 left unreserved.
        resp = _request(client, auth_headers, inv_id, 4)
        assert resp.status_code == 409
        assert resp.get_json()["available"] == 3
        assert tuple(_stock(stored_ot["conn"], inv_id)) == (10, 7)

    def test_cancel_releases_the_reservation(self, client, auth_headers, stored_ot):
        inv_id = stored_ot["inventory_id"]
        wid = _request(client, auth_headers, inv_id, 5).get_json()["withdrawal"]["withdrawal_id"]
        assert _step(client, auth_headers, wid, "separar").status_code == 200
        assert _step(client, auth_headers, wid, "cancelar", {"reason": "teste"}).status_code == 200
        assert tuple(_stock(stored_ot["conn"], inv_id)) == (10, 0)
        assert _step(client, auth_headers, wid, "cancelar", {"reason": "de novo"}).status_code == 409

    def test_cancel_requires_a_reason(self, client, auth_headers, stored_ot):
        inv_id = stored_ot["inventory_id"]
        wid = _request(client, auth_headers, inv_id, 5).get_json()["withdrawal"]["withdrawal_id"]
        for body in ({}, {"reason": ""}, {"reason": "   "}, {"reason": None}):
            assert _step(client, auth_headers, wid, "cancelar", body).status_code == 400, body
        # Still open and still reserved.
        assert tuple(_stock(stored_ot["conn"], inv_id)) == (10, 5)
        current = client.get(f"/api/sea/retiradas/{wid}", headers=auth_headers).get_json()
        assert current["withdrawal"]["status"] == "REQUESTED"

    def test_cancelled_withdrawal_stays_on_record(self, client, auth_headers, stored_ot):
        wid = _request(client, auth_headers, stored_ot["inventory_id"], 2).get_json()["withdrawal"][
            "withdrawal_id"
        ]
        assert (
            _step(client, auth_headers, wid, "cancelar", {"reason": "pedido errado"}).status_code
            == 200
        )
        saved = client.get(f"/api/sea/retiradas/{wid}", headers=auth_headers).get_json()[
            "withdrawal"
        ]
        assert saved["status"] == "CANCELLED" and saved["cancel_reason"] == "pedido errado"
        assert saved["cancelled_by"] == "admin" and saved["lines"][0]["quantity"] == 2
        listed = client.get(
            f"/api/sea/retiradas?warehouse_id={WAREHOUSE}&status=CANCELLED", headers=auth_headers
        ).get_json()["withdrawals"]
        assert wid in [w["withdrawal_id"] for w in listed]

    def test_only_the_requester_confirms_the_delivery(self, client, auth_headers, stored_ot):
        import bcrypt

        conn = stored_ot["conn"]
        user_id = conn.execute(
            text(
                """
                INSERT INTO users (username, password_hash, full_name, role, warehouse_id,
                                   warehouse_ids, email, external_id)
                VALUES ('retirada.t', :pw, 'Retirada Teste', 'USER', 1, ARRAY[1],
                        'Retirada.T@empresa.example', :ext)
                RETURNING user_id
                """
            ),
            {"pw": bcrypt.hashpw(b"Senha123", bcrypt.gensalt()).decode(), "ext": str(uuid.uuid4())},
        ).scalar()
        conn.execute(
            text("INSERT INTO user_page_permissions (user_id, page_key) VALUES (:u, 'retirada')"),
            {"u": user_id},
        )
        # The corporate e-mail (any case) logs in as that user.
        login = client.post(
            "/api/auth/login",
            json={"username": "retirada.t@EMPRESA.example", "password": "Senha123"},
        )
        assert login.status_code == 200, login.get_json()
        assert login.get_json()["user"]["username"] == "retirada.t"
        employee = {"Authorization": f"Bearer {login.get_json()['token']}"}
        unknown = client.post(
            "/api/auth/login", json={"username": "ninguem@empresa.example", "password": "Senha123"}
        )
        assert unknown.status_code == 401

        inv_id = stored_ot["inventory_id"]
        wid = _request(client, employee, inv_id, 3).get_json()["withdrawal"]["withdrawal_id"]
        for action in ("separar", "pronta"):
            assert _step(client, auth_headers, wid, action).status_code == 200

        # Somebody else (even an admin) cannot take the delivery.
        other = _step(client, auth_headers, wid, "entregar")
        assert other.status_code == 403
        assert tuple(_stock(conn, inv_id)) == (10, 3)

        mine = _step(client, employee, wid, "entregar")
        assert mine.status_code == 200, mine.get_json()
        assert mine.get_json()["withdrawal"]["delivered_to"] == "Retirada Teste"
        assert tuple(_stock(conn, inv_id)) == (7, 0)

    def test_staging_stock_cannot_be_withdrawn(self, client, auth_headers, sp12):
        po_id = _create_ot(client, auth_headers, "OT-W-2", [(sp12["small"], 3)])
        _receive(client, auth_headers, po_id, sp12["small"], 3)
        inv = _inv(sp12["conn"], sp12["small"], STAGING_BIN, "OT-W-2")
        resp = _request(client, auth_headers, inv.inventory_id, 1, ot="OT-W-2")
        assert resp.status_code == 409
        assert "recebimento" in resp.get_json()["error"]

    def test_stock_of_another_ot_is_refused(self, client, auth_headers, stored_ot):
        _create_ot(client, auth_headers, "OT-W-3", [(stored_ot["small"], 1)])
        resp = _request(client, auth_headers, stored_ot["inventory_id"], 1, ot="OT-W-3")
        assert resp.status_code == 400

    def test_requires_retirada_permission(self, client, stored_ot):
        import bcrypt

        stored_ot["conn"].execute(
            text(
                """
                INSERT INTO users (username, password_hash, full_name, role, warehouse_id,
                                   warehouse_ids, external_id)
                VALUES ('sem.retirada', :pw, 'Sem permissão', 'USER', 1, ARRAY[1], :ext)
                """
            ),
            {"pw": bcrypt.hashpw(b"Senha123", bcrypt.gensalt()).decode(), "ext": str(uuid.uuid4())},
        )
        token = client.post(
            "/api/auth/login", json={"username": "sem.retirada", "password": "Senha123"}
        ).get_json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        assert (
            client.get(f"/api/sea/retiradas?warehouse_id={WAREHOUSE}", headers=headers).status_code
            == 403
        )
        assert _request(client, headers, stored_ot["inventory_id"], 1).status_code == 403


class TestPainelAndKeys:
    def test_retirada_is_a_grantable_page_key(self):
        from constants import ALL_PAGE_KEYS

        assert "retirada" in ALL_PAGE_KEYS

    def test_painel_counts(self, client, auth_headers, stored_ot):
        _request(client, auth_headers, stored_ot["inventory_id"], 2)
        data = client.get(
            f"/api/sea/painel?warehouse_id={WAREHOUSE}", headers=auth_headers
        ).get_json()
        assert data["pending_withdrawals"] >= 1
        assert data["stored_units"] >= 10
        assert "PM11" in data["ots"]

    def test_estoque_shows_ot_in_address(self, client, auth_headers, stored_ot):
        data = client.get(
            f"/api/sea/estoque?warehouse_id={WAREHOUSE}", headers=auth_headers
        ).get_json()
        c0 = next(b for b in data["bins"] if b["bin_code"] == "T-C0")
        assert c0["units"] == 10
        assert c0["contents"][0]["ot"] == "OT-W-1" and c0["contents"][0]["order_type"] == "PM11"

    def test_email_is_unique_across_users(self, client, auth_headers, stored_ot):
        stored_ot["conn"].execute(
            text("UPDATE users SET email = 'adm@empresa.example' WHERE username = 'admin'")
        )
        resp = client.post(
            "/api/admin/users",
            headers=auth_headers,
            json={
                "username": "outro",
                "password": "Senha123",
                "full_name": "Outro",
                "role": "USER",
                "email": "ADM@empresa.example",
            },
        )
        assert resp.status_code == 400
        assert "E-mail" in resp.get_json()["error"]

    def test_user_email_is_validated_and_saved(self, client, auth_headers, stored_ot):
        base = {"username": "novo", "password": "Senha123", "full_name": "Novo", "role": "USER"}
        bad = client.post("/api/admin/users", headers=auth_headers, json={**base, "email": "x"})
        assert bad.status_code == 400
        ok = client.post(
            "/api/admin/users", headers=auth_headers, json={**base, "email": "novo@empresa.example"}
        )
        assert ok.status_code == 201, ok.get_json()
        assert ok.get_json()["email"] == "novo@empresa.example"
        cleared = client.put(
            f"/api/admin/users/{ok.get_json()['user_id']}", headers=auth_headers, json={"email": ""}
        )
        assert cleared.status_code == 200 and cleared.get_json()["email"] is None


class TestCsvImport:
    def test_ot_import_keeps_order_type_and_tolerates_blank_cells(self, client, auth_headers, sp12):
        resp = client.post(
            "/api/admin/import/purchase-orders",
            headers=auth_headers,
            json={
                "records": [
                    {
                        "po_number": "OT-CSV-1",
                        "order_type": "PM12",
                        "warehouse_id": WAREHOUSE,
                        "vendor": "SAP (simulado)",
                        "sku": "SEA-SMALL",
                        "quantity": "5",
                        "expected_date": "",
                    },
                    {
                        "po_number": "OT-CSV-1",
                        "order_type": "PM12",
                        "warehouse_id": WAREHOUSE,
                        "vendor": "",
                        "sku": "SEA-OTHER",
                        "quantity": "2",
                        "expected_date": " ",
                    },
                ],
            },
        )
        assert resp.status_code == 200, resp.get_json()
        row = (
            sp12["conn"]
            .execute(
                text("SELECT po_id, order_type FROM purchase_orders WHERE po_number = 'OT-CSV-1'")
            )
            .fetchone()
        )
        assert row.order_type == "PM12"
        lines = (
            sp12["conn"]
            .execute(
                text("SELECT COUNT(*) FROM purchase_order_lines WHERE po_id = :p"), {"p": row.po_id}
            )
            .scalar()
        )
        assert lines == 2

    def test_invalid_order_type_row_is_rejected(self, client, auth_headers, sp12):
        resp = client.post(
            "/api/admin/import/purchase-orders",
            headers=auth_headers,
            json={
                "records": [
                    {
                        "po_number": "OT-CSV-2",
                        "order_type": "XX",
                        "warehouse_id": WAREHOUSE,
                        "sku": "SEA-SMALL",
                        "quantity": "1",
                    }
                ],
            },
        )
        created = (
            sp12["conn"]
            .execute(text("SELECT COUNT(*) FROM purchase_orders WHERE po_number = 'OT-CSV-2'"))
            .scalar()
        )
        assert created == 0, resp.get_json()

    def test_item_and_bin_import_carry_sp12_rules(self, client, auth_headers, sp12):
        r1 = client.post(
            "/api/admin/import/items",
            headers=auth_headers,
            json={
                "records": [
                    {
                        "sku": "SEA-CSV-I",
                        "name": "Item CSV",
                        "size_class": "PEQUENO",
                        "compat_group": "FIX",
                        "upc": "",
                        "weight": "",
                        "quantity": "",
                    }
                ]
            },
        )
        assert r1.status_code == 200, r1.get_json()
        item = (
            sp12["conn"]
            .execute(text("SELECT size_class, compat_group FROM items WHERE sku = 'SEA-CSV-I'"))
            .fetchone()
        )
        assert (item.size_class, item.compat_group) == ("PEQUENO", "FIX")
        zone = (
            sp12["conn"]
            .execute(text("SELECT zone_code FROM zones WHERE warehouse_id = 1 LIMIT 1"))
            .scalar()
        )
        r2 = client.post(
            "/api/admin/import/bins",
            headers=auth_headers,
            json={
                "records": [
                    {
                        "bin_code": "T-CSV",
                        "zone": zone,
                        "warehouse_id": WAREHOUSE,
                        "bin_type": "Pickable",
                        "capacity_units": "40",
                        "size_class": "",
                        "pick_sequence": "",
                    }
                ]
            },
        )
        assert r2.status_code == 200, r2.get_json()
        b = (
            sp12["conn"]
            .execute(text("SELECT capacity_units, size_class FROM bins WHERE bin_code = 'T-CSV'"))
            .fetchone()
        )
        assert (b.capacity_units, b.size_class) == (40, None)


class TestMobileSuggestion:
    def test_suggestion_by_item_bin_and_lot(self, client, auth_headers, sp12):
        po_id = _create_ot(client, auth_headers, "OT-M-1", [(sp12["small"], 3)])
        assert _receive(client, auth_headers, po_id, sp12["small"], 3).status_code == 200
        resp = client.get(
            f"/api/sea/armazenagem/sugestao?item_id={sp12['small']}&bin_id={STAGING_BIN}&lot=OT-M-1",
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.get_json()
        assert resp.get_json()["bin_code"] is not None
        missing = client.get(
            f"/api/sea/armazenagem/sugestao?item_id={sp12['small']}&bin_id={STAGING_BIN}&lot=NOPE",
            headers=auth_headers,
        )
        assert missing.status_code == 404


# ------------------------------------------- Review fixes (regressions)


class TestReservationIntegrity:
    def test_receipt_cancel_refused_once_ot_was_stored(self, client, auth_headers, sp12):
        po_id = _create_ot(client, auth_headers, "OT-R-1", [(sp12["small"], 5)])
        rids = _receive(client, auth_headers, po_id, sp12["small"], 5).get_json()["receipt_ids"]
        assert (
            _putaway(client, auth_headers, sp12["small"], sp12["c0"], 5, "OT-R-1").status_code
            == 200
        )
        resp = client.post(
            "/api/receiving/cancel",
            headers=auth_headers,
            json={"po_id": po_id, "receipt_ids": rids},
        )
        assert resp.status_code == 409 and resp.get_json()["user_facing"] is True
        assert _inv(sp12["conn"], sp12["small"], sp12["c0"], "OT-R-1").quantity_on_hand == 5
        assert sp12["conn"].execute(
            text("SELECT COUNT(*) FROM item_receipts WHERE receipt_id = ANY(:r)"), {"r": rids}
        ).scalar() == len(rids)

    def test_receipt_cancel_still_works_before_putaway(self, client, auth_headers, sp12):
        po_id = _create_ot(client, auth_headers, "OT-R-2", [(sp12["small"], 5)])
        rids = _receive(client, auth_headers, po_id, sp12["small"], 5).get_json()["receipt_ids"]
        resp = client.post(
            "/api/receiving/cancel",
            headers=auth_headers,
            json={"po_id": po_id, "receipt_ids": rids},
        )
        assert resp.status_code == 200, resp.get_json()
        assert _inv(sp12["conn"], sp12["small"], STAGING_BIN, "OT-R-2").quantity_on_hand == 0

    def test_reserved_ot_stock_cannot_be_moved(self, client, auth_headers, stored_ot):
        inv_id = stored_ot["inventory_id"]
        assert _request(client, auth_headers, inv_id, 8).status_code == 201

        def move(qty):
            return client.post(
                "/api/transfers/move",
                headers=auth_headers,
                json={
                    "item_id": stored_ot["small"],
                    "from_bin_id": stored_ot["c0"],
                    "to_bin_id": stored_ot["b0"],
                    "quantity": qty,
                    "lot_number": "OT-W-1",
                },
            )

        assert move(3).status_code >= 400  # only 2 are free
        assert tuple(_stock(stored_ot["conn"], inv_id)) == (10, 8)


class TestPainelPrivacy:
    def test_painel_shows_who_received_without_credentials(self, client, auth_headers, stored_ot):
        wid = _request(client, auth_headers, stored_ot["inventory_id"], 1).get_json()["withdrawal"][
            "withdrawal_id"
        ]
        for action in ("separar", "pronta"):
            assert _step(client, auth_headers, wid, action).status_code == 200
        assert _step(client, auth_headers, wid, "entregar").status_code == 200
        stored_ot["conn"].execute(
            text("UPDATE users SET email = 'adm@empresa.example' WHERE username = 'admin'")
        )
        resp = client.get(f"/api/sea/painel?warehouse_id={WAREHOUSE}", headers=auth_headers)
        assert "adm@empresa.example" not in resp.get_data(as_text=True)
        delivered = next(
            r for r in resp.get_json()["recent"] if r["action_type"] == "WITHDRAWAL_DELIVERED"
        )
        assert delivered["details"]["employee_name"]
