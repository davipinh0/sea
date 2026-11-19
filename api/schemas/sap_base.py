"""Rows of the SAP base import (orders, materials, OTs / reservations).

Same conventions as schemas.csv_import: unknown columns are ignored, a
blank cell is "not provided", and text cells may not start a spreadsheet
formula. Codes are text: leading zeros are part of the identifier.
"""

from datetime import date
from typing import Literal, Optional

from pydantic import AliasChoices, ConfigDict, Field, field_validator

from schemas.csv_import import _BaseImportRow, _reject_formula_prefix


class _SapRow(_BaseImportRow):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    @field_validator("*", mode="before")
    @classmethod
    def _no_formula(cls, v):
        return _reject_formula_prefix(v) if isinstance(v, str) else v


class SapOrderRow(_SapRow):
    order_number: str = Field(..., min_length=1, max_length=40)
    order_type: Literal["PM11", "PM12"]
    description: Optional[str] = Field(None, max_length=200)


class SapMaterialRow(_SapRow):
    material_code: str = Field(..., min_length=1, max_length=50)
    description: str = Field(..., min_length=1, max_length=200)
    uom: Optional[str] = Field(None, max_length=10)
    # mig 098: weight of one box ("KG por caixa"), for a material kept in KG.
    pack_weight_kg: Optional[int] = Field(
        None, gt=0, le=100000,
        validation_alias=AliasChoices("pack_weight_kg", "kg_por_caixa", "KG por caixa"))


class SapReservationRow(_SapRow):
    """One material of an OT. Rows with the same ot_number form one OT."""

    ot_number: str = Field(..., min_length=1, max_length=50)
    order_number: str = Field(..., min_length=1, max_length=40)
    material_code: str = Field(..., min_length=1, max_length=50)
    quantity: int = Field(..., gt=0, le=1000000)
    uom: Optional[str] = Field(None, max_length=10)
    # mig 097: batch of the material ("lote" in the spreadsheet is accepted).
    lot_number: Optional[str] = Field(
        None, max_length=50, validation_alias=AliasChoices("lot_number", "lote", "Lote"))
    reservation_number: Optional[str] = Field(None, max_length=40)
    requester_name: Optional[str] = Field(None, max_length=120)
    needed_date: Optional[date] = None
    department: Optional[str] = Field(None, max_length=60)
    pickup_location: Optional[str] = Field(None, max_length=120)
    unload_location: Optional[str] = Field(None, max_length=120)
