"""Foto do usuário: só o administrador coloca ou tira."""

import base64

import pytest
from sqlalchemy import text

from services.user_photo import MAX_PHOTO_BYTES, PhotoError, decode_photo, sniff_mime
from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64


def _b64(data):
    return base64.b64encode(data).decode()


def _user_id(conn, username):
    return conn.execute(text("SELECT user_id FROM users WHERE username = :u"), {"u": username}).scalar()


class TestDecode:
    def test_accepts_the_image_types_by_content(self):
        assert sniff_mime(JPEG) == "image/jpeg"
        assert sniff_mime(PNG) == "image/png"
        assert sniff_mime(WEBP) == "image/webp"
        assert decode_photo("data:image/jpeg;base64," + _b64(JPEG)) == (JPEG, "image/jpeg")

    @pytest.mark.parametrize("payload, message", [
        ("", "Escolha uma foto"),
        ("@@@não é base64", "não chegou inteira"),
        (_b64(b"GIF89a" + b"\x00" * 10), "Formato não aceito"),
        (_b64(b"<svg onload=alert(1)>"), "Formato não aceito"),
        (_b64(b"\xff\xd8\xff" + b"\x00" * MAX_PHOTO_BYTES), "grande demais"),
    ])
    def test_refuses_what_is_not_an_accepted_picture(self, payload, message):
        with pytest.raises(PhotoError, match=message):
            decode_photo(payload)


class TestPhotoRoutes:
    def test_administrator_sets_replaces_and_removes_the_photo(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        _user(client, conn, "sea.foto.1", [], [WAREHOUSE])
        uid = _user_id(conn, "sea.foto.1")

        resp = client.put(f"/api/admin/users/{uid}/foto", json={"image": _b64(JPEG)}, headers=auth_headers)
        assert resp.status_code == 200, resp.get_json()
        assert resp.get_json()["photo_version"]

        got = client.get(f"/api/admin/users/{uid}/foto", headers=auth_headers)
        assert got.status_code == 200
        assert got.mimetype == "image/jpeg" and got.data == JPEG
        assert got.headers["X-Content-Type-Options"] == "nosniff"

        assert client.put(f"/api/admin/users/{uid}/foto", json={"image": _b64(PNG)},
                          headers=auth_headers).status_code == 200
        assert client.get(f"/api/admin/users/{uid}/foto", headers=auth_headers).data == PNG

        listed = client.get("/api/admin/users?per_page=1000", headers=auth_headers).get_json()["users"]
        assert next(u for u in listed if u["user_id"] == uid)["photo_version"]

        assert client.delete(f"/api/admin/users/{uid}/foto", headers=auth_headers).status_code == 200
        assert client.get(f"/api/admin/users/{uid}/foto", headers=auth_headers).status_code == 404
        actions = conn.execute(text(
            "SELECT details->>'acao' FROM audit_log WHERE action_type = 'USER_PHOTO' AND entity_id = :u "
            "ORDER BY log_id"), {"u": uid}).scalars().all()
        assert actions == ["foto colocada", "foto colocada", "foto removida"]

    def test_refuses_a_file_that_is_not_a_picture(self, client, auth_headers, _db_transaction):
        _user(client, _db_transaction, "sea.foto.2", [], [WAREHOUSE])
        uid = _user_id(_db_transaction, "sea.foto.2")
        resp = client.put(f"/api/admin/users/{uid}/foto", json={"image": _b64(b"%PDF-1.7 ...")},
                          headers=auth_headers)
        assert resp.status_code == 400
        assert "Formato não aceito" in resp.get_json()["error"]
        assert client.get(f"/api/admin/users/{uid}/foto", headers=auth_headers).status_code == 404

    def test_unknown_user(self, client, auth_headers):
        assert client.put("/api/admin/users/999999/foto", json={"image": _b64(JPEG)},
                          headers=auth_headers).status_code == 404

    def test_only_an_administrator_sets_it_even_with_the_users_page(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        manager = _user(client, conn, "sea.foto.gestor", ["users"], [WAREHOUSE])
        _user(client, conn, "sea.foto.3", [], [WAREHOUSE])
        uid = _user_id(conn, "sea.foto.3")
        assert client.put(f"/api/admin/users/{uid}/foto", json={"image": _b64(JPEG)},
                          headers=manager).status_code == 403
        assert client.delete(f"/api/admin/users/{uid}/foto", headers=manager).status_code == 403
        assert client.put(f"/api/admin/users/{uid}/foto", json={"image": _b64(JPEG)},
                          headers=auth_headers).status_code == 200
        assert client.get(f"/api/admin/users/{uid}/foto", headers=manager).status_code == 200

    def test_a_user_sees_only_the_own_photo(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        own = _user(client, conn, "sea.foto.4", [], [WAREHOUSE])
        _user(client, conn, "sea.foto.5", [], [WAREHOUSE])
        uid, other = _user_id(conn, "sea.foto.4"), _user_id(conn, "sea.foto.5")
        for target in (uid, other):
            client.put(f"/api/admin/users/{target}/foto", json={"image": _b64(JPEG)}, headers=auth_headers)
        assert client.get(f"/api/admin/users/{uid}/foto", headers=own).status_code == 200
        assert client.get(f"/api/admin/users/{other}/foto", headers=own).status_code == 403
        me = client.get("/api/auth/me", headers=own).get_json()
        assert me["photo_version"]
