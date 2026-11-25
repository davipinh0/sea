"""O histórico mostra a ordem (PM11/PM12 - número), não a OT, e o log mostra como o usuário se
autenticou nos processos que exigem isso.
"""

from sqlalchemy import text

from tests.test_sea import (  # noqa: F401
    WAREHOUSE,
    _create_ot,
    _receive,
    _request,
    _step,
    sp12,
    stored_ot,
)

APP_CONFIRMED = {"X-SEA-Identidade": "digital-pin"}


def _history(client, headers):
    resp = client.get(f"/api/sea/historico?warehouse_id={WAREHOUSE}&limit=100", headers=headers)
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()["movements"]


def _last(conn, action):
    return conn.execute(
        text("SELECT details FROM audit_log WHERE action_type = :a ORDER BY log_id DESC LIMIT 1"),
        {"a": action},
    ).scalar()


class TestOrderInsteadOfOt:
    def test_each_row_names_the_order_of_its_material(self, client, auth_headers, sp12):  # noqa: F811
        conn = sp12["conn"]
        po_id = _create_ot(client, auth_headers, "OT-HIST-1",
                           [(sp12["small"], 4), (sp12["other"], 2)], order_type="PM12")
        conn.execute(
            text("UPDATE purchase_order_lines SET service_order_number = "
                 "CASE WHEN item_id = :a THEN '2002349234' ELSE '2002349235' END "
                 "WHERE po_id = :p"),
            {"a": sp12["small"], "p": po_id},
        )
        assert _receive(client, auth_headers, po_id, sp12["small"], 4).status_code == 200

        received = next(m for m in _history(client, auth_headers)
                        if m["action_type"] == "RECEIVE" and m["entity_id"] == po_id)
        assert received["orders"] == ["PM12 - 2002349234"]

    def test_a_withdrawal_names_the_orders_of_its_materials(
        self, client, auth_headers, stored_ot  # noqa: F811
    ):
        resp = _request(client, auth_headers, stored_ot["inventory_id"], 2)
        wid = resp.get_json()["withdrawal"]["withdrawal_id"]
        row = next(m for m in _history(client, auth_headers)
                   if m["action_type"] == "WITHDRAWAL_REQUESTED" and m["entity_id"] == wid)
        # Cadastrada sem número de ordem: a ordem responde pelo número da OT.
        assert row["orders"] == ["PM11 - OT-W-1"]

        log = client.get("/api/admin/audit-log?action_type=WITHDRAWAL_REQUESTED",
                         headers=auth_headers).get_json()["entries"]
        assert next(e for e in log if e["entity_id"] == wid)["orders"] == ["PM11 - OT-W-1"]


class TestAuthenticationOnTheLog:
    def test_confirmed_in_the_app(self, client, auth_headers, sp12):  # noqa: F811
        conn = sp12["conn"]
        po_id = _create_ot(client, auth_headers, "OT-AUT-1", [(sp12["small"], 4)])
        confirmed = {**auth_headers, **APP_CONFIRMED}
        assert _receive(client, confirmed, po_id, sp12["small"], 2).status_code == 200
        assert _last(conn, "RECEIVE")["autenticacao"] == "Digital/PIN no app"

        assert _receive(client, auth_headers, po_id, sp12["small"], 2).status_code == 200
        assert "autenticacao" not in _last(conn, "RECEIVE")

        row = next(m for m in _history(client, auth_headers)
                   if m["action_type"] == "RECEIVE" and m["entity_id"] == po_id
                   and m["details"].get("autenticacao"))
        assert row["details"]["autenticacao"] == "Digital/PIN no app"

    def test_released_on_the_phone_in_the_panel(self, client, stored_ot):  # noqa: F811
        from tests.test_sea_step_up import PHONE, _phone, _setup, _web_login

        conn = stored_ot["conn"]
        _setup(client, conn, "sea.hist.web")
        phone = _phone(client, "sea.hist.web")
        wid = _request(client, phone, stored_ot["inventory_id"], 2).get_json()[
            "withdrawal"]["withdrawal_id"]
        conn.execute(text("UPDATE withdrawals SET status = 'APPROVED' WHERE withdrawal_id = :w"),
                     {"w": wid})

        csrf = _web_login(client, "sea.hist.web")
        challenge = client.post("/api/sea/confirmacao/retirada", json={},
                                headers=csrf).get_json()["challenge_id"]
        assert client.post(f"/api/sea/login/{challenge}/decidir",
                           json={"approve": True, "device_token": PHONE},
                           headers=phone).status_code == 200
        assert client.post(f"/api/sea/retiradas/{wid}/separar", json={},
                           headers=csrf).status_code == 200
        assert _last(conn, "WITHDRAWAL_PICKING")["autenticacao"] == (
            "Liberado no celular (painel web)")

    def test_operations_without_the_requirement_carry_nothing(
        self, client, auth_headers, stored_ot  # noqa: F811
    ):
        # Pedir no terminal não exige autenticação extra, nem com o cabeçalho.
        _request(client, {**auth_headers, **APP_CONFIRMED}, stored_ot["inventory_id"], 1)
        assert "autenticacao" not in _last(stored_ot["conn"], "WITHDRAWAL_REQUESTED")


class TestDeletedOtInHistory:
    """Regressão: excluir uma OT grava "materials" como contagem (um número). O histórico e o log
    esperavam uma lista ali e respondiam 500, e o app mostrava "Não foi possível carregar".
    """

    def test_history_and_log_load_after_an_ot_is_deleted(self, client, auth_headers, sp12):  # noqa: F811
        po_id = _create_ot(client, auth_headers, "OT-HIST-DEL", [(sp12["small"], 3)])
        resp = client.delete(f"/api/sea/ots/{po_id}", headers=auth_headers)
        assert resp.status_code == 200, resp.get_json()
        assert _last(sp12["conn"], "OT_DELETED")["materials"] == 1

        deleted = [m for m in _history(client, auth_headers) if m["action_type"] == "OT_DELETED"]
        assert len(deleted) == 1

        log = client.get("/api/admin/audit-log?page=1&per_page=30", headers=auth_headers)
        assert log.status_code == 200, log.get_json()
        assert any(e["action_type"] == "OT_DELETED" for e in log.get_json()["entries"])
