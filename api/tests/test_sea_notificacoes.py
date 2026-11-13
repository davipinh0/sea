"""SEA: notifications (panel + e-mail) and the Materiais listing."""

import smtplib

import pytest
from sqlalchemy import text

from services import notification_service as notifications
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


def _rows(conn, kind=None):
    return conn.execute(
        text(
            "SELECT kind, title, message, ot, created_by, email_status FROM sea_notifications "
            "WHERE (CAST(:k AS TEXT) IS NULL OR kind = :k) ORDER BY notification_id"
        ),
        {"k": kind},
    ).fetchall()


class TestEvents:
    def test_receipt_and_storage_each_announce_once(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        po_id = _create_ot(client, auth_headers, "OT-N-1", [(sp12["small"], 10)])
        assert _rows(conn) == []

        assert _receive(client, auth_headers, po_id, sp12["small"], 10).status_code == 200
        (receipt,) = _rows(conn)
        assert receipt.kind == "RECEBIMENTO" and receipt.ot == "OT-N-1"
        assert "10 unidade(s)" in receipt.message and receipt.created_by == "admin"
        # No mail server in the test environment: recorded, not sent.
        assert receipt.email_status == "NAO_CONFIGURADO"

        # Part of the order still waits in the receiving area: no announcement.
        assert _putaway(client, auth_headers, sp12["small"], sp12["c0"], 4, "OT-N-1").status_code == 200
        assert _rows(conn, "ARMAZENAGEM_CONCLUIDA") == []
        assert _putaway(client, auth_headers, sp12["small"], sp12["c0"], 6, "OT-N-1").status_code == 200
        (done,) = _rows(conn, "ARMAZENAGEM_CONCLUIDA")
        assert "OT-N-1" in done.title and "T-C0" in done.message

    def test_withdrawal_request_announces_and_refusal_does_not(self, client, auth_headers, stored_ot):
        conn = stored_ot["conn"]
        assert _request(client, auth_headers, stored_ot["inventory_id"], 99).status_code == 409
        assert _rows(conn, "RETIRADA_SOLICITADA") == []
        wid = _request(client, auth_headers, stored_ot["inventory_id"], 3).get_json()["withdrawal"][
            "withdrawal_id"
        ]
        (row,) = _rows(conn, "RETIRADA_SOLICITADA")
        assert f"nº {wid}" in row.title and "3 x SEA-SMALL (T-C0)" in row.message

    def test_panel_lists_and_polls_after_an_id(self, client, auth_headers, stored_ot):
        # stored_ot already produced a receipt and a storage notification.
        data = client.get("/api/sea/notificacoes", headers=auth_headers).get_json()
        kinds = [n["kind"] for n in data["notifications"]]
        assert kinds[:2] == ["ARMAZENAGEM_CONCLUIDA", "RECEBIMENTO"]
        assert data["email_configured"] is False
        last = data["notifications"][0]["notification_id"]

        fresh = client.get(f"/api/sea/notificacoes?after={last}", headers=auth_headers).get_json()
        assert fresh["notifications"] == []
        _request(client, auth_headers, stored_ot["inventory_id"], 1)
        fresh = client.get(f"/api/sea/notificacoes?after={last}", headers=auth_headers).get_json()
        assert [n["kind"] for n in fresh["notifications"]] == ["RETIRADA_SOLICITADA"]

    def test_notifications_require_login(self, client):
        assert client.get("/api/sea/notificacoes").status_code == 401


@pytest.fixture()
def smtp_env(monkeypatch):
    monkeypatch.setenv("SEA_SMTP_HOST", "smtp.empresa.example")
    monkeypatch.setenv("SEA_SMTP_FROM", "sea@empresa.example")


def _pending(conn, kind):
    return notifications.create(
        conn, kind=kind, warehouse_id=WAREHOUSE, title="Título", message="Mensagem", ot="OT-1",
        username="admin",
    )


def _status(conn, notification_id):
    return conn.execute(
        text("SELECT email_status, email_error, email_sent_at FROM sea_notifications WHERE notification_id = :i"),
        {"i": notification_id},
    ).fetchone()


class TestEmail:
    def test_each_event_has_its_own_email_for_admins_only(self, _db_transaction, smtp_env):
        conn = _db_transaction
        conn.execute(text("UPDATE users SET email = 'adm@empresa.example' WHERE username = 'admin'"))
        conn.execute(
            text(
                """
                INSERT INTO users (username, password_hash, full_name, role, email, external_id)
                VALUES ('sea.notif.op', 'x', 'Operador', 'USER', 'op@empresa.example', gen_random_uuid()),
                       ('sea.notif.off', 'x', 'Admin inativo', 'ADMIN', 'off@empresa.example', gen_random_uuid())
                """
            )
        )
        conn.execute(text("UPDATE users SET is_active = FALSE WHERE username = 'sea.notif.off'"))
        sent = []
        subjects = set()
        for kind in notifications.SUBJECTS:
            nid = _pending(conn, kind)
            status = notifications.send_email(conn, nid, mailer=lambda cfg, msg: sent.append((cfg, msg)))
            assert status == "ENVIADO"
            assert _status(conn, nid).email_sent_at is not None
            subjects.add(sent[-1][1]["Subject"])
        assert len(subjects) == 3
        assert subjects == {
            "SEA - Solicitação de Retirada",
            "SEA - Recebimento de Materiais na Expedição",
            "SEA - Conclusão de Armazenamento",
        }
        assert {m["To"] for _, m in sent} == {"adm@empresa.example"}
        assert sent[0][0].host == "smtp.empresa.example" and sent[0][1]["From"] == "sea@empresa.example"
        assert "Mensagem" in sent[0][1].get_content()

    def test_sent_notification_is_never_mailed_twice(self, _db_transaction, smtp_env):
        conn = _db_transaction
        conn.execute(text("UPDATE users SET email = 'adm@empresa.example' WHERE username = 'admin'"))
        nid = _pending(conn, notifications.KIND_RECEIPT)
        calls = []
        notifications.send_email(conn, nid, mailer=lambda c, m: calls.append(m))
        assert notifications.send_email(conn, nid, mailer=lambda c, m: calls.append(m)) == "ENVIADO"
        assert len(calls) == 1

    def test_no_admin_email_and_mail_failure_are_recorded(self, _db_transaction, smtp_env):
        conn = _db_transaction
        conn.execute(text("UPDATE users SET email = NULL"))
        nid = _pending(conn, notifications.KIND_RECEIPT)
        assert notifications.send_email(conn, nid, mailer=lambda c, m: None) == "SEM_DESTINATARIO"

        conn.execute(text("UPDATE users SET email = 'adm@empresa.example' WHERE username = 'admin'"))
        nid = _pending(conn, notifications.KIND_RECEIPT)

        def broken(config, message):
            raise smtplib.SMTPAuthenticationError(535, b"credenciais recusadas")

        assert notifications.send_email(conn, nid, mailer=broken) == "FALHA"
        assert "SMTPAuthenticationError" in _status(conn, nid).email_error

    def test_without_mail_server_nothing_is_queued(self, _db_transaction, monkeypatch):
        monkeypatch.delenv("SEA_SMTP_HOST", raising=False)
        conn = _db_transaction
        nid = _pending(conn, notifications.KIND_RECEIPT)
        assert _status(conn, nid).email_status == "NAO_CONFIGURADO"
        assert notifications.send_email(conn, nid, mailer=lambda c, m: 1 / 0) == "NAO_CONFIGURADO"

    def test_invalid_mail_settings_are_refused(self, monkeypatch):
        monkeypatch.setenv("SEA_SMTP_HOST", "smtp.empresa.example")
        monkeypatch.delenv("SEA_SMTP_FROM", raising=False)
        monkeypatch.delenv("SEA_SMTP_USER", raising=False)
        with pytest.raises(RuntimeError):
            notifications.smtp_config()
        monkeypatch.setenv("SEA_SMTP_FROM", "sea@empresa.example")
        monkeypatch.setenv("SEA_SMTP_SECURITY", "telnet")
        with pytest.raises(RuntimeError):
            notifications.smtp_config()


class TestMateriais:
    def test_lists_one_row_per_material_of_each_order(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        po_id = _create_ot(client, auth_headers, "OT-M-1", [(sp12["small"], 7)], order_type="PM12")
        conn.execute(
            text("UPDATE purchase_orders SET service_order_number = '2005000001' WHERE po_id = :p"),
            {"p": po_id},
        )
        conn.execute(text("UPDATE items SET uom = 'PC' WHERE item_id = :i"), {"i": sp12["small"]})
        _create_ot(client, auth_headers, "OT-M-2", [(sp12["small"], 2)], order_type="PM11")

        data = client.get(
            f"/api/sea/materiais?warehouse_id={WAREHOUSE}&q=SEA-", headers=auth_headers
        ).get_json()
        rows = {(r["order"], r["sku"]): r for r in data["items"]}
        with_order = rows[("2005000001", "SEA-SMALL")]
        assert with_order["order_type"] == "PM12" and with_order["quantity"] == 7
        assert with_order["uom"] == "PC" and with_order["ot"] == "OT-M-1"
        # No PM order number informed: the OT number identifies the order.
        assert rows[("OT-M-2", "SEA-SMALL")]["quantity"] == 2
        # Material that is in no order still appears, without order data.
        assert rows[(None, "SEA-OTHER")]["quantity"] is None
        assert data["total"] == len(data["items"])
        assert len({r["row_id"] for r in data["items"]}) == len(data["items"])

    def test_material_unit_is_saved(self, client, auth_headers, sp12):
        resp = client.put(
            f"/api/admin/items/{sp12['small']}", headers=auth_headers, json={"uom": "KG"}
        )
        assert resp.status_code == 200, resp.get_json()
        data = client.get(
            f"/api/sea/materiais?warehouse_id={WAREHOUSE}&q=SEA-SMALL", headers=auth_headers
        ).get_json()
        assert {r["uom"] for r in data["items"] if r["sku"] == "SEA-SMALL"} == {"KG"}


@pytest.fixture()
def other_location(_db_transaction):
    """A second location with one shelf (the order is received in
    warehouse 1 and stored here)."""
    conn = _db_transaction
    wid = conn.execute(
        text(
            "INSERT INTO warehouses (warehouse_code, warehouse_name) "
            "VALUES ('T-SP12', 'Local de teste') RETURNING warehouse_id"
        )
    ).scalar()
    zone = conn.execute(
        text(
            "INSERT INTO zones (warehouse_id, zone_code, zone_name, zone_type) "
            "VALUES (:w, 'PRAT', 'Prateleiras', 'STORAGE') RETURNING zone_id"
        ),
        {"w": wid},
    ).scalar()
    shelf = conn.execute(
        text(
            """
            INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type, external_id)
            VALUES (:z, :w, 'T-X0', 'T-X0', 'Pickable', gen_random_uuid()) RETURNING bin_id
            """
        ),
        {"z": zone, "w": wid},
    ).scalar()
    return {"warehouse_id": wid, "shelf": shelf}


class TestStorageInAnotherLocation:
    """Received in one location (Expedição), stored in another (SP12)."""

    def test_order_is_stored_and_withdrawn_in_the_other_location(
        self, client, auth_headers, sp12, other_location
    ):
        conn = sp12["conn"]
        shelf = other_location["shelf"]
        po_id = _create_ot(client, auth_headers, "OT-X-1", [(sp12["small"], 10)])
        assert _receive(client, auth_headers, po_id, sp12["small"], 10).status_code == 200

        # The shelves of the other location are offered as destinations.
        dest = client.get("/api/sea/armazenagem/destinos", headers=auth_headers).get_json()["bins"]
        assert ("T-SP12", "T-X0") in {(b["warehouse_code"], b["bin_code"]) for b in dest}
        assert STAGING_BIN not in {b["bin_id"] for b in dest}

        assert _putaway(client, auth_headers, sp12["small"], shelf, 6, "OT-X-1").status_code == 200
        assert _rows(conn, "ARMAZENAGEM_CONCLUIDA") == []  # 4 still in the receiving area
        assert _putaway(client, auth_headers, sp12["small"], shelf, 4, "OT-X-1").status_code == 200
        (done,) = _rows(conn, "ARMAZENAGEM_CONCLUIDA")
        assert "T-SP12 · T-X0" in done.message

        stock = conn.execute(
            text(
                "SELECT inventory_id, warehouse_id, quantity_on_hand FROM inventory "
                "WHERE lot_number = 'OT-X-1' AND quantity_on_hand > 0"
            )
        ).fetchall()
        assert [(r.warehouse_id, r.quantity_on_hand) for r in stock] == [
            (other_location["warehouse_id"], 10)
        ]

        # The order shows its stock there, and is listed in both locations.
        detail = client.get("/api/sea/ots/OT-X-1", headers=auth_headers).get_json()
        assert [(s["warehouse_code"], s["bin_code"], s["stored"]) for s in detail["stock"]] == [
            ("T-SP12", "T-X0", True)
        ]
        assert [m["kind"] for m in detail["movements"]] == [
            "RECEBIMENTO", "ARMAZENAMENTO", "ARMAZENAMENTO",
        ]
        for wid in (WAREHOUSE, other_location["warehouse_id"]):
            ots = client.get(f"/api/sea/ots?warehouse_id={wid}", headers=auth_headers).get_json()
            row = next(o for o in ots["ots"] if o["ot"] == "OT-X-1")
            assert row["qty_stored"] == 10 and row["bins"] == "T-SP12 · T-X0"

        # The withdrawal belongs to the location where the material is.
        resp = _request(client, auth_headers, stock[0].inventory_id, 3, ot="OT-X-1")
        assert resp.status_code == 201, resp.get_json()
        withdrawal = resp.get_json()["withdrawal"]
        assert withdrawal["warehouse_id"] == other_location["warehouse_id"]
        queue = client.get(
            f"/api/sea/retiradas?warehouse_id={other_location['warehouse_id']}", headers=auth_headers
        ).get_json()["withdrawals"]
        assert withdrawal["withdrawal_id"] in [w["withdrawal_id"] for w in queue]
        for action in ("separar", "pronta", "entregar"):
            step = client.post(
                f"/api/sea/retiradas/{withdrawal['withdrawal_id']}/{action}",
                headers=auth_headers, json={},
            )
            assert step.status_code == 200, step.get_json()
        assert conn.execute(
            text("SELECT quantity_on_hand FROM inventory WHERE inventory_id = :i"),
            {"i": stock[0].inventory_id},
        ).scalar() == 7

    def test_suggestion_offers_the_other_location_when_there_is_no_shelf_here(
        self, client, auth_headers, sp12, other_location
    ):
        conn = sp12["conn"]
        # Leave the receiving location without any storage address.
        conn.execute(
            text("UPDATE bins SET is_active = FALSE WHERE warehouse_id = :w AND bin_id <> :s"),
            {"w": WAREHOUSE, "s": STAGING_BIN},
        )
        po_id = _create_ot(client, auth_headers, "OT-X-2", [(sp12["small"], 2)])
        _receive(client, auth_headers, po_id, sp12["small"], 2)
        inv = conn.execute(
            text("SELECT inventory_id FROM inventory WHERE lot_number = 'OT-X-2'")
        ).scalar()
        data = client.get(f"/api/sea/armazenagem/sugestao/{inv}", headers=auth_headers).get_json()
        assert (data["warehouse_code"], data["bin_code"]) == ("T-SP12", "T-X0")

    def test_stock_that_is_not_an_order_cannot_change_location(
        self, client, auth_headers, sp12, other_location
    ):
        sp12["conn"].execute(
            text(
                "INSERT INTO inventory (item_id, bin_id, warehouse_id, quantity_on_hand) "
                "VALUES (:i, :b, :w, 5)"
            ),
            {"i": sp12["other"], "b": STAGING_BIN, "w": WAREHOUSE},
        )
        resp = _putaway(client, auth_headers, sp12["other"], other_location["shelf"], 5, None)
        assert resp.status_code == 400
        assert "outro local" in resp.get_json()["error"]

    def test_user_without_access_to_the_destination_is_refused(
        self, client, auth_headers, sp12, other_location
    ):
        import bcrypt

        conn = sp12["conn"]
        conn.execute(
            text(
                """
                INSERT INTO users (username, password_hash, full_name, role, warehouse_id,
                                   warehouse_ids, allowed_functions, external_id)
                VALUES ('sea.so.local1', :pw, 'So local 1', 'USER', :w, ARRAY[:w],
                        ARRAY['putaway'], gen_random_uuid())
                """
            ),
            {"pw": bcrypt.hashpw(b"Senha123", bcrypt.gensalt()).decode(), "w": WAREHOUSE},
        )
        token = client.post(
            "/api/auth/login", json={"username": "sea.so.local1", "password": "Senha123"}
        ).get_json()["token"]
        po_id = _create_ot(client, auth_headers, "OT-X-3", [(sp12["small"], 2)])
        _receive(client, auth_headers, po_id, sp12["small"], 2)
        resp = _putaway(
            client, {"Authorization": f"Bearer {token}"}, sp12["small"],
            other_location["shelf"], 2, "OT-X-3",
        )
        assert resp.status_code in (403, 404)
        assert conn.execute(
            text("SELECT COUNT(*) FROM inventory WHERE bin_id = :b AND quantity_on_hand > 0"),
            {"b": other_location["shelf"]},
        ).scalar() == 0


class TestClearNotifications:
    def test_clearing_empties_the_list_of_that_user_only(self, client, auth_headers, stored_ot):
        """stored_ot produced a receipt and a storage notification."""
        conn = stored_ot["conn"]
        other = _other_admin(client, conn)
        before = client.get("/api/sea/notificacoes", headers=auth_headers).get_json()["notifications"]
        assert len(before) >= 2

        resp = client.post("/api/sea/notificacoes/limpar", headers=auth_headers, json={})
        assert resp.status_code == 200
        assert resp.get_json()["cleared_id"] == before[0]["notification_id"]
        assert client.get("/api/sea/notificacoes", headers=auth_headers).get_json()["notifications"] == []
        # Another user still has theirs, and the records are kept.
        theirs = client.get("/api/sea/notificacoes", headers=other).get_json()["notifications"]
        assert len(theirs) == len(before)
        assert len(_rows(conn, "RECEBIMENTO")) >= 1

        # What arrives afterwards shows up again.
        _request(client, auth_headers, stored_ot["inventory_id"], 1)
        fresh = client.get("/api/sea/notificacoes", headers=auth_headers).get_json()["notifications"]
        assert [n["kind"] for n in fresh] == ["RETIRADA_SOLICITADA"]

    def test_clearing_needs_a_session(self, client):
        assert client.application.test_client().post(
            "/api/sea/notificacoes/limpar", json={}
        ).status_code == 401


def _other_admin(client, conn):
    import uuid

    import bcrypt

    conn.execute(
        text(
            "INSERT INTO users (username, password_hash, full_name, role, warehouse_id, "
            "warehouse_ids, external_id) VALUES ('sea.notif.limpar', :pw, 'Outro', 'ADMIN', "
            ":w, :ws, :ext)"
        ),
        {"pw": bcrypt.hashpw(b"Senha123", bcrypt.gensalt()).decode(), "w": WAREHOUSE,
         "ws": [WAREHOUSE], "ext": str(uuid.uuid4())},
    )
    token = client.post(
        "/api/auth/login", json={"username": "sea.notif.limpar", "password": "Senha123"}
    ).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}
