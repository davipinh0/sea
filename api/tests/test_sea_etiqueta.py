"""SEA: label interpretation, OT / material registration and traceability.

The label below is the reference example of the receiving operation.
API tests run inside the conftest transaction (rolled back afterwards)
on top of the standard seed (warehouse 1, staging bin 1).
"""

import uuid

import pytest
from sqlalchemy import text

from services.label_parser import parse_label, parse_quantity, parse_service_order
from services.ot_source import NoOtSource, SapBaseSource, get_ot_source

WAREHOUSE = 1
STAGING_BIN = 1

LABEL = """
Empresa: EXPEDICAO
Data: 05/11/2026
OT: 1003329915
Reserva: 0285365145 /02
Data necessária: 28/10/2026
Código: 74165325
Descrição: ARAME SÓLIDO 1,2MM MIG A5.18 ER 70S6
Quantidade: 54
Unidade: KG
Lote: 0000245045
Vencimento: Não informado
Departamento: PP1
Local de retirada: B02 18 003 F
Local de descarga: OCT – OFICINA CENTRAL TER
Solicitante: JOAO DA SILVA SANTOS
Recebedor: OFICINA CENT
Ordem de serviço: PM12 – 2005113840
Impresso por: JSILVA
Hora: 10:32
"""


# ------------------------------------------------------------- Parser


class TestLabelParser:
    def test_reference_label(self):
        parsed = parse_label(LABEL)
        assert parsed.header == {
            "ot_code": "1003329915",
            "barcode": None,
            "origin_company": "EXPEDICAO",
            "label_date": "2026-11-05",
            "reservation_number": "0285365145 /02",
            "needed_date": "2026-10-28",
            "department": "PP1",
            "pickup_location": "B02 18 003 F",
            "unload_location": "OCT – OFICINA CENTRAL TER",
            "requester_name": "JOAO DA SILVA SANTOS",
            "receiver_name": "OFICINA CENT",
            "service_order_type": "PM12",
            "service_order_number": "2005113840",
        }
        assert parsed.material == {
            "material_code": "74165325",
            "description": "ARAME SÓLIDO 1,2MM MIG A5.18 ER 70S6",
            "quantity": 54,
            "uom": "KG",
            "lot_number": "0000245045",
            "expiry_date": None,
        }
        assert parsed.pending == []
        assert parsed.warnings == []
        # Print information is dropped, not kept as "unrecognized".
        assert parsed.unrecognized == []

    def test_ot_reservation_and_service_order_stay_separate(self):
        parsed = parse_label(LABEL)
        ids = {
            parsed.header["ot_code"],
            parsed.header["reservation_number"],
            parsed.header["service_order_number"],
        }
        assert len(ids) == 3

    def test_missing_fields_are_pending_not_guessed(self):
        parsed = parse_label("OT: 1003329915\nCódigo: 74165325")
        assert parsed.header["ot_code"] == "1003329915"
        assert parsed.material["quantity"] is None
        assert parsed.header["service_order_type"] is None
        for key in ("quantity", "lot_number", "reservation_number", "service_order_type"):
            assert key in parsed.pending
        # Optional by nature.
        assert "expiry_date" not in parsed.pending

    def test_unknown_text_is_flagged_for_review(self):
        parsed = parse_label("OT: 1\nCentro de custo 4411\nPeso bruto: 60")
        assert parsed.unrecognized == ["Centro de custo 4411", "Peso bruto: 60"]

    def test_several_fields_on_one_line(self):
        parsed = parse_label("OT: 0012 Reserva: 0034 /01   Lote: 000777")
        assert parsed.header["ot_code"] == "0012"
        assert parsed.header["reservation_number"] == "0034 /01"
        assert parsed.material["lot_number"] == "000777"

    def test_bare_barcode_is_the_ot(self):
        parsed = parse_label("1003329915\n")
        assert parsed.header["ot_code"] == "1003329915"
        assert parsed.header["barcode"] == "1003329915"

    def test_unknown_service_order_type_is_not_accepted(self):
        parsed = parse_label("Ordem de serviço: PM13 - 99")
        assert parsed.header["service_order_type"] is None
        assert parsed.header["service_order_number"] == "99"
        assert parsed.warnings

    def test_invalid_date_is_pending_with_warning(self):
        parsed = parse_label("Data: 31/02/2026")
        assert parsed.header["label_date"] is None
        assert "label_date" in parsed.pending
        assert parsed.warnings

    @pytest.mark.parametrize(
        ("raw", "quantity", "unit"),
        [("54", 54, None), ("54 KG", 54, "KG"), ("1.200", 1200, None), ("54,000", 54, None)],
    )
    def test_quantity_formats(self, raw, quantity, unit):
        assert parse_quantity(raw)[:2] == (quantity, unit)

    @pytest.mark.parametrize("raw", ["1,5", "0", "abc", "-3"])
    def test_quantity_not_integer_or_invalid_is_refused(self, raw):
        quantity, _unit, problem = parse_quantity(raw)
        assert quantity is None and problem

    def test_service_order_split(self):
        assert parse_service_order("PM11-123") == ("PM11", "123", None)
        assert parse_service_order("pm 12 / 0045")[:2] == ("PM12", "0045")


class TestOtSource:
    def test_default_source_is_the_sap_base(self, monkeypatch):
        monkeypatch.delenv("SEA_OT_SOURCE", raising=False)
        assert isinstance(get_ot_source(), SapBaseSource)

    def test_source_can_be_switched_off(self, monkeypatch):
        monkeypatch.setenv("SEA_OT_SOURCE", "none")
        source = get_ot_source()
        assert isinstance(source, NoOtSource)
        assert source.lookup(None, "1003329915") is None

    def test_unknown_source_fails_loudly(self, monkeypatch):
        monkeypatch.setenv("SEA_OT_SOURCE", "sap")
        with pytest.raises(RuntimeError):
            get_ot_source()


# ---------------------------------------------------------------- API


def _payload(**overrides):
    parsed = parse_label(LABEL).to_dict()
    body = {
        "warehouse_id": WAREHOUSE,
        "header": parsed["header"],
        "materials": parsed["materials"],
        "source": "ETIQUETA",
        "unrecognized": [],
    }
    body.update(overrides)
    return body


def _register(client, headers, **overrides):
    return client.post("/api/sea/recebimentos", headers=headers, json=_payload(**overrides))


def _second_material(**overrides):
    material = {
        "material_code": "00074165999",
        "description": "ELETRODO REVESTIDO E7018 3,25MM",
        "quantity": 20,
        "uom": "KG",
        "lot_number": "0000300111",
        "expiry_date": "2027-06-30",
    }
    material.update(overrides)
    return material


def _storage_bin(conn, code):
    zone_id = conn.execute(text("SELECT zone_id FROM bins WHERE bin_id = 3")).scalar()
    return conn.execute(
        text(
            """
            INSERT INTO bins (zone_id, warehouse_id, bin_code, bin_barcode, bin_type,
                              putaway_sequence, external_id)
            VALUES (:z, :w, :c, :c, 'Pickable', 9500, :ext) RETURNING bin_id
            """
        ),
        {"z": zone_id, "w": WAREHOUSE, "c": code, "ext": str(uuid.uuid4())},
    ).scalar()


def _detail(client, headers, code="1003329915"):
    resp = client.get(f"/api/sea/ots/{code}", headers=headers)
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


class TestInterpretEndpoint:
    def test_interpret_writes_nothing(self, client, auth_headers, _db_transaction):
        resp = client.post(
            "/api/sea/etiquetas/interpretar", headers=auth_headers, json={"text": LABEL}
        )
        assert resp.status_code == 200, resp.get_json()
        body = resp.get_json()
        assert body["header"]["ot_code"] == "1003329915"
        assert body["materials"][0]["lot_number"] == "0000245045"
        assert body["existing"] is None
        count = _db_transaction.execute(
            text("SELECT COUNT(*) FROM purchase_orders WHERE po_number = '1003329915'")
        ).scalar()
        assert count == 0

    def test_interpret_flags_a_label_already_registered(self, client, auth_headers):
        assert _register(client, auth_headers).status_code == 201
        body = client.post(
            "/api/sea/etiquetas/interpretar", headers=auth_headers, json={"text": LABEL}
        ).get_json()
        assert body["existing"]["ot"] == "1003329915"
        assert body["existing"]["material"] == "DUPLICADO"


class TestLookup:
    def test_unknown_ot_can_start_a_new_receipt(self, client, auth_headers):
        body = client.get(
            "/api/sea/recebimentos/consulta?codigo=1003329915", headers=auth_headers
        ).get_json()
        assert body["found"] is False
        assert body["integration"] == {"source": "base", "data": None}

    def test_registered_ot_is_found_by_code(self, client, auth_headers):
        _register(client, auth_headers)
        body = client.get(
            "/api/sea/recebimentos/consulta?codigo=1003329915", headers=auth_headers
        ).get_json()
        assert body["found"] is True and body["ot"] == "1003329915"


class TestRegistration:
    def test_label_creates_ot_and_material(self, client, auth_headers):
        resp = _register(client, auth_headers)
        assert resp.status_code == 201, resp.get_json()
        assert resp.get_json()["created"] is True

        detail = _detail(client, auth_headers)
        ot = detail["ot"]
        assert ot["ot"] == "1003329915"
        assert ot["barcode"] == "1003329915"
        assert ot["reservation_number"] == "0285365145 /02"
        assert ot["service_order_type"] == "PM12"
        assert ot["service_order_number"] == "2005113840"
        assert ot["label_date"] == "2026-11-05"
        assert ot["needed_date"] == "2026-10-28"
        assert ot["unload_location"] == "OCT – OFICINA CENTRAL TER"
        assert ot["requester_name"] == "JOAO DA SILVA SANTOS"
        assert ot["data_source"] == "ETIQUETA"
        assert ot["status"] == "OPEN"

        (material,) = detail["materials"]
        assert material["sku"] == "74165325"
        assert material["item_name"] == "ARAME SÓLIDO 1,2MM MIG A5.18 ER 70S6"
        assert material["quantity_ordered"] == 54
        assert material["uom"] == "KG"
        # Leading zeros preserved; lot kept apart from the material code.
        assert material["lot_number"] == "0000245045"
        assert material["expiry_date"] is None

    def test_second_label_adds_material_without_overwriting(self, client, auth_headers):
        _register(client, auth_headers)
        resp = _register(client, auth_headers, materials=[_second_material()])
        assert resp.status_code == 201, resp.get_json()
        assert resp.get_json()["created"] is False

        materials = _detail(client, auth_headers)["materials"]
        assert [m["sku"] for m in materials] == ["74165325", "00074165999"]
        assert materials[0]["quantity_ordered"] == 54
        assert materials[0]["lot_number"] == "0000245045"
        assert materials[1]["lot_number"] == "0000300111"
        assert materials[1]["expiry_date"] == "2027-06-30"

    def test_same_label_twice_is_refused_as_duplicate(self, client, auth_headers):
        _register(client, auth_headers)
        resp = _register(client, auth_headers)
        assert resp.status_code == 409
        body = resp.get_json()
        assert body["duplicate"] is True and body["user_facing"] is True
        assert len(_detail(client, auth_headers)["materials"]) == 1

    def test_duplicate_refuses_the_whole_request(self, client, auth_headers):
        _register(client, auth_headers)
        resp = _register(
            client, auth_headers,
            materials=[_second_material(), parse_label(LABEL).to_dict()["materials"][0]],
        )
        assert resp.status_code == 409
        assert [m["sku"] for m in _detail(client, auth_headers)["materials"]] == ["74165325"]

    def test_same_material_with_other_lot_is_flagged(self, client, auth_headers):
        _register(client, auth_headers)
        material = parse_label(LABEL).to_dict()["materials"][0] | {"lot_number": "0000999999"}
        resp = _register(client, auth_headers, materials=[material])
        assert resp.status_code == 409
        assert "outro lote" in resp.get_json()["error"]

    def test_divergent_header_is_reported_and_not_overwritten(self, client, auth_headers):
        _register(client, auth_headers)
        header = parse_label(LABEL).to_dict()["header"] | {
            "department": "PP9", "service_order_type": "PM11",
        }
        resp = _register(
            client, auth_headers, header=header, materials=[_second_material()],
            unrecognized=["Centro de custo 4411"],
        )
        assert resp.status_code == 201, resp.get_json()
        fields = {d["field"] for d in resp.get_json()["divergences"]}
        assert fields == {"department", "service_order_type"}

        ot = _detail(client, auth_headers)["ot"]
        assert ot["department"] == "PP1"
        assert ot["service_order_type"] == "PM12"
        notes = "\n".join(ot["review_notes"])
        assert "PP9" in notes and "Centro de custo 4411" in notes

    def test_existing_ot_gets_missing_header_fields_filled(self, client, auth_headers):
        header = parse_label(LABEL).to_dict()["header"] | {"department": None}
        _register(client, auth_headers, header=header)
        assert _detail(client, auth_headers)["ot"]["department"] is None

        resp = _register(client, auth_headers, materials=[_second_material()])
        assert resp.get_json()["divergences"] == []
        assert _detail(client, auth_headers)["ot"]["department"] == "PP1"

    def test_same_material_code_in_another_ot(self, client, auth_headers, _db_transaction):
        _register(client, auth_headers)
        header = parse_label(LABEL).to_dict()["header"] | {"ot_code": "1003330000"}
        material = parse_label(LABEL).to_dict()["materials"][0] | {
            "lot_number": "0000245099", "quantity": 12,
        }
        resp = _register(client, auth_headers, header=header, materials=[material])
        assert resp.status_code == 201, resp.get_json()
        other = _detail(client, auth_headers, "1003330000")["materials"][0]
        assert (other["lot_number"], other["quantity_ordered"]) == ("0000245099", 12)
        assert _detail(client, auth_headers)["materials"][0]["lot_number"] == "0000245045"
        # One material master shared by both OTs.
        count = _db_transaction.execute(
            text("SELECT COUNT(*) FROM items WHERE sku = '74165325'")
        ).scalar()
        assert count == 1

    def test_new_ot_requires_service_order_type(self, client, auth_headers):
        header = parse_label(LABEL).to_dict()["header"] | {"service_order_type": None}
        resp = _register(client, auth_headers, header=header)
        assert resp.status_code == 400
        assert resp.get_json()["field"] == "service_order_type"

    def test_new_material_requires_description(self, client, auth_headers):
        material = parse_label(LABEL).to_dict()["materials"][0] | {"description": None}
        resp = _register(client, auth_headers, materials=[material])
        assert resp.status_code == 400
        assert resp.get_json()["field"] == "description"

    def test_blank_text_is_stored_as_pending(self, client, auth_headers):
        header = parse_label(LABEL).to_dict()["header"] | {"pickup_location": "   "}
        assert _register(client, auth_headers, header=header).status_code == 201
        assert _detail(client, auth_headers)["ot"]["pickup_location"] is None

    def test_registration_is_audited(self, client, auth_headers, _db_transaction):
        _register(client, auth_headers)
        row = _db_transaction.execute(
            text(
                "SELECT details FROM audit_log WHERE action_type = 'OT_REGISTERED' "
                "ORDER BY log_id DESC LIMIT 1"
            )
        ).fetchone()
        assert row.details["ot"] == "1003329915"
        assert row.details["materials"][0]["lot_number"] == "0000245045"


class TestCorrections:
    @pytest.fixture()
    def registered(self, client, auth_headers):
        resp = _register(client, auth_headers)
        assert resp.status_code == 201, resp.get_json()
        detail = _detail(client, auth_headers)
        return {
            "po_id": detail["ot"]["po_id"],
            "line_id": detail["materials"][0]["po_line_id"],
            "item_id": detail["materials"][0]["item_id"],
        }

    def test_header_correction_changes_only_sent_fields(self, client, auth_headers, registered):
        resp = client.put(
            f"/api/sea/ots/{registered['po_id']}/dados", headers=auth_headers,
            json={"department": "PP2", "pickup_location": ""},
        )
        assert resp.status_code == 200, resp.get_json()
        assert set(resp.get_json()["changes"]) == {"department", "pickup_location"}
        ot = _detail(client, auth_headers)["ot"]
        assert ot["department"] == "PP2"
        assert ot["pickup_location"] is None
        assert ot["reservation_number"] == "0285365145 /02"

    def test_service_order_type_cannot_be_cleared(self, client, auth_headers, registered):
        resp = client.put(
            f"/api/sea/ots/{registered['po_id']}/dados", headers=auth_headers,
            json={"service_order_type": None},
        )
        assert resp.status_code == 400

    def test_material_correction_before_receipt(self, client, auth_headers, registered):
        url = f"/api/sea/ots/{registered['po_id']}/materiais/{registered['line_id']}"
        resp = client.put(
            url, headers=auth_headers, json={"quantity": 50, "lot_number": "0000245046"}
        )
        assert resp.status_code == 200, resp.get_json()
        material = _detail(client, auth_headers)["materials"][0]
        assert (material["quantity_ordered"], material["lot_number"]) == (50, "0000245046")

    def test_quantity_is_locked_after_a_receipt(self, client, auth_headers, registered):
        _receive(client, auth_headers, registered, 10)
        url = f"/api/sea/ots/{registered['po_id']}/materiais/{registered['line_id']}"
        assert client.put(url, headers=auth_headers, json={"quantity": 40}).status_code == 409
        # The lot can still be corrected.
        assert client.put(url, headers=auth_headers, json={"lot_number": "X"}).status_code == 200
        assert client.delete(url, headers=auth_headers).status_code == 409

    def test_remove_material_added_by_mistake(self, client, auth_headers, registered):
        _register(client, auth_headers, materials=[_second_material()])
        materials = _detail(client, auth_headers)["materials"]
        url = f"/api/sea/ots/{registered['po_id']}/materiais/{materials[1]['po_line_id']}"
        assert client.delete(url, headers=auth_headers).status_code == 200
        assert [m["sku"] for m in _detail(client, auth_headers)["materials"]] == ["74165325"]

    def test_last_material_cannot_be_removed(self, client, auth_headers, registered):
        url = f"/api/sea/ots/{registered['po_id']}/materiais/{registered['line_id']}"
        assert client.delete(url, headers=auth_headers).status_code == 409


def _receive(client, headers, registered, quantity):
    resp = client.post(
        "/api/receiving/receive", headers=headers,
        json={"po_id": registered["po_id"],
              "items": [{"item_id": registered["item_id"], "quantity": quantity,
                         "bin_id": STAGING_BIN}]},
    )
    assert resp.status_code == 200, resp.get_json()


class TestTraceability:
    def test_receipt_storage_and_withdrawal_stay_linked_to_the_ot(
        self, client, auth_headers, _db_transaction
    ):
        conn = _db_transaction
        _register(client, auth_headers)
        detail = _detail(client, auth_headers)
        registered = {"po_id": detail["ot"]["po_id"],
                      "item_id": detail["materials"][0]["item_id"]}
        address = _storage_bin(conn, "T-ETQ")

        # Partial receipt, then storage.
        _receive(client, auth_headers, registered, 30)
        resp = client.post(
            "/api/putaway/confirm", headers=auth_headers,
            json={"item_id": registered["item_id"], "from_bin_id": STAGING_BIN,
                  "to_bin_id": address, "quantity": 30, "lot_number": "1003329915"},
        )
        assert resp.status_code == 200, resp.get_json()

        material = _detail(client, auth_headers)["materials"][0]
        assert material["quantity_received"] == 30
        assert material["quantity_remaining"] == 24
        assert material["quantity_available"] == 30
        assert [loc["bin_code"] for loc in material["locations"]] == ["T-ETQ"]
        inventory_id = conn.execute(
            text("SELECT inventory_id FROM inventory WHERE bin_id = :b"), {"b": address}
        ).scalar()

        # Withdrawal of part of it, confirmed by the user who requested it.
        resp = client.post(
            "/api/sea/retiradas", headers=auth_headers,
            json={"ot": "1003329915",
                  "lines": [{"inventory_id": inventory_id, "quantity": 12}]},
        )
        assert resp.status_code == 201, resp.get_json()
        wid = resp.get_json()["withdrawal"]["withdrawal_id"]
        for step in ("separar", "pronta", "entregar"):
            resp = client.post(f"/api/sea/retiradas/{wid}/{step}", headers=auth_headers, json={})
            assert resp.status_code == 200, resp.get_json()

        material = _detail(client, auth_headers)["materials"][0]
        assert material["lot_number"] == "0000245045"
        assert material["quantity_in_stock"] == 18
        assert material["quantity_available"] == 18
        assert material["quantity_withdrawn"] == 12
        kinds = [(m["kind"], m["quantity"]) for m in material["movements"]]
        assert kinds == [("RECEBIMENTO", 30), ("ARMAZENAMENTO", 30), ("RETIRADA", 12)]
        withdrawal = material["movements"][-1]
        assert withdrawal["origin"] == "T-ETQ"
        assert withdrawal["destination"] == conn.execute(
            text("SELECT full_name FROM users WHERE username = 'admin'")
        ).scalar()
        assert withdrawal["responsible"] == "admin"
