"""SEA request schemas (label receiving and withdrawal terminal)."""

from datetime import date
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _LabelModel(BaseModel):
    """Text fields are trimmed and a blank becomes None ("pendente"),
    so an empty form field is never stored as an empty string."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _blank_to_none(cls, data):
        if isinstance(data, dict):
            return {
                k: (None if isinstance(v, str) and not v.strip() else v)
                for k, v in data.items()
            }
        return data


class OtHeaderFields(_LabelModel):
    """Label header. Every field is optional: unknown stays pending."""

    barcode: Optional[str] = Field(None, max_length=100)
    origin_company: Optional[str] = Field(None, max_length=200)
    label_date: Optional[date] = None
    reservation_number: Optional[str] = Field(None, max_length=40)
    needed_date: Optional[date] = None
    department: Optional[str] = Field(None, max_length=60)
    pickup_location: Optional[str] = Field(None, max_length=120)
    unload_location: Optional[str] = Field(None, max_length=120)
    requester_name: Optional[str] = Field(None, max_length=120)
    service_order_type: Optional[Literal["PM11", "PM12"]] = None
    service_order_number: Optional[str] = Field(None, max_length=40)


class OtHeader(OtHeaderFields):
    ot_code: str = Field(..., min_length=1, max_length=50)
    # A label may print a receiver. It is accepted and ignored: the
    # receiver is the user who registers the delivery.
    receiver_name: Optional[str] = Field(None, max_length=120)


class OtMaterial(_LabelModel):
    # Codes and lots are text: leading zeros are part of the identifier.
    material_code: str = Field(..., min_length=1, max_length=50)
    description: Optional[str] = Field(None, max_length=200)
    quantity: int = Field(..., gt=0, le=1000000)
    uom: Optional[str] = Field(None, max_length=10)
    lot_number: Optional[str] = Field(None, max_length=50)
    expiry_date: Optional[date] = None
    # Weight of one box, for a material kept in KG and withdrawn by box.
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)

    @field_validator("uom")
    @classmethod
    def _unit_in_capitals(cls, v):
        return v.upper() if isinstance(v, str) else v

    # The order this material belongs to, when it differs from the header's.
    service_order_type: Optional[Literal["PM11", "PM12"]] = None
    service_order_number: Optional[str] = Field(None, max_length=40)


class RegisterOtRequest(BaseModel):
    warehouse_id: int = Field(..., gt=0)
    header: OtHeader
    materials: List[OtMaterial] = Field(..., min_length=1, max_length=50)
    source: Literal["MANUAL", "ETIQUETA"] = "ETIQUETA"
    # Label text the interpreter could not classify, kept for review.
    unrecognized: List[Annotated[str, Field(max_length=300)]] = Field(
        default_factory=list, max_length=50
    )


class RegisterFromBaseRequest(BaseModel):
    """Register the delivery of an OT exactly as the SAP base holds it."""

    model_config = ConfigDict(str_strip_whitespace=True)

    warehouse_id: int = Field(..., gt=0)
    ot_code: str = Field(..., min_length=1, max_length=50)


class InterpretLabelRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)


class UpdateOtDataRequest(OtHeaderFields):
    """Correction of the header. Only the fields sent are changed."""


class UpdateOtMaterialRequest(_LabelModel):
    quantity: Optional[int] = Field(None, gt=0, le=1000000)
    uom: Optional[str] = Field(None, max_length=10)
    lot_number: Optional[str] = Field(None, max_length=50)
    expiry_date: Optional[date] = None


class WithdrawalLine(BaseModel):
    inventory_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0, le=1000000)


class CreateWithdrawalRequest(BaseModel):
    ot: str = Field(..., min_length=1, max_length=128)
    lines: List[WithdrawalLine] = Field(..., min_length=1, max_length=200)
    note: Optional[str] = Field(None, max_length=500)


class CatalogMaterialFields(_LabelModel):
    description: str = Field(..., min_length=1, max_length=200)
    uom: Optional[str] = Field(None, max_length=10)
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)


class CreateCatalogMaterialRequest(CatalogMaterialFields):
    material_code: str = Field(..., min_length=1, max_length=50)


class UpdateCatalogMaterialRequest(CatalogMaterialFields):
    """Change of a catalogue entry (the code is in the address)."""


class BaseOtMaterial(_LabelModel):
    order_number: str = Field(..., min_length=1, max_length=40)
    order_type: Literal["PM11", "PM12"]
    material_code: str = Field(..., min_length=1, max_length=50)
    quantity: int = Field(..., gt=0, le=1000000)
    uom: Optional[str] = Field(None, max_length=10)


class CreateBaseOtRequest(_LabelModel):
    """An OT put together by hand in the SAP base."""

    ot_number: str = Field(..., min_length=1, max_length=50)
    reservation_number: Optional[str] = Field(None, max_length=40)
    requester_name: Optional[str] = Field(None, max_length=120)
    needed_date: Optional[date] = None
    department: Optional[str] = Field(None, max_length=60)
    pickup_location: Optional[str] = Field(None, max_length=120)
    unload_location: Optional[str] = Field(None, max_length=120)
    materials: List[BaseOtMaterial] = Field(..., min_length=1, max_length=50)


class RegisterPushTokenRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    token: str = Field(..., min_length=10, max_length=200)


class TransferStockRequest(BaseModel):
    """Move stored material to another address (any location)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    inventory_id: int = Field(..., gt=0)
    to_bin_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0, le=1000000)
    reason: Optional[str] = Field(None, max_length=500)


class CancelWithdrawalRequest(BaseModel):
    """A cancellation always carries its reason (never blank)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    reason: str = Field(..., min_length=1, max_length=500)
