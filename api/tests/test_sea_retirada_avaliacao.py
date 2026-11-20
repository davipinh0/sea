"""Retirada avaliada antes de ser feita: o avaliador aprova ou nega (com motivo), alguém com "Fazer
retirada" aceita e aparece com nome e foto no terminal, depois pronta e entregue.
"""

import base64

from services import notification_service as notifications
from services.user_photo import save_photo
from sqlalchemy import text

from tests.test_sea import WAREHOUSE, _request, _step, _stock, sp12, stored_ot  # noqa: F401
from tests.test_sea_acesso import _user

JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"\x00" * 60


def _wid(client, headers, stored):
    resp = _request(client, headers, stored["inventory_id"], 3)
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()["withdrawal"]["withdrawal_id"]


def _get(client, headers, wid):
    return client.get(f"/api/sea/retiradas/{wid}", headers=headers).get_json()["withdrawal"]


def _notes(conn, kind):
    return conn.execute(
        text("SELECT COUNT(*) FROM sea_notifications WHERE kind = :k"), {"k": kind}
    ).scalar()


class TestEvaluation:
    def test_approved_it_waits_for_who_does_it(self, client, auth_headers, stored_ot):  # noqa: F811
        conn = stored_ot["conn"]
        wid = _wid(client, auth_headers, stored_ot)
        assert _get(client, auth_headers, wid)["status"] == "REQUESTED"
        before = _notes(conn, notifications.KIND_WITHDRAWAL_APPROVED)

        resp = _step(client, auth_headers, wid, "avaliar", {"approve": True})
        assert resp.status_code == 200, resp.get_json()
        w = _get(client, auth_headers, wid)
        assert (w["status"], w["evaluated_by"]) == ("APPROVED", "admin")
        assert _notes(conn, notifications.KIND_WITHDRAWAL_APPROVED) == before + 1
        assert (
            _step(client, auth_headers, wid, "avaliar", {"approve": False, "note": "x"}).status_code
            == 409
        )

    def test_denied_it_needs_a_reason_and_frees_the_stock(self, client, auth_headers, stored_ot):  # noqa: F811
        inv = stored_ot["inventory_id"]
        wid = _wid(client, auth_headers, stored_ot)
        assert tuple(_stock(stored_ot["conn"], inv)) == (10, 3)
        assert _step(client, auth_headers, wid, "avaliar", {"approve": False}).status_code == 400

        resp = _step(
            client, auth_headers, wid, "avaliar", {"approve": False, "note": "Sem urgência"}
        )
        assert resp.status_code == 200
        w = _get(client, auth_headers, wid)
        assert (w["status"], w["evaluation_note"]) == ("REJECTED", "Sem urgência")
        assert tuple(_stock(stored_ot["conn"], inv)) == (10, 0)
        assert _step(client, auth_headers, wid, "separar").status_code == 409


class TestRoles:
    def test_each_step_needs_its_permission(self, client, auth_headers, stored_ot):  # noqa: F811
        conn = stored_ot["conn"]
        requester = _user(client, conn, "sea.ret.pede", ["retirada"], [WAREHOUSE])
        evaluator = _user(client, conn, "sea.ret.avalia", ["retirada-avaliar"], [WAREHOUSE])
        doer = _user(client, conn, "sea.ret.faz", ["retirada-fazer"], [WAREHOUSE])
        wid = _wid(client, requester, stored_ot)

        assert _step(client, requester, wid, "avaliar", {"approve": True}).status_code == 403
        assert _step(client, doer, wid, "avaliar", {"approve": True}).status_code == 403
        assert _step(client, evaluator, wid, "avaliar", {"approve": True}).status_code == 200

        assert _step(client, evaluator, wid, "separar").status_code == 403
        assert _step(client, requester, wid, "separar").status_code == 403
        assert _step(client, doer, wid, "separar").status_code == 200
        w = _get(client, requester, wid)
        assert (w["status"], w["picked_by"], w["picked_by_name"]) == (
            "PICKING",
            "sea.ret.faz",
            "sea.ret.faz",
        )

    def test_the_old_retirada_grant_keeps_doing_withdrawals(self):
        # Quem tinha "retirada" ganhou "retirada-fazer" na migração 096.
        from pathlib import Path

        sql = (
            Path(__file__).resolve().parents[2] / "db/migrations/096_sea_retirada_avaliacao.sql"
        ).read_text(encoding="utf-8")
        assert (
            "SELECT user_id, 'retirada-fazer' FROM user_page_permissions "
            "WHERE page_key = 'retirada'"
            in sql
        )


class TestTerminalSeesWhoAccepted:
    def test_name_and_photo_of_who_accepted(self, client, auth_headers, stored_ot):  # noqa: F811
        conn = stored_ot["conn"]
        requester = _user(client, conn, "sea.ret.term", ["retirada"], [WAREHOUSE])
        doer = _user(client, conn, "sea.ret.foto", ["retirada-fazer"], [WAREHOUSE])
        uid = conn.execute(
            text("SELECT user_id FROM users WHERE username = 'sea.ret.foto'")
        ).scalar()
        conn.execute(
            text("UPDATE users SET full_name = 'Caique Lima' WHERE user_id = :u"), {"u": uid}
        )
        save_photo(conn, uid, JPEG, "image/jpeg")
        wid = _wid(client, requester, stored_ot)
        assert (
            client.get(f"/api/sea/retiradas/{wid}/responsavel", headers=requester).status_code
            == 404
        )

        _step(client, auth_headers, wid, "avaliar", {"approve": True})
        _step(client, doer, wid, "separar")
        resp = client.get(f"/api/sea/retiradas/{wid}/responsavel", headers=requester)
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["name"] == "Caique Lima"
        assert body["photo"] == "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()
        assert _get(client, requester, wid)["picked_by_has_photo"] is True


class TestWhoIsTold:
    def test_each_step_goes_to_who_acts_on_it(self, client, auth_headers, stored_ot):  # noqa: F811
        conn = stored_ot["conn"]
        requester = _user(client, conn, "sea.ret.av1", ["retirada"], [WAREHOUSE])
        evaluator = _user(client, conn, "sea.ret.av2", ["retirada-avaliar"], [WAREHOUSE])
        doer = _user(client, conn, "sea.ret.av3", ["retirada-fazer"], [WAREHOUSE])
        wid = _wid(client, requester, stored_ot)
        _step(client, evaluator, wid, "avaliar", {"approve": True})

        def kinds(headers):
            body = client.get("/api/sea/notificacoes?limit=50", headers=headers).get_json()
            return {n["kind"] for n in body["notifications"]}

        assert notifications.KIND_WITHDRAWAL_REQUESTED in kinds(evaluator)
        assert notifications.KIND_WITHDRAWAL_APPROVED not in kinds(evaluator)
        assert notifications.KIND_WITHDRAWAL_APPROVED in kinds(doer)
        assert notifications.KIND_WITHDRAWAL_REQUESTED not in kinds(doer)
        assert not kinds(requester) & {
            notifications.KIND_WITHDRAWAL_REQUESTED,
            notifications.KIND_WITHDRAWAL_APPROVED,
        }

    def test_the_phones_of_each_audience(self, client, _db_transaction):
        conn = _db_transaction
        _user(client, conn, "sea.ret.cel1", ["retirada-avaliar"], [WAREHOUSE])
        _user(client, conn, "sea.ret.cel2", ["retirada-fazer"], [WAREHOUSE])
        for name, token in (
            ("sea.ret.cel1", "ExponentPushToken[avaliador]"),
            ("sea.ret.cel2", "ExponentPushToken[almoxarife]"),
        ):
            conn.execute(
                text(
                    "INSERT INTO sea_push_tokens (token, user_id) "
                    "SELECT :t, user_id FROM users WHERE username = :u"
                ),
                {"t": token, "u": name},
            )
        evaluators = notifications.push_tokens(conn, WAREHOUSE, "retirada-avaliar")
        doers = notifications.push_tokens(conn, WAREHOUSE, "retirada-fazer")
        assert (
            "ExponentPushToken[avaliador]" in evaluators
            and "ExponentPushToken[almoxarife]" not in evaluators
        )
        assert (
            "ExponentPushToken[almoxarife]" in doers and "ExponentPushToken[avaliador]" not in doers
        )
