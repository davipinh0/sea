"""Linhas da importação da base do SAP. Colunas desconhecidas são ignoradas, célula vazia é "não
informado" e nenhuma célula pode começar uma fórmula. Códigos são texto: zeros à esquerda fazem
parte.
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
    pack_weight_kg: Optional[int] = Field(
        None, gt=0, le=100000,
        validation_alias=AliasChoices("pack_weight_kg", "kg_por_caixa", "KG por caixa"))


class SapReservationRow(_SapRow):

    ot_number: str = Field(..., min_length=1, max_length=50)
    order_number: str = Field(..., min_length=1, max_length=40)
    material_code: str = Field(..., min_length=1, max_length=50)
    quantity: int = Field(..., gt=0, le=1000000)
    uom: Optional[str] = Field(None, max_length=10)
    lot_number: Optional[str] = Field(
        None, max_length=50, validation_alias=AliasChoices("lot_number", "lote", "Lote"))
    reservation_number: Optional[str] = Field(None, max_length=40)
    requester_name: Optional[str] = Field(None, max_length=120)
    needed_date: Optional[date] = None
    department: Optional[str] = Field(None, max_length=60)
    pickup_location: Optional[str] = Field(None, max_length=120)
    unload_location: Optional[str] = Field(None, max_length=120)
