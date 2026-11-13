"""Employee identification by corporate e-mail (integration seam).

The withdrawal terminal identifies the employee by their login. The
company directory (e.g. Microsoft Entra ID) is not available to the
prototype, so the default provider resolves the e-mail against the SEA
user table and the password is checked locally.

A future directory integration implements ``IdentityProvider``,
registers itself in ``_PROVIDERS`` and is selected with the
``SEA_IDENTITY_PROVIDER`` environment variable. Nothing about that
system (endpoints, tenant, claims) is assumed here: the only contract
is "identifier typed at the login -> SEA username, or None".
"""

from __future__ import annotations

import os
from typing import Optional, Protocol

from sqlalchemy import text


class IdentityProvider(Protocol):
    name: str

    def resolve_username(self, db, identifier: str) -> Optional[str]:
        """SEA username for a login identifier, or None when unknown."""


class LocalIdentityProvider:
    """E-mail registered on the SEA user (Sistema > Usuários)."""

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
