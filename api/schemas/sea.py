
from datetime import date
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _LabelModel(BaseModel):
    """Campo vazio vira None ("pendente"), nunca uma string vazia."""

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
    """Todo campo é opcional: o que não se sabe fica pendente."""

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
    # A etiqueta pode trazer um recebedor; ele é ignorado: o recebedor é quem registra a entrega.
    receiver_name: Optional[str] = Field(None, max_length=120)


class OtMaterial(_LabelModel):
    # Códigos e lotes são texto: zeros à esquerda fazem parte.
    material_code: str = Field(..., min_length=1, max_length=50)
    description: Optional[str] = Field(None, max_length=200)
    quantity: int = Field(..., gt=0, le=1000000)
    uom: Optional[str] = Field(None, max_length=10)
    lot_number: Optional[str] = Field(None, max_length=50)
    expiry_date: Optional[date] = None
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)

    @field_validator("uom")
    @classmethod
    def _unit_in_capitals(cls, v):
        return v.upper() if isinstance(v, str) else v

    service_order_type: Optional[Literal["PM11", "PM12"]] = None
    service_order_number: Optional[str] = Field(None, max_length=40)


class RegisterOtRequest(BaseModel):
    warehouse_id: int = Field(..., gt=0)
    header: OtHeader
    materials: List[OtMaterial] = Field(..., min_length=1, max_length=50)
    source: Literal["MANUAL", "ETIQUETA"] = "ETIQUETA"
    # Texto da etiqueta que não foi reconhecido, guardado para revisão.
    unrecognized: List[Annotated[str, Field(max_length=300)]] = Field(
        default_factory=list, max_length=50
    )


class RegisterFromBaseRequest(BaseModel):

    model_config = ConfigDict(str_strip_whitespace=True)

    warehouse_id: int = Field(..., gt=0)
    ot_code: str = Field(..., min_length=1, max_length=50)


class InterpretLabelRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)


class UpdateOtDataRequest(OtHeaderFields):
    """Só os campos enviados mudam."""


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
    # No terminal, quem não tem acesso ao SEA é identificado só pelo e-mail corporativo.
    requester_email: Optional[str] = Field(None, max_length=254)

    @field_validator("requester_email")
    @classmethod
    def _email(cls, value):
        if value is None:
            return None
        value = value.strip().lower()
        if not value:
            return None
        local, at, domain = value.partition("@")
        if not at or not local or "." not in domain or " " in value or "@" in domain:
            raise ValueError("Informe um e-mail corporativo válido (ex.: nome@empresa.com).")
        return value


class CatalogMaterialFields(_LabelModel):
    description: str = Field(..., min_length=1, max_length=200)
    uom: Optional[str] = Field(None, max_length=10)
    pack_weight_kg: Optional[int] = Field(None, gt=0, le=100000)


class CreateCatalogMaterialRequest(CatalogMaterialFields):
    material_code: str = Field(..., min_length=1, max_length=50)


class UpdateCatalogMaterialRequest(CatalogMaterialFields):
    """O código vem no endereço."""


class BaseOtMaterial(_LabelModel):
    order_number: str = Field(..., min_length=1, max_length=40)
    order_type: Literal["PM11", "PM12"]
    material_code: str = Field(..., min_length=1, max_length=50)
    quantity: int = Field(..., gt=0, le=1000000)
    uom: Optional[str] = Field(None, max_length=10)


class CreateBaseOtRequest(_LabelModel):

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
    # Trava do app ligada: este celular pode confirmar os logins do usuário.
    secure_lock: bool = False
    device_name: Optional[str] = Field(None, max_length=100)


class LoginDecisionRequest(BaseModel):

    model_config = ConfigDict(str_strip_whitespace=True)

    approve: bool
    device_token: str = Field(..., min_length=10, max_length=200)


class TransferStockRequest(BaseModel):

    model_config = ConfigDict(str_strip_whitespace=True)

    inventory_id: int = Field(..., gt=0)
    to_bin_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0, le=1000000)
    reason: Optional[str] = Field(None, max_length=500)


class EvaluateWithdrawalRequest(BaseModel):
    """Negar exige o motivo; o serviço confere."""

    model_config = ConfigDict(str_strip_whitespace=True)

    approve: bool
    note: Optional[str] = Field(None, max_length=500)


class CancelWithdrawalRequest(BaseModel):

    model_config = ConfigDict(str_strip_whitespace=True)

    reason: str = Field(..., min_length=1, max_length=500)


SessionId = Annotated[str, Field(pattern=r"^[0-9a-f]{16}$")]


class EndSessionsRequest(BaseModel):
    """Sessões do próprio usuário a desconectar ("Gerenciar Acessos"), pelos ids da lista."""

    ids: List[SessionId] = Field(..., min_length=1, max_length=50)
