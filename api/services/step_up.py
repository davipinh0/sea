"""SEA (mig 095): processes of the web panel released by the phone.

In the web panel (session in the cookie), Recebimento, Armazenagem and
Retirada only work after the user confirms on the registered phone (the
SEA app with the lock by fingerprint or PIN/pattern). The request rides
on the login-approval queue (``sea_login_challenges``) with ``purpose``
set and the panel session that asked in ``session_jti``. Approved, that
session is released in that process (``sea_step_up``) until it goes
``WINDOW_MINUTES`` without use.

The app and the withdrawal terminal (Bearer token) are not gated here:
the app asks for the fingerprint/PIN itself before each process.
"""

from __future__ import annotations

import secrets

from sqlalchemy import text

from services import login_approval

PURPOSES = {
    "recebimento": "Recebimento",
    "armazenagem": "Armazenagem",
    "retirada": "Retirada",
}
WINDOW_MINUTES = 15


def label(purpose: str) -> str:
    return PURPOSES.get(purpose, purpose)


def seconds_left(db, jti, purpose: str) -> int:
    """Seconds this session stays released in ``purpose`` (0 = not)."""
    if not jti or not login_approval._uuid(jti):
        return 0
    value = db.execute(
        text(
            """
            SELECT GREATEST(0, EXTRACT(EPOCH FROM
                     last_used_at + make_interval(mins => :w) - NOW()))::int
            FROM sea_step_up WHERE jti = CAST(:j AS uuid) AND purpose = :p
            """
        ),
        {"j": str(jti), "p": purpose, "w": WINDOW_MINUTES},
    ).scalar()
    return int(value or 0)


def use(db, jti, purpose: str) -> bool:
    """True when released; each use restarts the window. Caller commits."""
    if seconds_left(db, jti, purpose) <= 0:
        return False
    db.execute(
        text(
            "UPDATE sea_step_up SET last_used_at = NOW() "
            "WHERE jti = CAST(:j AS uuid) AND purpose = :p"
        ),
        {"j": str(jti), "p": purpose},
    )
    return True


def grant(db, jti, purpose: str) -> None:
    db.execute(
        text(
            """
            INSERT INTO sea_step_up (jti, purpose) VALUES (CAST(:j AS uuid), :p)
            ON CONFLICT (jti, purpose) DO UPDATE
              SET granted_at = NOW(), last_used_at = NOW()
            """
        ),
        {"j": str(jti), "p": purpose},
    )


def start(db, user_id: int, jti, purpose: str, client_ip: str, user_agent: str):
    """Ask the registered phone to release ``purpose`` for this session.
    Returns the challenge id, or None when the user has no registered
    phone. Caller commits."""
    if not login_approval.trusted_tokens(db, user_id):
        return None
    # Nobody polls this challenge with a secret: the panel follows it by
    # its own session (``status``). The hash only fills the column.
    filler = login_approval._hash(secrets.token_urlsafe(32))
    return str(
        db.execute(
            text(
                """
            INSERT INTO sea_login_challenges
                (user_id, poll_hash, client_ip, user_agent, expires_at, purpose, session_jti)
            VALUES (:u, :h, :ip, :ua, NOW() + make_interval(secs => :ttl), :p, CAST(:j AS uuid))
            RETURNING challenge_id
            """
            ),
            {
                "u": user_id,
                "h": filler,
                "ip": (client_ip or "")[:64],
                "ua": (user_agent or "")[:300],
                "ttl": login_approval.APPROVAL_TTL_SECONDS,
                "p": purpose,
                "j": str(jti),
            },
        ).scalar()
    )


def status(db, challenge_id, user_id: int, jti) -> tuple[str, int] | None:
    """(status, seconds_left) of a request of this session, or None."""
    challenge_id = login_approval._uuid(challenge_id)
    if challenge_id is None or not jti:
        return None
    row = db.execute(
        text(
            """
            SELECT status, expires_at < NOW() AS expired,
                   GREATEST(0, EXTRACT(EPOCH FROM expires_at - NOW()))::int AS seconds_left
            FROM sea_login_challenges
            WHERE challenge_id = CAST(:id AS uuid) AND user_id = :u
              AND session_jti = CAST(:j AS uuid) AND purpose IS NOT NULL
            """
        ),
        {"id": challenge_id, "u": user_id, "j": str(jti)},
    ).fetchone()
    if row is None:
        return None
    if row.status == login_approval.PENDING and row.expired:
        return login_approval.EXPIRED, 0
    return row.status, row.seconds_left


def on_decision(db, challenge_id) -> str | None:
    """After the phone approved: release the session that asked. Returns
    the purpose, or None for a login challenge. Caller commits."""
    row = db.execute(
        text(
            "SELECT purpose, session_jti, status FROM sea_login_challenges "
            "WHERE challenge_id = CAST(:id AS uuid)"
        ),
        {"id": str(challenge_id)},
    ).fetchone()
    if row is None or row.purpose is None:
        return None
    if row.status == login_approval.APPROVED and row.session_jti is not None:
        grant(db, row.session_jti, row.purpose)
    return row.purpose
