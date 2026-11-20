"""Quem só tem a permissão "Usuários" gerencia usuários comuns, mas não administradores.
Regressão (achada no QA): um usuário com essa permissão se promovia a administrador com um PUT, e
podia trocar a senha de um administrador para entrar como ele.
"""

from sqlalchemy import text

from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user


def _uid(conn, username):
    return conn.execute(
        text("SELECT user_id FROM users WHERE username = :u"), {"u": username}
    ).scalar()


def _role(conn, username):
    return conn.execute(
        text("SELECT role FROM users WHERE username = :u"), {"u": username}
    ).scalar()


class TestManagerLimits:
    def test_cannot_promote_itself_or_anyone(self, client, _db_transaction):
        conn = _db_transaction
        manager = _user(client, conn, "sea.gest.1", ["users"], [WAREHOUSE])
        _user(client, conn, "sea.gest.comum", ["retirada"], [WAREHOUSE])
        me = _uid(conn, "sea.gest.1")

        assert (
            client.put(
                f"/api/admin/users/{me}", headers=manager, json={"role": "ADMIN"}
            ).status_code
            == 403
        )
        assert _role(conn, "sea.gest.1") == "USER"
        other = _uid(conn, "sea.gest.comum")
        assert (
            client.put(
                f"/api/admin/users/{other}", headers=manager, json={"role": "ADMIN"}
            ).status_code
            == 403
        )
        assert _role(conn, "sea.gest.comum") == "USER"

    def test_cannot_create_an_administrator(self, client, _db_transaction):
        manager = _user(client, _db_transaction, "sea.gest.2", ["users"], [WAREHOUSE])
        resp = client.post(
            "/api/admin/users",
            headers=manager,
            json={
                "username": "sea.gest.novoadm",
                "password": "Senha123",
                "full_name": "Novo",
                "role": "ADMIN",
                "warehouse_ids": [WAREHOUSE],
            },
        )
        assert resp.status_code == 403
        assert _uid(_db_transaction, "sea.gest.novoadm") is None

    def test_cannot_touch_an_administrator(self, client, _db_transaction):
        conn = _db_transaction
        manager = _user(client, conn, "sea.gest.3", ["users"], [WAREHOUSE])
        admin_id = _uid(conn, "admin")
        before = conn.execute(
            text("SELECT password_hash FROM users WHERE user_id = :u"), {"u": admin_id}
        ).scalar()

        assert (
            client.put(
                f"/api/admin/users/{admin_id}", headers=manager, json={"password": "Trocada123"}
            ).status_code
            == 403
        )
        assert (
            conn.execute(
                text("SELECT password_hash FROM users WHERE user_id = :u"), {"u": admin_id}
            ).scalar()
            == before
        )
        assert client.delete(f"/api/admin/users/{admin_id}", headers=manager).status_code == 403
        assert (
            client.delete(f"/api/admin/users/{admin_id}/aparelhos", headers=manager).status_code
            == 403
        )

    def test_cannot_change_its_own_permissions(self, client, _db_transaction):
        conn = _db_transaction
        manager = _user(client, conn, "sea.gest.4", ["users"], [WAREHOUSE])
        me = _uid(conn, "sea.gest.4")
        resp = client.put(
            f"/api/admin/users/{me}/permissions",
            headers=manager,
            json={"page_keys": ["users", "settings", "imports"]},
        )
        assert resp.status_code == 403

    def test_still_manages_ordinary_users(self, client, _db_transaction):
        conn = _db_transaction
        manager = _user(client, conn, "sea.gest.5", ["users"], [WAREHOUSE])
        _user(client, conn, "sea.gest.alvo", ["retirada"], [WAREHOUSE])
        target = _uid(conn, "sea.gest.alvo")
        assert (
            client.put(
                f"/api/admin/users/{target}", headers=manager, json={"full_name": "Nome Novo"}
            ).status_code
            == 200
        )
        assert (
            client.put(
                f"/api/admin/users/{target}/permissions",
                headers=manager,
                json={"page_keys": ["retirada", "retirada-fazer"]},
            ).status_code
            == 200
        )
        created = client.post(
            "/api/admin/users",
            headers=manager,
            json={
                "username": "sea.gest.novo",
                "password": "Senha123",
                "full_name": "Novo",
                "role": "USER",
                "warehouse_ids": [WAREHOUSE],
            },
        )
        assert created.status_code == 201

    def test_an_administrator_still_does_everything(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        _user(client, conn, "sea.gest.promovido", ["retirada"], [WAREHOUSE])
        target = _uid(conn, "sea.gest.promovido")
        assert (
            client.put(
                f"/api/admin/users/{target}", headers=auth_headers, json={"role": "ADMIN"}
            ).status_code
            == 200
        )
        assert _role(conn, "sea.gest.promovido") == "ADMIN"
