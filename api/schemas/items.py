"""Item request schemas."""

from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field


class CreateItemRequest(BaseModel):
    sku: str = Field(..., min_length=1, max_length=128)
    item_name: str = Field(..., min_length=1, max_length=256)
    description: Optional[str] = Field(None, max_length=1000)
    upc: Optional[str] = Field(None, max_length=128)
    mpn: Optional[str] = Field(None, max_length=64)
    category: Optional[str] = Field(None, max_length=128)
    weight_lbs: Optional[Decimal] = Field(None, ge=0, le=99999)
    default_bin_id: Optional[int] = Field(None, gt=0)
    # SEA SP12 rules: size class and compatibility group (NULL = none).
    size_class: Optional[Literal["PEQUENO", "GRANDE"]] = None
    compat_group: Optional[str] = Field(None, max_length=50)
    # SEA: unit of measure of the material (PC, KG, PAR ...).
    uom: Optional[str] = Field(None, max_length=10)
    # SEA: weight of one box, for materials kept in KG and withdrawn by box.
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)


class UpdateItemRequest(BaseModel):
    sku: Optional[str] = Field(None, min_length=1, max_length=128)
    item_name: Optional[str] = Field(None, min_length=1, max_length=256)
    description: Optional[str] = Field(None, max_length=1000)
    upc: Optional[str] = Field(None, max_length=128)
    mpn: Optional[str] = Field(None, max_length=64)
    category: Optional[str] = Field(None, max_length=128)
    weight_lbs: Optional[Decimal] = Field(None, ge=0, le=99999)
    default_bin_id: Optional[int] = Field(None, gt=0)
    reorder_point: Optional[int] = Field(None, ge=0)
    reorder_qty: Optional[int] = Field(None, ge=0)
    is_active: Optional[bool] = None
    # SEA SP12 rules: size class and compatibility group (NULL = none).
    size_class: Optional[Literal["PEQUENO", "GRANDE"]] = None
    compat_group: Optional[str] = Field(None, max_length=50)
    # SEA: unit of measure of the material (PC, KG, PAR ...).
    uom: Optional[str] = Field(None, max_length=10)
    # SEA: weight of one box, for materials kept in KG and withdrawn by box.
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)


class CreatePreferredBinRequest(BaseModel):
    item_id: int = Field(..., gt=0)
    bin_id: int = Field(..., gt=0)
    priority: int = Field(1, ge=1, le=100)


class UpdatePreferredBinRequest(BaseModel):
    priority: int = Field(..., ge=1, le=100)
