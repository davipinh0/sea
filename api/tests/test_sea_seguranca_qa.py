"""Segurança (QA): CSRF, dados de outro local, foto maliciosa e campos extras."""

import base64

from sqlalchemy import text

from tests.test_sea import WAREHOUSE, _request, sp12, stored_ot  # noqa: F401
from tests.test_sea_acesso import _user, second_location  # noqa: F401


def _uid(conn, username):
    return conn.execute(
        text("SELECT user_id FROM users WHERE username = :u"), {"u": username}
    ).scalar()


def _web_login(client, username):
    resp = client.post("/api/auth/login", json={"username": username, "password": "Senha123"})
    assert resp.status_code == 200
    return client.get_cookie("sea_csrf").value


class TestCsrf:
    def test_cookie_session_needs_the_csrf_token(self, client, _db_transaction):
        _user(client, _db_transaction, "sea.csrf.1", ["retirada"], [WAREHOUSE])
        token = _web_login(client, "sea.csrf.1")
        assert client.post("/api/sea/notificacoes/limpar", json={}).status_code == 403
        bad = {"X-CSRF-Token": "outro-valor"}
        assert client.post("/api/sea/notificacoes/limpar", json={}, headers=bad).status_code == 403
        ok = {"X-CSRF-Token": token}
        assert client.post("/api/sea/notificacoes/limpar", json={}, headers=ok).status_code == 200

    def test_reading_does_not_need_it(self, client, _db_transaction):
        _user(client, _db_transaction, "sea.csrf.2", ["retirada"], [WAREHOUSE])
        _web_login(client, "sea.csrf.2")
        assert client.get("/api/auth/me").status_code == 200


class TestOtherLocation:
    def test_withdrawal_of_another_location_is_not_found(
        self,
        client,
        auth_headers,
        stored_ot,  # noqa: F811
        second_location,  # noqa: F811
    ):
        conn = stored_ot["conn"]
        wid = _request(client, auth_headers, stored_ot["inventory_id"], 2).get_json()["withdrawal"][
            "withdrawal_id"
        ]
        outsider = _user(client, conn, "sea.outro.local", ["retirada-fazer"], [second_location])
        assert client.get(f"/api/sea/retiradas/{wid}", headers=outsider).status_code == 404
        assert (
            client.get(f"/api/sea/retiradas/{wid}/responsavel", headers=outsider).status_code == 404
        )
        listed = client.get("/api/sea/retiradas", headers=outsider).get_json()["withdrawals"]
        assert wid not in [w["withdrawal_id"] for w in listed]
        assert client.post(
            f"/api/sea/retiradas/{wid}/separar", json={}, headers=outsider
        ).status_code in (403, 404, 409)

    def test_ot_of_another_location_is_not_found(
        self,
        client,
        auth_headers,
        stored_ot,  # noqa: F811
        second_location,  # noqa: F811
    ):
        outsider = _user(
            client, stored_ot["conn"], "sea.outro.ot", ["purchase-orders"], [second_location]
        )
        assert client.get("/api/sea/ots/OT-W-1", headers=outsider).status_code == 404


class TestPhoto:
    def _put(self, client, headers, uid, payload):
        return client.put(f"/api/admin/users/{uid}/foto", headers=headers, json={"image": payload})

    def test_only_real_images_are_accepted(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        _user(client, conn, "sea.foto.alvo", ["retirada"], [WAREHOUSE])
        uid = _uid(conn, "sea.foto.alvo")
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        html = b"<html><script>alert(1)</script></html>"
        fake_png = b"\x89PNG" + b"<script>"  # cabeçalho truncado
        for raw in (svg, html, fake_png, b"MZ\x90\x00executavel"):
            payload = base64.b64encode(raw).decode()
            assert self._put(client, auth_headers, uid, payload).status_code == 400, raw[:10]
        assert (
            self._put(
                client,
                auth_headers,
                uid,
                "data:image/svg+xml;base64," + base64.b64encode(svg).decode(),
            ).status_code
            == 400
        )
        assert self._put(client, auth_headers, uid, "não é base64 %%%").status_code == 400

    def test_too_big(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        _user(client, conn, "sea.foto.grande", ["retirada"], [WAREHOUSE])
        uid = _uid(conn, "sea.foto.grande")
        big = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * (1024 * 1024 + 10)).decode()
        assert self._put(client, auth_headers, uid, big).status_code in (400, 413)

    def test_only_an_administrator_sets_it(self, client, _db_transaction):
        conn = _db_transaction
        manager = _user(client, conn, "sea.foto.gestor", ["users"], [WAREHOUSE])
        jpeg = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 60).decode()
        assert self._put(client, manager, _uid(conn, "sea.foto.gestor"), jpeg).status_code == 403

    def test_others_photo_needs_permission(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        stranger = _user(client, conn, "sea.foto.curioso", ["retirada"], [WAREHOUSE])
        assert client.get("/api/admin/users/1/foto", headers=stranger).status_code == 403


class TestExtraFields:
    def test_unknown_fields_are_refused(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        _user(client, conn, "sea.extra.1", ["retirada"], [WAREHOUSE])
        uid = _uid(conn, "sea.extra.1")
        for body in (
            {"password_hash": "x"},
            {"user_id": 1},
            {"is_admin": True},
            {"full_name": "Ok", "allowed_pages": ["users"]},
        ):
            resp = client.put(f"/api/admin/users/{uid}", headers=auth_headers, json=body)
            assert resp.status_code == 400, body
        row = conn.execute(
            text("SELECT full_name, role FROM users WHERE user_id = :u"), {"u": uid}
        ).fetchone()
        assert (row.full_name, row.role) == ("sea.extra.1", "USER")

    def test_withdrawal_status_cannot_be_sent(self, client, auth_headers, stored_ot):  # noqa: F811
        resp = client.post(
            "/api/sea/retiradas",
            headers=auth_headers,
            json={
                "ot": "OT-W-1",
                "status": "DELIVERED",
                "lines": [{"inventory_id": stored_ot["inventory_id"], "quantity": 1}],
            },
        )
        assert resp.status_code == 400
