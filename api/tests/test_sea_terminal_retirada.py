"""SEA (mig 098): the withdrawal terminal account, the withdrawal followed
only by who accepted it, the box weight from the catalogue and the
partial receipt of an OT.
"""

from services import notification_service as notifications
from services import web_sessions
from services.auth_service import decode_token
from sqlalchemy import text

from tests.test_sea import (  # noqa: F401
    WAREHOUSE,
    _create_ot,
    _item,
    _receive,
    _request,
    _step,
    _stock,
    sp12,
    stored_ot,
)
from tests.test_sea_acesso import _user

EMAIL = "fulano.terminal@empresa-ficticia.com"


class _NoCommit:
    """The test connection, with commit() held back."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, *args, **kwargs):
        return self._conn.execute(*args, **kwargs)

    def commit(self):
        pass


def _terminal(client, conn, username="sea.terminal"):
    return _user(client, conn, username, ["terminal-retirada"], [WAREHOUSE])


def _ask(client, headers, inventory_id, qty=3, email=EMAIL):
    body = {"ot": "OT-W-1", "lines": [{"inventory_id": inventory_id, "quantity": qty}]}
    if email is not None:
        body["requester_email"] = email
    return client.post("/api/sea/retiradas", headers=headers, json=body)


def _uid(conn, username):
    return conn.execute(
        text("SELECT user_id FROM users WHERE username = :u"), {"u": username}
    ).scalar()


class TestTerminalAccount:
    def test_it_holds_only_the_terminal_permission(self, client, auth_headers, _db_transaction):
        _terminal(client, _db_transaction)
        uid = _uid(_db_transaction, "sea.terminal")
        url = f"/api/admin/users/{uid}/permissions"
        mixed = client.put(url, headers=auth_headers,
                           json={"page_keys": ["terminal-retirada", "retirada"]})
        assert mixed.status_code == 400
        assert "Terminal de retirada" in mixed.get_json()["error"]
        only = client.put(url, headers=auth_headers, json={"page_keys": ["terminal-retirada"]})
        assert only.status_code == 200

    def test_who_has_no_access_asks_with_the_corporate_email(
        self, client, auth_headers, stored_ot  # noqa: F811
    ):
        conn = stored_ot["conn"]
        terminal = _terminal(client, conn)
        inv = stored_ot["inventory_id"]

        assert client.get("/api/sea/ordens/OT-W-1", headers=terminal).status_code == 200
        assert _ask(client, terminal, inv, email=None).status_code == 400
        assert _ask(client, terminal, inv, email="sem-arroba").status_code == 400

        resp = _ask(client, terminal, inv, email="  Fulano.Terminal@Empresa-Ficticia.com ")
        assert resp.status_code == 201, resp.get_json()
        w = resp.get_json()["withdrawal"]
        assert (w["requester_email"], w["requested_by"]) == (EMAIL, "sea.terminal")
        assert tuple(_stock(conn, inv)) == (10, 3)

        # The whole flow ends at the terminal, under the terminal account.
        wid = w["withdrawal_id"]
        assert _step(client, auth_headers, wid, "avaliar", {"approve": True}).status_code == 200
        assert _step(client, auth_headers, wid, "separar").status_code == 200
        assert _step(client, auth_headers, wid, "pronta").status_code == 200
        assert client.get(f"/api/sea/retiradas/{wid}", headers=terminal).status_code == 200
        assert _step(client, terminal, wid, "entregar").status_code == 200
        assert tuple(_stock(conn, inv)) == (7, 0)
        details = conn.execute(
            text(
                "SELECT details FROM audit_log WHERE entity_type = 'WITHDRAWAL' "
                "AND entity_id = :w AND action_type = 'WITHDRAWAL_DELIVERED'"
            ),
            {"w": wid},
        ).scalar()
        assert details["requester_email"] == EMAIL and details["identified_by"] == "email"

    def test_only_the_terminal_asks_in_someone_elses_name(
        self, client, stored_ot  # noqa: F811
    ):
        requester = _user(client, stored_ot["conn"], "sea.term.pede", ["retirada"], [WAREHOUSE])
        assert _ask(client, requester, stored_ot["inventory_id"]).status_code == 403
        assert _ask(client, requester, stored_ot["inventory_id"], email=None).status_code == 201

    def test_it_sees_only_what_was_asked_at_it(self, client, auth_headers, stored_ot):  # noqa: F811
        conn = stored_ot["conn"]
        terminal = _terminal(client, conn)
        other = _request(client, auth_headers, stored_ot["inventory_id"], 2)
        wid = other.get_json()["withdrawal"]["withdrawal_id"]
        assert client.get(f"/api/sea/retiradas/{wid}", headers=terminal).status_code == 404
        assert client.get("/api/sea/retiradas", headers=terminal).status_code == 403
        assert (
            _step(client, terminal, wid, "cancelar", {"reason": "x"}).status_code == 404
        )

    def test_the_terminal_session_does_not_end_while_it_waits(self, client, _db_transaction):
        conn = _db_transaction
        terminal = _terminal(client, conn)
        clerk = _user(client, conn, "sea.term.outro", ["retirada"], [WAREHOUSE])
        jtis = [decode_token(h["Authorization"].split()[1])["jti"] for h in (terminal, clerk)]
        conn.execute(
            text("UPDATE sea_sessions SET last_seen_at = NOW() - INTERVAL '2 hours' "
                 "WHERE jti = ANY(CAST(:j AS uuid[]))"),
            {"j": jtis},
        )
        # check() commits; the test keeps everything in its own transaction.
        db = _NoCommit(conn)
        assert web_sessions.check(db, jtis[0], web=True) is None
        assert web_sessions.check(db, jtis[1], web=True) == "idle"


class TestOnlyWhoAcceptedFollows:
    def _accepted(self, client, auth_headers, stored):
        conn = stored["conn"]
        requester = _user(client, conn, "sea.seg.pede", ["retirada"], [WAREHOUSE])
        first = _user(client, conn, "sea.seg.um", ["retirada-fazer"], [WAREHOUSE])
        second = _user(client, conn, "sea.seg.dois", ["retirada-fazer"], [WAREHOUSE])
        wid = _request(client, requester, stored["inventory_id"], 3).get_json()["withdrawal"][
            "withdrawal_id"]
        assert _step(client, auth_headers, wid, "avaliar", {"approve": True}).status_code == 200
        return requester, first, second, wid

    @staticmethod
    def _kinds(client, headers):
        body = client.get("/api/sea/notificacoes?limit=50", headers=headers).get_json()
        return [n["kind"] for n in body["notifications"]]

    def test_the_others_stop_seeing_it(self, client, auth_headers, stored_ot):  # noqa: F811
        _, first, second, wid = self._accepted(client, auth_headers, stored_ot)
        approved = notifications.KIND_WITHDRAWAL_APPROVED
        assert approved in self._kinds(client, second)

        assert _step(client, first, wid, "separar").status_code == 200
        assert approved in self._kinds(client, first)
        assert approved not in self._kinds(client, second)
        # The record stays for everyone.
        assert client.get(f"/api/sea/retiradas/{wid}", headers=second).status_code == 200

    def test_only_who_accepted_carries_it_on(self, client, auth_headers, stored_ot):  # noqa: F811
        _, first, second, wid = self._accepted(client, auth_headers, stored_ot)
        _step(client, first, wid, "separar")
        refused = _step(client, second, wid, "pronta")
        assert refused.status_code == 403
        assert "sea.seg.um" in refused.get_json()["error"]
        assert _step(client, second, wid, "cancelar", {"reason": "x"}).status_code == 403
        assert _step(client, first, wid, "pronta").status_code == 200

    def test_when_the_requester_cancels_only_who_accepted_is_told(
        self, client, auth_headers, stored_ot  # noqa: F811
    ):
        requester, first, second, wid = self._accepted(client, auth_headers, stored_ot)
        _step(client, first, wid, "separar")
        assert _step(client, requester, wid, "cancelar", {"reason": "Não preciso mais"}).status_code == 200
        cancelled = notifications.KIND_WITHDRAWAL_CANCELLED
        assert cancelled in self._kinds(client, first)
        assert cancelled not in self._kinds(client, second)

    def test_the_phones_follow_the_same_rule(
        self, client, auth_headers, stored_ot, monkeypatch  # noqa: F811
    ):
        conn = stored_ot["conn"]
        requester, first, _, wid = self._accepted(client, auth_headers, stored_ot)
        for name, token in (("sea.seg.um", "ExponentPushToken[um]"),
                            ("sea.seg.dois", "ExponentPushToken[dois]")):
            conn.execute(
                text("INSERT INTO sea_push_tokens (token, user_id) "
                     "SELECT :t, user_id FROM users WHERE username = :u"),
                {"t": token, "u": name},
            )
        monkeypatch.setenv("SEA_PUSH", "expo")
        approved_id = conn.execute(
            text("SELECT notification_id FROM sea_notifications "
                 "WHERE withdrawal_id = :w AND kind = :k"),
            {"w": wid, "k": notifications.KIND_WITHDRAWAL_APPROVED},
        ).scalar()
        sent = []
        assert notifications.send_push(conn, approved_id, sender=sent.extend) == 2

        _step(client, first, wid, "separar")
        _step(client, requester, wid, "cancelar", {"reason": "Não preciso mais"})
        sent.clear()
        assert notifications.send_push(conn, approved_id, sender=sent.extend) == 0
        cancelled_id = conn.execute(
            text("SELECT notification_id FROM sea_notifications "
                 "WHERE withdrawal_id = :w AND kind = :k"),
            {"w": wid, "k": notifications.KIND_WITHDRAWAL_CANCELLED},
        ).scalar()
        assert notifications.send_push(conn, cancelled_id, sender=sent.extend) == 1
        assert [m["to"] for m in sent] == ["ExponentPushToken[um]"]


class TestBoxWeightFromTheCatalogue:
    def test_the_catalogue_box_weight_reaches_the_stock(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        item_id = _item(conn, "CAT-CAIXA-1")
        conn.execute(text("UPDATE items SET uom = 'KG' WHERE item_id = :i"), {"i": item_id})
        resp = client.post("/api/sea/catalogo", headers=auth_headers, json={
            "material_code": "CAT-CAIXA-1", "description": "Arame em caixa",
            "uom": "KG", "pack_weight_kg": 18})
        assert resp.status_code == 201, resp.get_json()
        assert conn.execute(
            text("SELECT pack_weight_kg FROM items WHERE item_id = :i"), {"i": item_id}
        ).scalar() == 18
        client.put("/api/sea/catalogo/CAT-CAIXA-1", headers=auth_headers, json={
            "description": "Arame em caixa", "uom": "KG", "pack_weight_kg": 25})
        assert conn.execute(
            text("SELECT pack_weight_kg FROM items WHERE item_id = :i"), {"i": item_id}
        ).scalar() == 25

    def test_an_ot_from_the_base_brings_the_box_weight(self, client, auth_headers, _db_transaction):
        from tests.test_sea_base_sap import _import, _lookup, _register

        for kind, records in (
            ("ordens", [{"order_number": "2000000981", "order_type": "PM11"}]),
            ("materiais", [{"material_code": "00790081", "description": "Eletrodo",
                            "uom": "KG", "pack_weight_kg": 20}]),
            ("reservas", [{"ot_number": "1000000981", "order_number": "2000000981",
                           "material_code": "00790081", "quantity": 60}]),
        ):
            assert _import(client, auth_headers, kind, records).get_json()["errors"] == []
        found = _lookup(client, auth_headers, "1000000981")["integration"]["data"]["materials"]
        assert found[0]["pack_weight_kg"] == 20
        assert _register(client, auth_headers, "1000000981").status_code == 201
        assert _db_transaction.execute(
            text("SELECT uom, pack_weight_kg FROM items WHERE sku = '00790081'")
        ).fetchone() == ("KG", 20)


class TestPartialReceipt:
    def test_an_order_that_arrived_shows_its_ot_is_partial(
        self, client, auth_headers, sp12  # noqa: F811
    ):
        conn = sp12["conn"]
        po_id = _create_ot(client, auth_headers, "OT-PARC-1",
                           [(sp12["small"], 4), (sp12["other"], 2)])
        conn.execute(
            text("UPDATE purchase_order_lines SET service_order_number = "
                 "CASE WHEN item_id = :a THEN '2000000991' ELSE '2000000992' END "
                 "WHERE po_id = :p"),
            {"a": sp12["small"], "p": po_id},
        )
        assert _receive(client, auth_headers, po_id, sp12["small"], 4).status_code == 200

        rows = client.get(f"/api/sea/ordens?warehouse_id={WAREHOUSE}&q=OT-PARC-1",
                          headers=auth_headers).get_json()["orders"]
        by_order = {r["order_number"]: r for r in rows}
        arrived, missing = by_order["2000000991"], by_order["2000000992"]
        assert arrived["status"] == "RECEIVED" and missing["status"] == "OPEN"
        for row in (arrived, missing):
            assert (row["ot_status"], row["ot_pending_materials"]) == ("PARTIAL", 1)
        assert conn.execute(
            text("SELECT status FROM purchase_orders WHERE po_id = :p"), {"p": po_id}
        ).scalar() == "PARTIAL"
