"""User request schemas."""

from typing import List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

VALID_ROLES = ("ADMIN", "USER")
# Só confere o formato (um @, domínio com ponto, sem espaços); vazio é permitido.
EMAIL_PATTERN = r"^$|^[^@\s]+@[^@\s]+\.[^@\s]+$"


class UpdateUserPagePermissionsRequest(BaseModel):
    """Replaces a user's full per-page grant
    set in one PUT. The handler validates each key against
    constants.ALL_PAGE_KEYS so a typo lands as a clean 400 rather
    than a silent grant that the sidebar will never honor."""

    page_keys: List[str] = Field(default_factory=list, max_length=200)


class UserPhotoRequest(BaseModel):
    """Foto em base64 (ou data: URL). O painel manda reduzida; services.user_photo confere tipo e
    tamanho.
    """

    image: str = Field(..., min_length=1, max_length=1_500_000)


# Motivos de remover os celulares de um usuário; o painel mostra os mesmos textos.
DEVICE_REMOVAL_REASONS = {
    "perdido": "Celular perdido",
    "roubado": "Celular roubado ou furtado",
    "troca": "Troca de celular",
    "defeito": "Celular com defeito",
    "desligamento": "Desligamento ou afastamento do funcionário",
    "funcao": "Mudança de função ou de setor",
    "suspeita": "Suspeita de uso indevido",
    "outro": "Outro",
}


class RemoveDevicesRequest(BaseModel):
    """Um ou mais motivos; "outro" pede a explicação."""

    reasons: List[str] = Field(..., min_length=1, max_length=len(DEVICE_REMOVAL_REASONS))
    note: str = Field("", max_length=300)

    @field_validator("reasons")
    @classmethod
    def known_reasons(cls, value: List[str]) -> List[str]:
        unknown = [r for r in value if r not in DEVICE_REMOVAL_REASONS]
        if unknown:
            raise ValueError(f"Motivo desconhecido: {', '.join(unknown)}")
        return list(dict.fromkeys(value))

    @field_validator("note")
    @classmethod
    def strip_note(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def other_needs_note(self) -> "RemoveDevicesRequest":
        if "outro" in self.reasons and len(self.note) < 3:
            raise ValueError('Explique o motivo em "Outro".')
        return self


class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=150)
    password: str = Field(..., min_length=1, max_length=256)
    full_name: str = Field(..., min_length=1, max_length=256)
    role: str = Field(..., min_length=1, max_length=32)
    warehouse_ids: List[int] = Field(default_factory=list)
    warehouse_id: Optional[int] = Field(None, gt=0)
    allowed_functions: List[str] = Field(default_factory=list)
    # E-mail corporativo: login no terminal e destino das notificações dos administradores. Texto
    # vazio apaga.
    email: Optional[str] = Field(None, max_length=254, pattern=EMAIL_PATTERN)
    # Login com senha fora do celular cadastrado espera a confirmação no app.
    web_login_approval: bool = False

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in VALID_ROLES:
            raise ValueError(f"role must be one of: {', '.join(VALID_ROLES)}")
        return v


class UpdateUserRequest(BaseModel):
    full_name: Optional[str] = Field(None, min_length=1, max_length=256)
    role: Optional[str] = Field(None, min_length=1, max_length=32)
    warehouse_id: Optional[int] = Field(None, gt=0)
    warehouse_ids: Optional[List[int]] = None
    allowed_functions: Optional[List[str]] = None
    is_active: Optional[bool] = None
    password: Optional[str] = Field(None, min_length=1, max_length=256)
    # E-mail corporativo: login no terminal e destino das notificações dos administradores. Texto
    # vazio apaga.
    email: Optional[str] = Field(None, max_length=254, pattern=EMAIL_PATTERN)
    web_login_approval: Optional[bool] = None

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VALID_ROLES:
            raise ValueError(f"role must be one of: {', '.join(VALID_ROLES)}")
        return v
