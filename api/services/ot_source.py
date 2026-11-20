"""Ponto de integração: onde o SEA pergunta a um sistema externo sobre uma OT.
O padrão é a base do SAP guardada no SEA, carregada por importação; nada aqui conversa com o SAP.
Contrato: get_ot_source().lookup(db, "1003329915") -> OtData | None (None = não está na base; o
operador segue pela etiqueta). Uma integração real implementa ``OtSource``, entra em ``_SOURCES``
e é ligada por SEA_OT_SOURCE. Os dados passam pelo mesmo registro da etiqueta, então recebimento,
armazenagem e retirada não mudam.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class OtMaterialData:
    material_code: str
    description: str | None = None
    quantity: int | None = None
    uom: str | None = None
    lot_number: str | None = None
    expiry_date: str | None = None
    # Uma OT pode trazer materiais de várias ordens.
    service_order_type: str | None = None
    service_order_number: str | None = None
    pack_weight_kg: int | None = None


@dataclass(frozen=True)
class OtData:

    ot_code: str
    barcode: str | None = None
    origin_company: str | None = None
    label_date: str | None = None
    reservation_number: str | None = None
    needed_date: str | None = None
    department: str | None = None
    pickup_location: str | None = None
    unload_location: str | None = None
    requester_name: str | None = None
    receiver_name: str | None = None
    service_order_type: str | None = None
    service_order_number: str | None = None
    materials: tuple[OtMaterialData, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, object]:
        header = asdict(self)
        materials = header.pop("materials")
        return {"header": header, "materials": materials}


class OtSource(Protocol):
    name: str

    def lookup(self, db, ot_code: str) -> OtData | None:
        """A OT segundo a fonte, ou None."""


class NoOtSource:
    """Sem fonte: toda OT é cadastrada pela etiqueta."""

    name = "none"

    def lookup(self, db, ot_code: str) -> OtData | None:
        return None


class SapBaseSource:

    name = "base"

    def lookup(self, db, ot_code: str) -> OtData | None:
        from services import sap_base

        return sap_base.lookup(db, ot_code)


_SOURCES: dict[str, type] = {NoOtSource.name: NoOtSource, SapBaseSource.name: SapBaseSource}


def get_ot_source() -> OtSource:
    name = os.environ.get("SEA_OT_SOURCE", SapBaseSource.name).strip().lower() or SapBaseSource.name
    try:
        return _SOURCES[name]()
    except KeyError:
        raise RuntimeError(
            f"SEA_OT_SOURCE={name!r} não é uma fonte de OT conhecida "
            f"(disponíveis: {', '.join(sorted(_SOURCES))})."
        ) from None
