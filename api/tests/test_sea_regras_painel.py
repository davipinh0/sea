"""Regras do painel pedidas em 24/11/2026: filtro do histórico, histórico e aprovação de retirada
com confirmação no celular, só o administrador cria OT e material, alteração salva no painel com
motivo e confirmação no celular, e exclusão de OT só com permissão.
"""

from urllib.parse import quote

from sqlalchemy import text

from tests.test_sea import WAREHOUSE, _request, sp12, stored_ot  # noqa: F401
from tests.test_sea_acesso import _user
from tests.test_sea_step_up import PHONE, _phone, _web_login

AUDIT = "/api/admin/audit-log"


def _uid(conn, username):
    return conn.execute(
        text("SELECT user_id FROM users WHERE username = :u"), {"u": username}
    ).scalar()


def _with_phone(client, conn, username, pages):
    _user(client, conn, username, pages, [WAREHOUSE])
    conn.execute(
        text("INSERT INTO sea_push_tokens (token, user_id, secure_lock) VALUES (:t, :u, TRUE)"),
        {"t": PHONE, "u": _uid(conn, username)},
    )


def _release(client, phone, csrf, purpose):
    challenge = client.post(f"/api/sea/confirmacao/{purpose}", json={},
                            headers=csrf).get_json()["challenge_id"]
    resp = client.post(f"/api/sea/login/{challenge}/decidir",
                       json={"approve": True, "device_token": PHONE}, headers=phone)
    assert resp.status_code == 200, resp.get_json()


def _log(conn, action, user, when):
    conn.execute(
        text("INSERT INTO audit_log (action_type, entity_type, entity_id, user_id, details, "
             "created_at) VALUES (:a, 'ITEM', 1, :u, '{}'::jsonb, CAST(:w AS timestamptz))"),
        {"a": action, "u": user, "w": when},
    )


class TestAuditFilter:
    def test_same_label_actions_user_part_and_whole_local_day(self, client, auth_headers,
                                                             _db_transaction, monkeypatch):
        from routes.admin import admin_users
        monkeypatch.setattr(admin_users, "COMPANY_TIMEZONE", "America/Sao_Paulo")
        conn = _db_transaction
        # 20/11 às 23:30 em Brasília é 21/11 em UTC: tem de aparecer no filtro do dia 20.
        _log(conn, "TRANSFER", "sea.filtro.Ana", "2026-11-20 23:30:00-03")
        _log(conn, "STOCK_TRANSFERRED", "sea.filtro.ana", "2026-11-20 10:00:00-03")
        _log(conn, "STOCK_TRANSFERRED", "sea.filtro.bruno", "2026-11-20 11:00:00-03")
        _log(conn, "STOCK_TRANSFERRED", "sea.filtro.ana", "2026-11-21 09:00:00-03")

        rows = client.get(
            f"{AUDIT}?action_type=STOCK_TRANSFERRED,TRANSFER&user_id=FILTRO.ANA"
            "&start_date=2026-11-20&end_date=2026-11-20", headers=auth_headers,
        ).get_json()["entries"]
        assert sorted(r["action_type"] for r in rows) == ["STOCK_TRANSFERRED", "TRANSFER"]

        one_day = client.get(f"{AUDIT}?user_id=filtro&start_date=2026-11-21&end_date=2026-11-21",
                             headers=auth_headers).get_json()["entries"]
        assert [r["username"] for r in one_day] == ["sea.filtro.ana"]
        bad = client.get(f"{AUDIT}?start_date=20/11/2026", headers=auth_headers)
        assert bad.status_code == 400 and bad.get_json()["user_facing"] is True


class TestHistoryNeedsThePhone:
    def test_panel_opens_the_history_only_after_the_phone(self, client, _db_transaction):
        conn = _db_transaction
        _with_phone(client, conn, "sea.hist.leitor", ["audit-log"])
        phone = _phone(client, "sea.hist.leitor")
        # O app (sessão Bearer) tem a própria trava: não pede de novo.
        assert client.get(AUDIT, headers=phone).status_code == 200

        csrf = _web_login(client, "sea.hist.leitor")
        refused = client.get(AUDIT, headers=csrf)
        assert refused.status_code == 403
        assert refused.get_json()["step_up_required"] == "historico"
        _release(client, phone, csrf, "historico")
        assert client.get(AUDIT, headers=csrf).status_code == 200
        assert client.get(f"{AUDIT}?item_id=1", headers=csrf).status_code == 200


class TestApprovalNeedsThePhoneEachTime:
    def test_each_approval_in_the_panel_asks_the_phone(self, client, auth_headers,
                                                       stored_ot):  # noqa: F811
        conn = stored_ot["conn"]
        employee = _user(client, conn, "sea.aprov.solic", ["retirada"], [WAREHOUSE])
        first = _request(client, employee, stored_ot["inventory_id"], 1).get_json()
        second = _request(client, employee, stored_ot["inventory_id"], 1).get_json()
        w1, w2 = first["withdrawal"]["withdrawal_id"], second["withdrawal"]["withdrawal_id"]

        _with_phone(client, conn, "sea.aprov.aval", ["retirada-avaliar"])
        phone = _phone(client, "sea.aprov.aval")
        csrf = _web_login(client, "sea.aprov.aval")
        _release(client, phone, csrf, "retirada")

        approve = {"approve": True}
        refused = client.post(f"/api/sea/retiradas/{w1}/avaliar", json=approve, headers=csrf)
        assert refused.status_code == 403
        assert refused.get_json()["step_up_required"] == "aprovacao-retirada"
        _release(client, phone, csrf, "aprovacao-retirada")
        assert client.post(f"/api/sea/retiradas/{w1}/avaliar", json=approve,
                           headers=csrf).status_code == 200
        # Vale para uma aprovação só.
        again = client.post(f"/api/sea/retiradas/{w2}/avaliar", json=approve, headers=csrf)
        assert again.status_code == 403
        # Negar não pede o celular de novo.
        deny = client.post(f"/api/sea/retiradas/{w2}/avaliar",
                           json={"approve": False, "note": "Sem programação"}, headers=csrf)
        assert deny.status_code == 200, deny.get_json()
        # No app (Bearer), a digital do celular já confirma.
        third = _request(client, employee, stored_ot["inventory_id"], 1).get_json()
        w3 = third["withdrawal"]["withdrawal_id"]
        assert client.post(f"/api/sea/retiradas/{w3}/avaliar", json=approve,
                           headers=phone).status_code == 200


def _label(client, headers, ot, sku, description="Peça"):
    return client.post("/api/sea/recebimentos", headers=headers, json={
        "warehouse_id": WAREHOUSE,
        "header": {"ot_code": ot, "service_order_type": "PM11"},
        "materials": [{"material_code": sku, "description": description, "quantity": 1}],
    })


class TestOnlyTheAdministratorCreates:
    def test_users_with_the_pages_cannot_create_ots_or_materials(self, client, auth_headers,
                                                                 sp12):  # noqa: F811
        conn = sp12["conn"]
        oper = _user(client, conn, "sea.cria.oper",
                     ["receiving", "purchase-orders", "items", "material-catalog"], [WAREHOUSE])

        assert client.post("/api/admin/items", headers=oper,
                           json={"sku": "CRIA-1", "item_name": "Peça"}).status_code == 403
        new_po = {"po_number": "CRIA-PO", "warehouse_id": WAREHOUSE}
        created = client.post("/api/admin/purchase-orders", headers=oper, json=new_po)
        assert created.status_code == 403
        assert client.post("/api/sea/sap/ots", headers=oper, json={}).status_code == 403
        catalog = {"material_code": "CRIA-CAT", "description": "x"}
        assert client.post("/api/sea/catalogo", headers=oper, json=catalog).status_code == 403

        # Etiqueta: OT nova ou material novo, só o administrador.
        new_ot = _label(client, oper, "OT-CRIA-1", "CRIA-A")
        assert new_ot.status_code == 403 and new_ot.get_json()["admin_only"] is True
        assert conn.execute(text(
            "SELECT COUNT(*) FROM purchase_orders WHERE po_number = 'OT-CRIA-1'")).scalar() == 0
        assert _label(client, auth_headers, "OT-CRIA-1", "CRIA-A").status_code == 201
        new_item = _label(client, oper, "OT-CRIA-1", "CRIA-B")
        assert new_item.status_code == 403 and "material novo" in new_item.get_json()["error"]
        assert conn.execute(text("SELECT COUNT(*) FROM items WHERE sku = 'CRIA-B'")).scalar() == 0

        # Material que já existe numa OT que já existe: o operador registra.
        assert client.post("/api/admin/items", headers=auth_headers,
                           json={"sku": "CRIA-C", "item_name": "Peça C"}).status_code == 201
        assert _label(client, oper, "OT-CRIA-1", "CRIA-C", "Peça C").status_code == 201


REASON = "Descrição corrigida conforme a nota fiscal"


def _reason(csrf, reason=REASON):
    return {**csrf, "X-SEA-Motivo": quote(reason)}


class TestChangesNeedReasonAndPhone:
    def test_panel_edit_asks_reason_and_phone_and_logs_the_reason(self, client, auth_headers,
                                                                  _db_transaction):
        conn = _db_transaction
        assert client.post("/api/admin/items", headers=auth_headers,
                           json={"sku": "ALT-1", "item_name": "Peça"}).status_code == 201
        item_id = conn.execute(text("SELECT item_id FROM items WHERE sku = 'ALT-1'")).scalar()
        _with_phone(client, conn, "sea.alt.oper", ["items"])
        phone = _phone(client, "sea.alt.oper")
        csrf = _web_login(client, "sea.alt.oper")
        url, body = f"/api/admin/items/{item_id}", {"item_name": "Peça corrigida"}

        missing = client.put(url, json=body, headers=csrf)
        assert missing.status_code == 428
        assert missing.get_json()["change_confirmation_required"] == "alteracao"
        assert client.put(url, json=body, headers=_reason(csrf, "curto")).status_code == 428
        no_phone = client.put(url, json=body, headers=_reason(csrf))
        assert no_phone.status_code == 403
        assert no_phone.get_json()["step_up_required"] == "alteracao"
        assert conn.execute(text("SELECT item_name FROM items WHERE item_id = :i"),
                            {"i": item_id}).scalar() == "Peça"

        _release(client, phone, csrf, "alteracao")
        assert client.put(url, json=body, headers=_reason(csrf)).status_code == 200
        details = conn.execute(text(
            "SELECT details FROM audit_log WHERE action_type = 'CHANGE_JUSTIFIED' "
            "AND entity_type = 'ITEM' AND entity_id = :i ORDER BY log_id DESC LIMIT 1"),
            {"i": item_id}).scalar()
        assert details["motivo"] == REASON
        assert details["rota"] == f"PUT {url}"
        assert details["autenticacao"]

        # A liberação vale pouco tempo e não se renova com o uso.
        conn.execute(text("UPDATE sea_step_up SET granted_at = NOW() - INTERVAL '3 minutes', "
                          "last_used_at = NOW() WHERE purpose = 'alteracao'"))
        assert client.put(url, json=body, headers=_reason(csrf)).status_code == 403
        # O app (Bearer) confirma no próprio celular e não usa esta janela.
        assert client.put(url, json=body, headers=phone).status_code == 200

    def test_ot_deletion_needs_the_extra_permission(self, client, auth_headers,
                                                     stored_ot):  # noqa: F811
        conn = stored_ot["conn"]
        po_id = conn.execute(text(
            "SELECT po_id FROM purchase_orders WHERE po_number = 'OT-W-1'")).scalar()
        without = _user(client, conn, "sea.excl.sem", ["purchase-orders"], [WAREHOUSE])
        refused = client.delete(f"/api/sea/ots/{po_id}", headers=without)
        assert refused.status_code == 403
        assert refused.get_json()["page_key"] == "excluir-ot"
        allowed = _user(client, conn, "sea.excl.com", ["purchase-orders", "excluir-ot"],
                        [WAREHOUSE])
        assert client.delete(f"/api/sea/ots/{po_id}", headers=allowed).status_code == 200
        assert conn.execute(text("SELECT COUNT(*) FROM purchase_orders WHERE po_id = :p"),
                            {"p": po_id}).scalar() == 0
