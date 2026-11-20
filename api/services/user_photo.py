"""Foto do usuário. Só o administrador coloca ou tira. O painel manda a imagem já reduzida; aqui se
confere que são bytes de imagem de um tipo aceito (pelo conteúdo, não pelo nome do arquivo) e até
MAX_PHOTO_BYTES.
"""

from __future__ import annotations

import base64
import binascii
from typing import Optional

from sqlalchemy import text

MAX_PHOTO_BYTES = 1024 * 1024


class PhotoError(ValueError):
    """Imagem não aceita; a mensagem é para o usuário."""


def sniff_mime(data: bytes) -> Optional[str]:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def decode_photo(payload: str) -> tuple[bytes, str]:
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
    """Muda a cada foto nova (para o cache dos clientes)."""
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
    return db.execute(
        text(
            "SELECT photo, photo_mime, photo_updated_at FROM users "
            "WHERE user_id = :uid AND photo IS NOT NULL"
        ),
        {"uid": user_id},
    ).fetchone()
