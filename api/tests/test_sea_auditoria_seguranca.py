"""Regressões da auditoria de segurança de 27/11/2026.

1. A sessão vale só pelo meio do primeiro uso (mig 105): o token do cookie do painel, usado como
   Bearer, pulava o motivo da alteração, a confirmação no celular e o fim por inatividade.
2. A busca global respeita os locais de quem busca e fica fechada para contas sem página do painel.
3. Quem só tem a permissão "Usuários" não dá a outra conta o que não tem, nem assume a conta de
   quem tem mais acesso.
"""

import uuid

import pytest
from sqlalchemy import text

from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user, second_location  # noqa: F401 (fixture)


def _login(client, username):
    resp = client.post("/api/auth/login", json={"username": username, "password": "Senha123"})
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()["token"]


def _csrf(client):
    return {"X-CSRF-Token": client.get_cookie("sea_csrf").value}


def _pages(conn, username):
    return {
        r.page_key for r in conn.execute(
            text("SELECT pp.page_key FROM user_page_permissions pp JOIN users u USING (user_id) "
                 "WHERE u.username = :u"),
            {"u": username},
        )
    }


def _user_id(conn, username):
    return conn.execute(text("SELECT user_id FROM users WHERE username = :u"),
                        {"u": username}).scalar()


class TestSessionChannel:
    def test_the_panel_cookie_token_does_not_work_as_bearer(self, client, _db_transaction):
        _user(client, _db_transaction, "sea.aud.canal1", ["settings"], [WAREHOUSE])
        client._cookies.clear()
        token = _login(client, "sea.aud.canal1")
        assert client.get("/api/auth/me").status_code == 200  # painel: cookie
        bearer = client.application.test_client()  # sem os cookies do painel
        resp = bearer.put(
            "/api/admin/settings", json={"settings": {"session_timeout_hours": "8"}},
            headers={"Authorization": f"Bearer {token}"},
        )
        # Antes: 200 sem motivo nem celular.
        assert resp.status_code == 401
        assert client.get("/api/auth/me").status_code == 200

    def test_a_bearer_session_does_not_work_as_cookie(self, client, _db_transaction):
        _user(client, _db_transaction, "sea.aud.canal2", [], [WAREHOUSE])
        client._cookies.clear()
        token = _login(client, "sea.aud.canal2")
        bearer = client.application.test_client()
        assert bearer.get("/api/auth/me",
                          headers={"Authorization": f"Bearer {token}"}).status_code == 200
        assert client.get("/api/auth/me").status_code == 401
        assert bearer.get("/api/auth/me",
                          headers={"Authorization": f"Bearer {token}"}).status_code == 200

    def test_the_panel_still_needs_the_reason(self, client, _db_transaction):
        _user(client, _db_transaction, "sea.aud.canal3", ["settings"], [WAREHOUSE])
        client._cookies.clear()
        _login(client, "sea.aud.canal3")
        resp = client.put("/api/admin/settings", json={"settings": {"session_timeout_hours": "8"}},
                          headers=_csrf(client))
        assert resp.status_code == 428


@pytest.fixture()
def other_bin(_db_transaction, second_location):  # noqa: F811
    zone = _db_transaction.execute(
        text("INSERT INTO zones (warehouse_id, zone_code, zone_name, zone_type) "
             "VALUES (:w, 'Z-AUD', 'Zona auditoria', 'STORAGE') RETURNING zone_id"),
        {"w": second_location},
    ).scalar()
    _db_transaction.execute(
        text("INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type, "
             "external_id) VALUES (:z, :w, 'AUDX-01', 'AUDX-01', 'Pickable', :e)"),
        {"z": zone, "w": second_location, "e": str(uuid.uuid4())},
    )
    return second_location


class TestGlobalSearch:
    def test_without_warehouse_id_only_the_users_locations(
        self, client, auth_headers, _db_transaction, other_bin
    ):
        headers = _user(client, _db_transaction, "sea.aud.busca1", ["inventory"], [WAREHOUSE])
        labels = [r["label"] for r in
                  client.get("/api/admin/search?q=AUDX", headers=headers).get_json()["results"]]
        # Antes: o endereço do outro local aparecia.
        assert "AUDX-01" not in labels
        admin = [r["label"] for r in
                 client.get("/api/admin/search?q=AUDX", headers=auth_headers).get_json()["results"]]
        assert "AUDX-01" in admin

    def test_another_location_by_id_is_refused(self, client, _db_transaction, other_bin):
        headers = _user(client, _db_transaction, "sea.aud.busca2", ["inventory"], [WAREHOUSE])
        resp = client.get(f"/api/admin/search?q=AUDX&warehouse_id={other_bin}", headers=headers)
        assert resp.status_code == 403

    @pytest.mark.parametrize("pages", [[], ["terminal-retirada"]])
    def test_accounts_without_a_panel_page_cannot_search(self, client, _db_transaction, pages):
        headers = _user(client, _db_transaction, f"sea.aud.busca.{len(pages)}", pages, [WAREHOUSE])
        assert client.get("/api/admin/search?q=OT", headers=headers).status_code == 403


class TestManagerLimits:
    def test_cannot_grant_a_permission_they_do_not_have(self, client, _db_transaction):
        manager = _user(client, _db_transaction, "sea.aud.gestor1", ["users"], [WAREHOUSE])
        _user(client, _db_transaction, "sea.aud.alvo1", [], [WAREHOUSE])
        target = _user_id(_db_transaction, "sea.aud.alvo1")
        resp = client.put(f"/api/admin/users/{target}/permissions",
                          json={"page_keys": ["settings", "excluir-ot"]}, headers=manager)
        # Antes: 200, e bastava entrar com a conta para usar as permissões.
        assert resp.status_code == 403
        assert _pages(_db_transaction, "sea.aud.alvo1") == set()

    def test_can_grant_what_they_have_and_keep_or_remove_the_rest(self, client, _db_transaction):
        manager = _user(client, _db_transaction, "sea.aud.gestor2", ["users", "inventory"],
                        [WAREHOUSE])
        _user(client, _db_transaction, "sea.aud.alvo2", ["settings"], [WAREHOUSE])
        target = _user_id(_db_transaction, "sea.aud.alvo2")
        resp = client.put(f"/api/admin/users/{target}/permissions",
                          json={"page_keys": ["settings", "inventory"]}, headers=manager)
        assert resp.status_code == 200
        assert _pages(_db_transaction, "sea.aud.alvo2") == {"settings", "inventory"}
        resp = client.put(f"/api/admin/users/{target}/permissions",
                          json={"page_keys": ["inventory"]}, headers=manager)
        assert resp.status_code == 200
        assert _pages(_db_transaction, "sea.aud.alvo2") == {"inventory"}

    def test_cannot_give_a_location_they_do_not_have(self, client, _db_transaction,
                                                     second_location):  # noqa: F811
        manager = _user(client, _db_transaction, "sea.aud.gestor3", ["users"], [WAREHOUSE])
        resp = client.post("/api/admin/users", headers=manager, json={
            "username": "sea.aud.novo3", "password": "Senha1234", "full_name": "Novo",
            "role": "USER", "warehouse_ids": [WAREHOUSE, second_location]})
        assert resp.status_code == 403
        resp = client.post("/api/admin/users", headers=manager, json={
            "username": "sea.aud.novo3", "password": "Senha1234", "full_name": "Novo",
            "role": "USER", "warehouse_ids": [WAREHOUSE]})
        assert resp.status_code == 201
        target = resp.get_json()["user_id"]
        resp = client.put(f"/api/admin/users/{target}", headers=manager,
                          json={"warehouse_ids": [WAREHOUSE, second_location]})
        assert resp.status_code == 403

    def test_cannot_take_over_someone_with_more_access(self, client, _db_transaction):
        manager = _user(client, _db_transaction, "sea.aud.gestor4", ["users"], [WAREHOUSE])
        _user(client, _db_transaction, "sea.aud.alvo4", ["settings"], [WAREHOUSE])
        _user(client, _db_transaction, "sea.aud.alvo5", [], [WAREHOUSE])
        stronger = _user_id(_db_transaction, "sea.aud.alvo4")
        peer = _user_id(_db_transaction, "sea.aud.alvo5")
        for body in ({"password": "Outra1234"}, {"web_login_approval": False}):
            resp = client.put(f"/api/admin/users/{stronger}", json=body, headers=manager)
            assert resp.status_code == 403, body
        assert client.put(f"/api/admin/users/{peer}", json={"password": "Outra1234"},
                          headers=manager).status_code == 200


class TestLegacyAdminRoutes:
    """Rotas herdadas do Sentry que exigiam só login (A9 da auditoria)."""

    def test_dashboard_needs_its_permission_and_a_location(self, client, auth_headers,
                                                           _db_transaction):
        plain = _user(client, _db_transaction, "sea.aud.dash1", [], [WAREHOUSE])
        # Antes: 200 com contagens de todos os locais e as últimas entradas do log de auditoria.
        assert client.get("/api/admin/dashboard", headers=plain).status_code == 403
        allowed = _user(client, _db_transaction, "sea.aud.dash2", ["dashboard"], [WAREHOUSE])
        assert client.get("/api/admin/dashboard", headers=allowed).status_code == 400
        assert client.get(f"/api/admin/dashboard?warehouse_id={WAREHOUSE}",
                          headers=allowed).status_code == 200
        assert client.get("/api/admin/dashboard", headers=auth_headers).status_code == 200

    def test_picker_sees_only_transfer_orders_of_their_locations(self, client, _db_transaction,
                                                                second_location):  # noqa: F811
        from tests.test_to_picking_dispatch import _seed_to
        to_id = _seed_to(source_wh=WAREHOUSE, dest_wh=second_location)
        mine = _user(client, _db_transaction, "sea.aud.to1", [], [WAREHOUSE])
        other = _user(client, _db_transaction, "sea.aud.to2", [], [second_location])
        assert client.get(f"/api/admin/picker/transfer-orders/{to_id}",
                          headers=mine).status_code == 200
        # Antes: 200 para qualquer usuário logado.
        assert client.get(f"/api/admin/picker/transfer-orders/{to_id}",
                          headers=other).status_code == 404
        assert client.post(f"/api/admin/picker/transfer-orders/{to_id}/submit",
                           headers=other).status_code == 404


class TestLoginRateLimit:
    def test_many_logins_from_one_ip_are_slowed_down(self, client):
        from routes.auth import LOGIN_RATE_LIMIT
        limit = int(LOGIN_RATE_LIMIT.split()[0])
        codes = [
            client.post("/api/auth/login",
                        json={"username": f"sea.aud.inexistente{i}", "password": "x"}).status_code
            for i in range(limit + 1)
        ]
        # Usuários diferentes: o bloqueio por (IP, usuário) não entra; só o limite por IP.
        assert set(codes[:limit]) == {401}
        assert codes[limit] == 429
