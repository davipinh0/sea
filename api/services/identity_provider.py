"""Identificação do funcionário (ponto de integração).
Sem o diretório da empresa, o padrão busca o e-mail na tabela de usuários do SEA e confere a
senha aqui. Uma integração (Entra ID, por exemplo) implementa ``IdentityProvider``, entra em
``_PROVIDERS`` e é escolhida por SEA_IDENTITY_PROVIDER. O contrato é só: identificador digitado
-> usuário do SEA, ou None.
"""

from __future__ import annotations

import os
from typing import Optional, Protocol

from sqlalchemy import text


class IdentityProvider(Protocol):
    name: str

    def resolve_username(self, db, identifier: str) -> Optional[str]:
        """Usuário do SEA para o identificador, ou None."""


class LocalIdentityProvider:

    name = "local"

    def resolve_username(self, db, identifier: str) -> Optional[str]:
        if "@" not in identifier:
            return identifier
        return db.execute(
            text("SELECT username FROM users WHERE LOWER(email) = :e AND is_active = TRUE"),
            {"e": identifier.strip().lower()},
        ).scalar()


_PROVIDERS = {LocalIdentityProvider.name: LocalIdentityProvider}


def get_identity_provider() -> IdentityProvider:
    name = (os.environ.get("SEA_IDENTITY_PROVIDER") or LocalIdentityProvider.name).strip().lower()
    try:
        return _PROVIDERS[name]()
    except KeyError:
        raise RuntimeError(
            f"SEA_IDENTITY_PROVIDER desconhecido: {name!r}. Disponíveis: {', '.join(_PROVIDERS)}"
        ) from None
