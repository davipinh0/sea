"""Sessões controladas pelo servidor, uma linha por token (``jti``).
O token continua vencendo em 8 h; a linha acrescenta o que um JWT sozinho não faz:
- "Sair" encerra de verdade: uma cópia do cookie ou do token para de funcionar na hora;
- no painel (cookie), a sessão sem uso por WEB_IDLE_MINUTES termina, então um navegador fechado
sem "Sair" não fica logado.
O app e o terminal (Bearer) só são barrados se a sessão foi encerrada: o app tem a própria trava.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from services.auth_service import TOKEN_EXPIRY_HOURS, generate_token

WEB_IDLE_MINUTES = int(os.getenv("SEA_WEB_IDLE_MINUTES", "15"))
# last_seen_at é gravado no máximo uma vez a cada tantos segundos por sessão.
TOUCH_EVERY_SECONDS = 30

LOGOUT = "LOGOUT"
IDLE = "IDLE"
REFRESH = "REFRESH"


def open_session(db, user: dict, client_ip: str, user_agent: str) -> str:
    """Quem chama faz o commit."""
    jti = str(uuid.uuid4())
    token = generate_token(user, jti=jti)
    expires_at = datetime.now(UTC) + timedelta(hours=TOKEN_EXPIRY_HOURS)
    db.execute(
        text("""
            INSERT INTO sea_sessions (jti, user_id, client_ip, user_agent, expires_at)
            VALUES (:jti, :uid, :ip, :ua, :exp)
        """),
        {
            "jti": jti,
            "uid": user["user_id"],
            "ip": (client_ip or "")[:64],
            "ua": (user_agent or "")[:300],
            "exp": expires_at,
        },
    )
    db.execute(text("DELETE FROM sea_sessions WHERE expires_at < NOW() - INTERVAL '1 day'"))
    return token


def _valid_uuid(value) -> bool:
    try:
        uuid.UUID(str(value))
    except ValueError:
        return False
    return True


def check(db, jti, *, web: bool) -> str | None:
    """Por que a sessão não pode ser usada, ou None se pode. No painel a sessão precisa existir e
    não estar inativa. Tokens Bearer sem linha (anteriores a este controle) valem até vencer.
    """
    if not jti or not _valid_uuid(jti):
        return "unknown" if web else None
    row = db.execute(
        text("""
            SELECT s.ended_at IS NOT NULL AS ended,
                   s.last_seen_at < NOW() - make_interval(mins => :idle) AS idle,
                   s.last_seen_at < NOW() - make_interval(secs => :touch) AS stale,
                   -- mig 098: the terminal account stays signed in while the
                   -- terminal waits for the next employee (token expiry still
                   -- applies). It can only open the terminal.
                   EXISTS (SELECT 1 FROM users u
                           JOIN user_page_permissions pp ON pp.user_id = u.user_id
                           WHERE u.user_id = s.user_id AND u.role <> 'ADMIN'
                             AND pp.page_key = 'terminal-retirada') AS kiosk
            FROM sea_sessions s WHERE s.jti = :jti
        """),
        {"jti": jti, "idle": WEB_IDLE_MINUTES, "touch": TOUCH_EVERY_SECONDS},
    ).fetchone()
    if row is None:
        return "unknown" if web else None
    if row.ended:
        return "ended"
    if web and row.idle and not row.kiosk:
        end(db, jti, IDLE)
        db.commit()
        return "idle"
    if row.stale:
        db.execute(
            text("UPDATE sea_sessions SET last_seen_at = NOW() WHERE jti = :jti"), {"jti": jti}
        )
        db.commit()
    return None


def end(db, jti, reason: str) -> None:
    """Quem chama faz o commit."""
    if not jti or not _valid_uuid(jti):
        return
    db.execute(
        text("""
            UPDATE sea_sessions SET ended_at = NOW(), end_reason = :reason
            WHERE jti = :jti AND ended_at IS NULL
        """),
        {"jti": jti, "reason": reason},
    )
