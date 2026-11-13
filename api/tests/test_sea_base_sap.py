"""SEA: the SAP base (orders, materials, open OTs / reservations) and
receiving an OT found in it."""

import pytest
from sqlalchemy import text

from tests.test_sea import STAGING_BIN, WAREHOUSE

ORDERS = [
    {"order_number": "2000000911", "order_type": "PM11"},
    {"order_number": "2000000912", "order_type": "PM12", "description": "Corretiva"},
]
MATERIALS = [
    {"material_code": "00790001", "description": "Arame de solda", "uom": "KG"},
    {"material_code": "00790002", "description": "Luva de proteção", "uom": "PAR"},
]
RESERVATIONS = [
    {"ot_number": "1000000901", "reservation_number": "0280000901",
     "requester_name": "Solicitante Teste", "needed_date": "2026-12-01",
     "order_number": "2000000911", "material_code": "00790001", "quantity": "54"},
    {"ot_number": "1000000901", "order_number": "2000000912",
     "material_code": "00790002", "quantity": 10, "uom": "PC"},
]


def _import(client, headers, kind, records):
    return client.post(f"/api/sea/sap/importar/{kind}", headers=headers, json={"records": records})


@pytest.fixture()
def base(client, auth_headers):
    for kind, records in (("ordens", ORDERS), ("materiais", MATERIALS), ("reservas", RESERVATIONS)):
        resp = _import(client, auth_headers, kind, records)
        assert resp.status_code == 200, resp.get_json()
        assert resp.get_json()["errors"] == []


def _lookup(client, headers, code="1000000901"):
    return client.get(f"/api/sea/recebimentos/consulta?codigo={code}", headers=headers).get_json()


def _register(client, headers, code="1000000901"):
    return client.post(
        "/api/sea/recebimentos/base", headers=headers,
        json={"warehouse_id": WAREHOUSE, "ot_code": code},
    )


class TestImport:
    def test_base_lists_what_was_imported(self, client, auth_headers, base):
        body = client.get("/api/sea/sap/base", headers=auth_headers).get_json()
        assert body["summary"] == {"orders": 2, "materials": 2, "reservations": 1}
        (ot,) = body["reservations"]
        assert ot["ot"] == "1000000901" and ot["registered"] is False
        assert ot["requester_name"] == "Solicitante Teste"
        assert [(m["service_order_number"], m["material_code"], m["quantity"], m["uom"])
                for m in ot["materials"]] == [
            ("2000000911", "00790001", 54, "KG"),   # unit of the material
            ("2000000912", "00790002", 10, "PC"),   # unit informed on the OT
        ]

    def test_importing_again_updates_instead_of_duplicating(self, client, auth_headers, base):
        again = [RESERVATIONS[0] | {"quantity": 60, "requester_name": None}]
        assert _import(client, auth_headers, "reservas", again).get_json()["imported"] == 1
        data = _lookup(client, auth_headers)["integration"]["data"]
        assert data["materials"][0]["quantity"] == 60
        # A blank header cell keeps what the base already had.
        assert data["header"]["requester_name"] == "Solicitante Teste"
        assert len(data["materials"]) == 2

    def test_bad_rows_are_reported_and_the_rest_is_imported(self, client, auth_headers, base):
        rows = [
            {"ot_number": "1000000902", "order_number": "9999", "material_code": "00790001",
             "quantity": 1},                                       # unknown order
            {"ot_number": "1000000902", "order_number": "2000000911",
             "material_code": "nope", "quantity": 1},              # unknown material
            {"ot_number": "1000000902", "order_number": "2000000911",
             "material_code": "00790001", "quantity": "1,5"},      # not a whole number
            {"ot_number": "1000000901", "order_number": "2000000912",
             "material_code": "00790001", "quantity": 1},          # material under another order
            {"ot_number": "=1+1", "order_number": "2000000911",
             "material_code": "00790001", "quantity": 1},          # spreadsheet formula
            {"ot_number": "1000000902", "order_number": "2000000911",
             "material_code": "00790001", "quantity": 3},
        ]
        body = _import(client, auth_headers, "reservas", rows).get_json()
        assert body["imported"] == 1
        assert [e["row"] for e in body["errors"]] == [1, 2, 3, 4, 5]
        assert "ordem 9999" in body["errors"][0]["error"]
        assert "quantity" in body["errors"][2]["error"]
        assert _lookup(client, auth_headers, "1000000902")["integration"]["data"] is not None

    def test_order_type_must_be_pm11_or_pm12(self, client, auth_headers):
        body = _import(client, auth_headers, "ordens",
                       [{"order_number": "1", "order_type": "PM13"}]).get_json()
        assert body["imported"] == 0 and body["errors"][0]["row"] == 1

    def test_import_is_refused_without_rows_or_for_unknown_kind(self, client, auth_headers):
        assert _import(client, auth_headers, "ordens", []).status_code == 400
        assert _import(client, auth_headers, "outra", ORDERS).status_code == 400


class TestReceivingFromTheBase:
    def test_scanned_code_is_found_with_materials_orders_and_requester(
        self, client, auth_headers, base
    ):
        body = _lookup(client, auth_headers)
        assert body["found"] is False and body["integration"]["source"] == "base"
        data = body["integration"]["data"]
        assert data["header"]["requester_name"] == "Solicitante Teste"
        assert data["header"]["reservation_number"] == "0280000901"
        assert [(m["service_order_type"], m["service_order_number"], m["material_code"],
                 m["quantity"], m["uom"]) for m in data["materials"]] == [
            ("PM11", "2000000911", "00790001", 54, "KG"),
            ("PM12", "2000000912", "00790002", 10, "PC"),
        ]

    def test_code_outside_the_base_has_no_data(self, client, auth_headers, base):
        assert _lookup(client, auth_headers, "555")["integration"]["data"] is None
        assert _register(client, auth_headers, "555").status_code == 404

    def test_delivery_is_registered_as_the_base_holds_it(
        self, client, auth_headers, base, _db_transaction
    ):
        resp = _register(client, auth_headers)
        assert resp.status_code == 201, resp.get_json()
        assert resp.get_json()["created"] is True

        detail = client.get("/api/sea/ots/1000000901", headers=auth_headers).get_json()
        ot = detail["ot"]
        assert ot["data_source"] == "INTEGRACAO"
        assert ot["requester_name"] == "Solicitante Teste"
        # The receiver is whoever registered the delivery.
        receiver = _db_transaction.execute(
            text("SELECT COALESCE(NULLIF(full_name, ''), username) FROM users "
                 "WHERE username = 'admin'")
        ).scalar()
        assert ot["receiver_name"] == receiver
        # Each material keeps the order it belongs to.
        assert [(m["service_order_type"], m["service_order_number"], m["sku"],
                 m["quantity_ordered"], m["uom"]) for m in detail["materials"]] == [
            ("PM11", "2000000911", "00790001", 54, "KG"),
            ("PM12", "2000000912", "00790002", 10, "PC"),
        ]
        # The materials were created in the master with the SAP description.
        assert _db_transaction.execute(
            text("SELECT item_name FROM items WHERE sku = '00790002'")
        ).scalar() == "Luva de proteção"

        # From here on it is an ordinary OT: it can be received.
        item_id = detail["materials"][0]["item_id"]
        received = client.post(
            "/api/receiving/receive", headers=auth_headers,
            json={"po_id": ot["po_id"],
                  "items": [{"item_id": item_id, "quantity": 54, "bin_id": STAGING_BIN}]},
        )
        assert received.status_code == 200, received.get_json()

        base_view = client.get("/api/sea/sap/base", headers=auth_headers).get_json()
        assert base_view["reservations"][0]["registered"] is True

    def test_the_same_ot_is_not_registered_twice(self, client, auth_headers, base, _db_transaction):
        assert _register(client, auth_headers).status_code == 201
        again = _register(client, auth_headers)
        assert again.status_code == 409 and again.get_json()["user_facing"] is True
        assert _db_transaction.execute(
            text("SELECT COUNT(*) FROM purchase_orders WHERE po_number = '1000000901'")
        ).scalar() == 1

    def test_receiver_sent_by_the_client_is_ignored(self, client, auth_headers, _db_transaction):
        """Label registration: the receiver is the logged-in user as well."""
        resp = client.post(
            "/api/sea/recebimentos", headers=auth_headers,
            json={"warehouse_id": WAREHOUSE,
                  "header": {"ot_code": "1000000903", "service_order_type": "PM11",
                             "receiver_name": "OUTRA PESSOA"},
                  "materials": [{"material_code": "00790009", "description": "Peça",
                                 "quantity": 1}]},
        )
        assert resp.status_code == 201, resp.get_json()
        stored = _db_transaction.execute(
            text("SELECT receiver_name FROM purchase_orders WHERE po_number = '1000000903'")
        ).scalar()
        assert stored and stored != "OUTRA PESSOA"
        # ...and it cannot be rewritten by a correction.
        po_id = resp.get_json()["po_id"]
        changed = client.put(f"/api/sea/ots/{po_id}/dados", headers=auth_headers,
                             json={"receiver_name": "OUTRA PESSOA"})
        assert changed.status_code == 400
