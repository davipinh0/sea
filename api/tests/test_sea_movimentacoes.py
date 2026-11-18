"""SEA: movements on the Painel and in the app history (mig 094).

Only administrators and users granted "Histórico" (audit-log) see them.
"Limpar" restarts the Painel list of that user; the history keeps it all.
"""

from sqlalchemy import text

from services.audit_service import write_audit_log
from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user


def _painel(client, headers):
    resp = client.get(f"/api/sea/painel?warehouse_id={WAREHOUSE}", headers=headers)
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


def _movement(conn, label):
    # audit_log is append-only (V-025): rows are never edited, not even here.
    write_audit_log(conn, "SEA_TESTE", "BIN", 1, "sea.teste", WAREHOUSE, {"reason": label})


def _reasons(body):
    return [r["details"].get("reason") for r in body["recent"]]


class TestWhoSeesTheMovements:
    def test_without_historico_the_painel_hides_them(self, client, _db_transaction):
        headers = _user(client, _db_transaction, "sea.mov.sem", ["dashboard"], [WAREHOUSE])
        _movement(_db_transaction, "oculto")
        body = _painel(client, headers)
        assert body["recent"] is None
        assert "open_ots" in body  # the rest of the Painel is unchanged

    def test_with_historico_they_are_listed(self, client, _db_transaction):
        headers = _user(client, _db_transaction, "sea.mov.com", ["audit-log"], [WAREHOUSE])
        _movement(_db_transaction, "visivel")
        assert "visivel" in _reasons(_painel(client, headers))

    def test_the_administrator_sees_them(self, client, auth_headers, _db_transaction):
        _movement(_db_transaction, "admin-ve")
        assert "admin-ve" in _reasons(_painel(client, auth_headers))


class TestClearingTheList:
    def test_clear_only_hides_for_this_user_and_keeps_the_history(self, client, _db_transaction):
        mine = _user(client, _db_transaction, "sea.mov.limpa", ["audit-log"], [WAREHOUSE])
        other = _user(client, _db_transaction, "sea.mov.outro", ["audit-log"], [WAREHOUSE])
        _movement(_db_transaction, "antigo")
        total = _db_transaction.execute(text("SELECT COUNT(*) FROM audit_log")).scalar()

        resp = client.post("/api/sea/painel/movimentacoes/limpar", json={}, headers=mine)
        assert resp.status_code == 200
        body = _painel(client, mine)
        assert "antigo" not in _reasons(body)
        assert body["recent_cleared_at"]
        assert "antigo" in _reasons(_painel(client, other))
        assert _db_transaction.execute(text("SELECT COUNT(*) FROM audit_log")).scalar() == total

        # What happens after the moment of "Limpar" is listed again (the
        # test transaction freezes NOW(), so the moment is moved back).
        _db_transaction.execute(
            text("UPDATE users SET movements_cleared_at = movements_cleared_at - INTERVAL '1 hour' "
                 "WHERE username = 'sea.mov.limpa'")
        )
        assert "antigo" in _reasons(_painel(client, mine))
        assert client.post("/api/sea/painel/movimentacoes/limpar", json={}, headers=mine).status_code == 200

        assert client.post("/api/sea/painel/movimentacoes/restaurar", json={}, headers=mine).status_code == 200
        assert "antigo" in _reasons(_painel(client, mine))

    def test_without_historico_the_list_cannot_be_cleared(self, client, _db_transaction):
        headers = _user(client, _db_transaction, "sea.mov.naolimpa", ["dashboard"], [WAREHOUSE])
        resp = client.post("/api/sea/painel/movimentacoes/limpar", json={}, headers=headers)
        assert resp.status_code == 403


class TestAppHistory:
    def test_movements_are_paged_newest_first(self, client, _db_transaction):
        headers = _user(client, _db_transaction, "sea.mov.app", ["audit-log"], [WAREHOUSE])
        for n in range(3):
            _movement(_db_transaction, f"m{n}")
        first = client.get(f"/api/sea/historico?warehouse_id={WAREHOUSE}&limit=2", headers=headers).get_json()
        assert [m["details"]["reason"] for m in first["movements"]] == ["m2", "m1"]
        rest = client.get(
            f"/api/sea/historico?warehouse_id={WAREHOUSE}&limit=2&before={first['next_before']}",
            headers=headers,
        ).get_json()
        assert rest["movements"][0]["details"]["reason"] == "m0"

    def test_the_history_needs_the_permission(self, client, _db_transaction):
        headers = _user(client, _db_transaction, "sea.mov.appsem", ["retirada"], [WAREHOUSE])
        assert client.get(f"/api/sea/historico?warehouse_id={WAREHOUSE}", headers=headers).status_code == 403
        assert client.get("/api/admin/audit-log", headers=headers).status_code == 403
