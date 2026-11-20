"""Excluir usuário: funciona mesmo com histórico e, no painel, exige a confirmação no celular de
quem exclui, a cada exclusão.
Regressão: a exclusão de um usuário que já tinha recebido uma retirada era recusada pelo banco.
"""

from sqlalchemy import text

from tests.test_sea import _request, _step, sp12, stored_ot  # noqa: F401
from tests.test_sea_acesso import _user
from tests.test_sea_step_up import PHONE, WAREHOUSE, _phone, _web_login

ADMIN_PAGES = ["users", "receiving", "putaway", "retirada", "retirada-fazer"]


def _uid(conn, username):
    return conn.execute(
        text("SELECT user_id FROM users WHERE username = :u"), {"u": username}
    ).scalar()


def _manager(client, conn, username):
    """Quem exclui: permissão de Usuários e celular cadastrado."""
    _user(client, conn, username, ADMIN_PAGES, [WAREHOUSE])
    conn.execute(
        text("INSERT INTO sea_push_tokens (token, user_id, secure_lock) VALUES (:t, :u, TRUE)"),
        {"t": PHONE, "u": _uid(conn, username)},
    )


def _approve(client, phone, csrf):
    challenge = client.post("/api/sea/confirmacao/exclusao-usuario", json={},
                            headers=csrf).get_json()["challenge_id"]
    resp = client.post(f"/api/sea/login/{challenge}/decidir",
                       json={"approve": True, "device_token": PHONE}, headers=phone)
    assert resp.status_code == 200, resp.get_json()


class TestHistory:
    def test_a_user_who_received_a_withdrawal_can_be_deleted(
        self, client, auth_headers, stored_ot  # noqa: F811
    ):
        conn = stored_ot["conn"]
        employee = _user(client, conn, "sea.excl.recebeu", ["retirada"], [WAREHOUSE])
        conn.execute(text("UPDATE users SET full_name = 'Fulano Recebedor' WHERE username = :u"),
                     {"u": "sea.excl.recebeu"})
        wid = _request(client, employee, stored_ot["inventory_id"], 2).get_json()[
            "withdrawal"]["withdrawal_id"]
        for step, body in (("avaliar", {"approve": True}), ("separar", None), ("pronta", None)):
            assert _step(client, auth_headers, wid, step, body).status_code == 200
        assert _step(client, employee, wid, "entregar").status_code == 200

        uid = _uid(conn, "sea.excl.recebeu")
        resp = client.delete(f"/api/admin/users/{uid}", headers=auth_headers)
        assert resp.status_code == 200, resp.get_json()
        assert _uid(conn, "sea.excl.recebeu") is None
        # O registro da retirada continua com o nome de quem recebeu.
        w = client.get(f"/api/sea/retiradas/{wid}", headers=auth_headers).get_json()["withdrawal"]
        assert (w["status"], w["delivered_to"]) == ("DELIVERED", "Fulano Recebedor")
        logged = conn.execute(
            text("SELECT details FROM audit_log WHERE action_type = 'USER_DELETED' "
                 "AND entity_id = :u"), {"u": uid},
        ).scalar()
        assert logged["username"] == "sea.excl.recebeu"


class TestPhoneConfirmation:
    def test_the_panel_asks_the_phone_for_each_deletion(self, client, _db_transaction):
        conn = _db_transaction
        _manager(client, conn, "sea.excl.gestor")
        phone = _phone(client, "sea.excl.gestor")
        for name in ("sea.excl.alvo1", "sea.excl.alvo2"):
            _user(client, conn, name, ["retirada"], [WAREHOUSE])
        first, second = _uid(conn, "sea.excl.alvo1"), _uid(conn, "sea.excl.alvo2")

        csrf = _web_login(client, "sea.excl.gestor")
        refused = client.delete(f"/api/admin/users/{first}", headers=csrf)
        assert refused.status_code == 403
        assert refused.get_json()["step_up_required"] == "exclusao-usuario"
        assert _uid(conn, "sea.excl.alvo1") is not None

        _approve(client, phone, csrf)
        assert client.delete(f"/api/admin/users/{first}", headers=csrf).status_code == 200
        # A liberação vale para uma exclusão só.
        again = client.delete(f"/api/admin/users/{second}", headers=csrf)
        assert again.status_code == 403 and again.get_json()["step_up_required"]
        assert _uid(conn, "sea.excl.alvo2") is not None

    def test_without_a_registered_phone_it_is_blocked(self, client, _db_transaction):
        conn = _db_transaction
        _user(client, conn, "sea.excl.semcel", ADMIN_PAGES, [WAREHOUSE])
        csrf = _web_login(client, "sea.excl.semcel")
        resp = client.post("/api/sea/confirmacao/exclusao-usuario", json={}, headers=csrf)
        assert resp.status_code == 409
        assert "cadastre o app SEA" in resp.get_json()["error"]
