"""Integration seam: where the SEA asks an external system about an OT.

The default source is the SAP base kept inside the SEA (mig 085,
services.sap_base): orders, materials and open OTs / reservations that
come from SAP. The base is loaded by import today; SAP itself is closed
to the prototype, so nothing here talks to it and nothing about it
(endpoint, protocol, credentials, payload) is assumed.

The contract the rest of the SEA depends on:

    get_ot_source().lookup(db, "1003329915") -> OtData | None

Receiving calls it when a scanned OT is not registered yet. ``None``
means "not in the base", and the operator can still carry on with the
label. A live integration implements ``OtSource``, registers itself in
``_SOURCES`` and is switched on with the SEA_OT_SOURCE environment
variable; the data it returns goes through the same registration path
as a label (services.sea_service.register_ot_materials), so receiving,
storage and withdrawal need no change.
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
    expiry_date: str | None = None  # ISO date
    # The order this material belongs to (an OT brings several orders).
    service_order_type: str | None = None  # PM11 / PM12
    service_order_number: str | None = None
    # Weight of one box for a material kept in KG (withdrawn by box).
    pack_weight_kg: int | None = None


@dataclass(frozen=True)
class OtData:
    """Same shape the label interpreter produces (header + materials)."""

    ot_code: str
    barcode: str | None = None
    origin_company: str | None = None
    label_date: str | None = None  # ISO date
    reservation_number: str | None = None
    needed_date: str | None = None  # ISO date
    department: str | None = None
    pickup_location: str | None = None
    unload_location: str | None = None
    requester_name: str | None = None
    receiver_name: str | None = None
    service_order_type: str | None = None  # PM11 / PM12
    service_order_number: str | None = None
    materials: tuple[OtMaterialData, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, object]:
        header = asdict(self)
        materials = header.pop("materials")
        return {"header": header, "materials": materials}


class OtSource(Protocol):
    name: str

    def lookup(self, db, ot_code: str) -> OtData | None:
        """Return the OT as known by the source, or None. ``db`` is the
        request's database session."""


class NoOtSource:
    """No source: every OT is registered from its label."""

    name = "none"

    def lookup(self, db, ot_code: str) -> OtData | None:
        return None


class SapBaseSource:
    """Default: the SAP base kept in the SEA database."""

    name = "base"

    def lookup(self, db, ot_code: str) -> OtData | None:
        from services import sap_base  # sap_base builds OtData from this module

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
