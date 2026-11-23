"""Item request schemas."""

from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field


class CreateItemRequest(BaseModel):
    sku: str = Field(..., min_length=1, max_length=128)
    item_name: str = Field(..., min_length=1, max_length=256)
    description: Optional[str] = Field(None, max_length=1000)
    category: Optional[str] = Field(None, max_length=128)
    weight_lbs: Optional[Decimal] = Field(None, ge=0, le=99999)
    default_bin_id: Optional[int] = Field(None, gt=0)
    # Regras de armazenagem: classe de tamanho e grupo de compatibilidade (NULL = sem regra).
    size_class: Optional[Literal["PEQUENO", "GRANDE"]] = None
    compat_group: Optional[str] = Field(None, max_length=50)
    uom: Optional[str] = Field(None, max_length=10)
    # Peso de uma caixa, para material em KG que sai por caixa.
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)


class UpdateItemRequest(BaseModel):
    sku: Optional[str] = Field(None, min_length=1, max_length=128)
    item_name: Optional[str] = Field(None, min_length=1, max_length=256)
    description: Optional[str] = Field(None, max_length=1000)
    category: Optional[str] = Field(None, max_length=128)
    weight_lbs: Optional[Decimal] = Field(None, ge=0, le=99999)
    default_bin_id: Optional[int] = Field(None, gt=0)
    reorder_point: Optional[int] = Field(None, ge=0)
    reorder_qty: Optional[int] = Field(None, ge=0)
    is_active: Optional[bool] = None
    # Regras de armazenagem: classe de tamanho e grupo de compatibilidade (NULL = sem regra).
    size_class: Optional[Literal["PEQUENO", "GRANDE"]] = None
    compat_group: Optional[str] = Field(None, max_length=50)
    uom: Optional[str] = Field(None, max_length=10)
    # Peso de uma caixa, para material em KG que sai por caixa.
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)


class CreatePreferredBinRequest(BaseModel):
    item_id: int = Field(..., gt=0)
    bin_id: int = Field(..., gt=0)
    priority: int = Field(1, ge=1, le=100)


class UpdatePreferredBinRequest(BaseModel):
    priority: int = Field(..., ge=1, le=100)
