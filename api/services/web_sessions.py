"""SEA (mig 093): sessions tracked by the server.

Every login opens a row in ``sea_sessions`` keyed by the token's ``jti``.
The token still carries its own 8 h expiry; the row adds what a bare JWT
cannot do:

* ``end`` -- "Sair" really ends the session; a copied cookie or token
  stops working at once.
* idle timeout -- a web-panel session (token sent in the cookie) that
  made no request for ``WEB_IDLE_MINUTES`` is ended, so a browser closed
  without "Sair" does not stay signed in.

Bearer-token clients (mobile app, withdrawal terminal) are only checked
for an ended session: the app has its own lock and must not fall to the
login screen because the phone sat in a pocket.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from services.auth_service import TOKEN_EXPIRY_HOURS, generate_token

WEB_IDLE_MINUTES = int(os.getenv("SEA_WEB_IDLE_MINUTES", "15"))
# last_seen_at is written at most once per this many seconds per session.
TOUCH_EVERY_SECONDS = 30

LOGOUT = "LOGOUT"
IDLE = "IDLE"
REFRESH = "REFRESH"


def open_session(db, user: dict, client_ip: str, user_agent: str) -> str:
    """Issue a token for ``user`` and record its session. Caller commits."""
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
    # Housekeeping: rows past the token expiry are of no use any more.
    db.execute(text("DELETE FROM sea_sessions WHERE expires_at < NOW() - INTERVAL '1 day'"))
    return token


def _valid_uuid(value) -> bool:
    try:
        uuid.UUID(str(value))
    except ValueError:
        return False
    return True


def check(db, jti, *, web: bool) -> str | None:
    """Why the session of ``jti`` cannot be used, or None when it can.

    ``web`` = token sent in the panel cookie: the session must exist and
    not be idle. Bearer tokens without a row (issued before mig 093) keep
    working until their own expiry. Commits the last-seen update.
    """
    if not jti or not _valid_uuid(jti):
        return "unknown" if web else None
    row = db.execute(
        text("""
            SELECT ended_at IS NOT NULL AS ended,
                   last_seen_at < NOW() - make_interval(mins => :idle) AS idle,
                   last_seen_at < NOW() - make_interval(secs => :touch) AS stale
            FROM sea_sessions WHERE jti = :jti
        """),
        {"jti": jti, "idle": WEB_IDLE_MINUTES, "touch": TOUCH_EVERY_SECONDS},
    ).fetchone()
    if row is None:
        return "unknown" if web else None
    if row.ended:
        return "ended"
    if web and row.idle:
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
    """Mark the session of ``jti`` as ended. Caller commits."""
    if not jti or not _valid_uuid(jti):
        return
    db.execute(
        text("""
            UPDATE sea_sessions SET ended_at = NOW(), end_reason = :reason
            WHERE jti = :jti AND ended_at IS NULL
        """),
        {"jti": jti, "reason": reason},
    )
