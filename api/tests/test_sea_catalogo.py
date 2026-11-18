"""SEA: material catalogue, OTs put together in the SAP base, shelf sizes
and the phone notifications."""

import pytest
from sqlalchemy import text

from services import notification_service as notifications
from tests.test_sea import (  # noqa: F401  (fixtures)
    WAREHOUSE,
    _bin,
    _create_ot,
    _item,
    _putaway,
    _receive,
    sp12,
    stored_ot,
)
from tests.test_sea_acesso import _user

WIRE = {"material_code": "CAT-ARAME", "description": "Arame de soldagem", "uom": "kg",
        "pack_weight_kg": 18}


def _add(client, headers, **overrides):
    return client.post("/api/sea/catalogo", headers=headers, json={**WIRE, **overrides})


class TestCatalogue:
    def test_create_change_and_delete(self, client, auth_headers):
        created = _add(client, auth_headers)
        assert created.status_code == 201, created.get_json()
        # The unit is stored in capitals.
        assert created.get_json()["uom"] == "KG"
        assert _add(client, auth_headers).status_code == 409

        found = client.get("/api/sea/catalogo/CAT-ARAME", headers=auth_headers).get_json()
        assert (found["description"], found["uom"], found["pack_weight_kg"], found["source"]) == (
            "Arame de soldagem", "KG", 18, "cadastro")
        listed = client.get("/api/sea/catalogo?q=arame", headers=auth_headers).get_json()
        assert [m["material_code"] for m in listed["materials"]] == ["CAT-ARAME"]

        changed = client.put("/api/sea/catalogo/CAT-ARAME", headers=auth_headers,
                             json={"description": "Arame MIG", "uom": "KG", "pack_weight_kg": 15})
        assert changed.status_code == 200
        assert client.get("/api/sea/catalogo/CAT-ARAME",
                          headers=auth_headers).get_json()["pack_weight_kg"] == 15

        assert client.delete("/api/sea/catalogo/CAT-ARAME", headers=auth_headers).status_code == 200
        assert client.get("/api/sea/catalogo/CAT-ARAME", headers=auth_headers).status_code == 404
        assert client.delete("/api/sea/catalogo/CAT-ARAME", headers=auth_headers).status_code == 404

    def test_box_weight_only_for_kg_and_fields_are_validated(self, client, auth_headers):
        piece = _add(client, auth_headers, material_code="CAT-PECA", uom="PC")
        assert piece.status_code == 201 and piece.get_json()["pack_weight_kg"] is None
        assert _add(client, auth_headers, material_code="CAT-X", description="  ").status_code == 400
        assert _add(client, auth_headers, material_code="CAT-Y", pack_weight_kg=0).status_code == 400

    def test_lookup_falls_back_to_a_material_already_in_the_sea(self, client, auth_headers, sp12):
        found = client.get("/api/sea/catalogo/SEA-SMALL", headers=auth_headers).get_json()
        assert found["source"] == "estoque" and found["description"] == "SEA-SMALL"

    def test_only_who_holds_the_permission_changes_it(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        assert _add(client, auth_headers).status_code == 201
        reader = _user(client, conn, "sea.cat.1", ["receiving"], [WAREHOUSE])
        # Whoever puts OTs together reads the catalogue...
        assert client.get("/api/sea/catalogo/CAT-ARAME", headers=reader).status_code == 200
        # ...but does not change it.
        assert _add(client, reader, material_code="CAT-NOVO").status_code == 403
        assert client.put("/api/sea/catalogo/CAT-ARAME", headers=reader,
                          json={"description": "x"}).status_code == 403
        assert client.delete("/api/sea/catalogo/CAT-ARAME", headers=reader).status_code == 403
        outsider = _user(client, conn, "sea.cat.2", ["retirada"], [WAREHOUSE])
        assert client.get("/api/sea/catalogo", headers=outsider).status_code == 403

        keeper = _user(client, conn, "sea.cat.3", ["material-catalog"], [WAREHOUSE])
        assert _add(client, keeper, material_code="CAT-NOVO").status_code == 201
        assert client.delete("/api/sea/catalogo/CAT-NOVO", headers=keeper).status_code == 200

    def test_permission_is_offered_in_the_user_grants(self, client, auth_headers, sp12):
        _user(client, sp12["conn"], "sea.cat.4", [], [WAREHOUSE])
        user_id = sp12["conn"].execute(
            text("SELECT user_id FROM users WHERE username = 'sea.cat.4'")).scalar()
        resp = client.put(f"/api/admin/users/{user_id}/permissions", headers=auth_headers,
                          json={"page_keys": ["material-catalog"]})
        assert resp.status_code == 200, resp.get_json()


class TestOtInTheBase:
    def _ot(self, **overrides):
        return {
            "ot_number": "1000000991", "reservation_number": "0280000991",
            "requester_name": "Solicitante Teste",
            "materials": [
                {"order_number": "2000000991", "order_type": "PM11",
                 "material_code": "CAT-ARAME", "quantity": 36},
                {"order_number": "2000000992", "order_type": "PM12",
                 "material_code": "CAT-PECA", "quantity": 4, "uom": "pc"},
            ],
            **overrides,
        }

    @pytest.fixture()
    def catalogue(self, client, auth_headers):
        assert _add(client, auth_headers).status_code == 201
        assert _add(client, auth_headers, material_code="CAT-PECA", description="Peça",
                    uom="PC").status_code == 201

    def test_ot_made_in_the_system_is_found_at_receiving(self, client, auth_headers, catalogue):
        created = client.post("/api/sea/sap/ots", headers=auth_headers, json=self._ot())
        assert created.status_code == 201, created.get_json()

        data = client.get("/api/sea/recebimentos/consulta?codigo=1000000991",
                          headers=auth_headers).get_json()["integration"]["data"]
        assert data["header"]["requester_name"] == "Solicitante Teste"
        assert [(m["service_order_type"], m["service_order_number"], m["material_code"],
                 m["description"], m["quantity"], m["uom"]) for m in data["materials"]] == [
            ("PM11", "2000000991", "CAT-ARAME", "Arame de soldagem", 36, "KG"),
            ("PM12", "2000000992", "CAT-PECA", "Peça", 4, "PC"),
        ]
        # Registering the delivery works like any OT of the base.
        registered = client.post("/api/sea/recebimentos/base", headers=auth_headers,
                                 json={"warehouse_id": WAREHOUSE, "ot_code": "1000000991"})
        assert registered.status_code == 201, registered.get_json()

    def test_refusals(self, client, auth_headers, catalogue):
        assert client.post("/api/sea/sap/ots", headers=auth_headers, json=self._ot()).status_code == 201
        again = client.post("/api/sea/sap/ots", headers=auth_headers, json=self._ot())
        assert again.status_code == 409 and again.get_json()["user_facing"] is True

        unknown = self._ot(ot_number="1000000992")
        unknown["materials"][0]["material_code"] = "NAO-EXISTE"
        resp = client.post("/api/sea/sap/ots", headers=auth_headers, json=unknown)
        assert resp.status_code == 400 and "Cadastro de materiais" in resp.get_json()["error"]

        # The order already exists with another type.
        wrong = self._ot(ot_number="1000000993")
        wrong["materials"][0]["order_type"] = "PM12"
        resp = client.post("/api/sea/sap/ots", headers=auth_headers, json=wrong)
        assert resp.status_code == 400 and "PM11" in resp.get_json()["error"]

        repeated = self._ot(ot_number="1000000994")
        repeated["materials"][1]["material_code"] = "CAT-ARAME"
        assert client.post("/api/sea/sap/ots", headers=auth_headers, json=repeated).status_code == 400
        assert client.post("/api/sea/sap/ots", headers=auth_headers,
                           json=self._ot(ot_number="1000000995", materials=[])).status_code == 400

        # Nothing of the refused OTs stayed in the base.
        base = client.get("/api/sea/sap/base", headers=auth_headers).get_json()
        assert [r["ot"] for r in base["reservations"]] == ["1000000991"]

    def test_material_used_by_an_ot_is_not_deleted(self, client, auth_headers, catalogue):
        assert client.post("/api/sea/sap/ots", headers=auth_headers, json=self._ot()).status_code == 201
        resp = client.delete("/api/sea/catalogo/CAT-ARAME", headers=auth_headers)
        assert resp.status_code == 409 and "1000000991" in resp.get_json()["error"]


class TestPhoneNotifications:
    def _register(self, client, headers, token="ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"):
        return client.post("/api/sea/push/registrar", headers=headers, json={"token": token})

    def test_device_is_registered_once_and_silenced_on_logout(self, client, auth_headers, sp12):
        conn = sp12["conn"]
        assert self._register(client, auth_headers).status_code == 200
        other = _user(client, conn, "sea.push.1", ["retirada"], [WAREHOUSE])
        # The same phone, now used by someone else: it follows the last login.
        assert self._register(client, other).status_code == 200
        rows = conn.execute(text("SELECT u.username FROM sea_push_tokens t JOIN users u "
                                 "USING (user_id)")).fetchall()
        assert [r.username for r in rows] == ["sea.push.1"]
        removed = client.post("/api/sea/push/remover", headers=other,
                              json={"token": "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"})
        assert removed.status_code == 200
        # mig 092: after logout the phone gets no notifications of the day but
        # stays registered (it may still confirm the user's logins).
        assert conn.execute(text("SELECT signed_in FROM sea_push_tokens")).scalars().all() == [False]
        assert notifications.push_tokens(conn, WAREHOUSE) == []
        assert client.application.test_client().post(
            "/api/sea/push/registrar", json={"token": "ExponentPushToken[x1234567890]"}
        ).status_code == 401

    def test_nothing_leaves_unless_push_is_switched_on(self, client, auth_headers, stored_ot,
                                                       monkeypatch):
        conn = stored_ot["conn"]
        self._register(client, auth_headers)
        notification_id = conn.execute(
            text("SELECT MAX(notification_id) FROM sea_notifications")).scalar()
        sent = []
        monkeypatch.delenv("SEA_PUSH", raising=False)
        assert notifications.send_push(conn, notification_id, sender=sent.append) == 0
        assert sent == []

        monkeypatch.setenv("SEA_PUSH", "expo")
        assert notifications.send_push(conn, notification_id, sender=sent.append) == 1
        (message,) = sent[0]
        assert message["to"].startswith("ExponentPushToken[")
        assert message["title"] and message["body"] and message["data"]["kind"]

    def test_only_devices_of_who_works_in_the_location(self, client, auth_headers, stored_ot,
                                                       monkeypatch):
        conn = stored_ot["conn"]
        elsewhere = conn.execute(
            text("INSERT INTO warehouses (warehouse_code, warehouse_name) "
                 "VALUES ('T-LONGE', 'Outro') RETURNING warehouse_id")).scalar()
        far = _user(client, conn, "sea.push.2", ["retirada"], [elsewhere])
        near = _user(client, conn, "sea.push.3", ["retirada"], [WAREHOUSE])
        self._register(client, far, "ExponentPushToken[longe00000000000000000]")
        self._register(client, near, "ExponentPushToken[perto00000000000000000]")
        assert notifications.push_tokens(conn, WAREHOUSE) == [
            "ExponentPushToken[perto00000000000000000]"]
