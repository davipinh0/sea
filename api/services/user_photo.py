"""SEA: user photo (mig 091).

Only an administrator sets or removes it (Sistema > Usuários). The panel
sends the picture already reduced (256 px JPEG) as base64; this module
checks what arrived before it goes to the database: real image bytes of
an accepted type (by content, not by the name the browser gave) and at
most ``MAX_PHOTO_BYTES``.
"""

from __future__ import annotations

import base64
import binascii
from typing import Optional

from sqlalchemy import text

MAX_PHOTO_BYTES = 1024 * 1024


class PhotoError(ValueError):
    """The upload is not an accepted picture; the message is for the user."""


def sniff_mime(data: bytes) -> Optional[str]:
    """Image type from the first bytes, or None when it is not one we accept."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def decode_photo(payload: str) -> tuple[bytes, str]:
    """Bytes and type of a base64 picture (a ``data:`` URL is accepted)."""
    raw = (payload or "").strip()
    if raw.startswith("data:"):
        _, _, raw = raw.partition(",")
    if not raw:
        raise PhotoError("Escolha uma foto.")
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise PhotoError("A foto não chegou inteira. Escolha de novo.") from None
    if len(data) > MAX_PHOTO_BYTES:
        raise PhotoError("A foto é grande demais (máximo 1 MB).")
    mime = sniff_mime(data)
    if mime is None:
        raise PhotoError("Formato não aceito. Use uma foto JPG, PNG ou WEBP.")
    return data, mime


def photo_version(updated_at) -> Optional[int]:
    """Number that changes with each new photo (for the clients' cache)."""
    return int(updated_at.timestamp()) if updated_at else None


def save_photo(db, user_id: int, data: bytes, mime: str) -> Optional[int]:
    row = db.execute(
        text(
            "UPDATE users SET photo = :photo, photo_mime = :mime, photo_updated_at = NOW() "
            "WHERE user_id = :uid RETURNING photo_updated_at"
        ),
        {"photo": data, "mime": mime, "uid": user_id},
    ).fetchone()
    return photo_version(row.photo_updated_at) if row else None


def remove_photo(db, user_id: int) -> bool:
    row = db.execute(
        text(
            "UPDATE users SET photo = NULL, photo_mime = NULL, photo_updated_at = NULL "
            "WHERE user_id = :uid RETURNING user_id"
        ),
        {"uid": user_id},
    ).fetchone()
    return row is not None


def load_photo(db, user_id: int):
    """Row with ``photo``, ``photo_mime`` and ``photo_updated_at``, or None."""
    return db.execute(
        text(
            "SELECT photo, photo_mime, photo_updated_at FROM users "
            "WHERE user_id = :uid AND photo IS NOT NULL"
        ),
        {"uid": user_id},
    ).fetchone()
