"""Login com senha confirmado no celular do usuário.
Com a confirmação ligada e um celular cadastrado (app com trava), o login feito em outro lugar
não abre a sessão na hora: cria um pedido, o celular recebe um push e a sessão só abre depois da
confirmação no app. Quem iniciou o login acompanha com um segredo próprio (só o hash é guardado),
então conhecer o id do pedido, que o celular vê, não basta para pegar a sessão.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from typing import Optional

from sqlalchemy import text

APPROVAL_TTL_SECONDS = 120

PENDING, APPROVED, DENIED, USED, EXPIRED = "PENDING", "APPROVED", "DENIED", "USED", "EXPIRED"


def _uuid(value) -> Optional[str]:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError):
        return None


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def trusted_tokens(db, user_id: int) -> list[str]:
    rows = db.execute(
        text("SELECT token FROM sea_push_tokens WHERE user_id = :u AND secure_lock = TRUE ORDER BY token"),
        {"u": user_id},
    ).fetchall()
    return [r.token for r in rows]


def approval_required(db, user_id: int, device_token: Optional[str]) -> bool:
    enabled = db.execute(
        text("SELECT web_login_approval FROM users WHERE user_id = :u"), {"u": user_id}
    ).scalar()
    if not enabled:
        return False
    tokens = trusted_tokens(db, user_id)
    if not tokens:
        # Sem celular para confirmar: o login segue normal.
        return False
    return not (device_token and device_token in tokens)


def create_challenge(db, user_id: int, client_ip: str, user_agent: str) -> tuple[str, str]:
    secret = secrets.token_urlsafe(32)
    challenge_id = db.execute(
        text(
            """
            INSERT INTO sea_login_challenges (user_id, poll_hash, client_ip, user_agent, expires_at)
            VALUES (:u, :h, :ip, :ua, NOW() + make_interval(secs => :ttl))
            RETURNING challenge_id
            """
        ),
        {"u": user_id, "h": _hash(secret), "ip": (client_ip or "")[:64],
         "ua": (user_agent or "")[:300], "ttl": APPROVAL_TTL_SECONDS},
    ).scalar()
    return str(challenge_id), secret


def _status(row) -> str:
    if row.status == PENDING and row.expired:
        return EXPIRED
    return row.status


def poll(db, challenge_id: str, secret: str):
    """Retorna ``(status, user_id, seconds_left)``, ou None se o id ou o segredo não conferem."""
    challenge_id = _uuid(challenge_id)
    if challenge_id is None:
        return None
    row = db.execute(
        text(
            """
            SELECT user_id, status, poll_hash, expires_at < NOW() AS expired,
                   GREATEST(0, EXTRACT(EPOCH FROM expires_at - NOW()))::int AS seconds_left
            FROM sea_login_challenges WHERE challenge_id = CAST(:id AS uuid)
            """
        ),
        {"id": challenge_id},
    ).fetchone()
    if row is None or not hmac.compare_digest(row.poll_hash, _hash(secret or "")):
        return None
    return _status(row), row.user_id, row.seconds_left


def consume(db, challenge_id: str) -> Optional[int]:
    """Um pedido aprovado abre uma única sessão: depois vira USED."""
    challenge_id = _uuid(challenge_id)
    if challenge_id is None:
        return None
    return db.execute(
        text(
            "UPDATE sea_login_challenges SET status = 'USED' "
            "WHERE challenge_id = CAST(:id AS uuid) AND status = 'APPROVED' RETURNING user_id"
        ),
        {"id": challenge_id},
    ).scalar()


def pending_for_user(db, user_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT challenge_id, client_ip, user_agent, created_at, purpose,
                   GREATEST(0, EXTRACT(EPOCH FROM expires_at - NOW()))::int AS seconds_left
            FROM sea_login_challenges
            WHERE user_id = :u AND status = 'PENDING' AND expires_at > NOW()
            ORDER BY created_at DESC
            """
        ),
        {"u": user_id},
    ).fetchall()
    return [
        {"challenge_id": str(r.challenge_id), "client_ip": r.client_ip, "user_agent": r.user_agent,
         "created_at": r.created_at.isoformat(), "seconds_left": r.seconds_left,
         "purpose": r.purpose}
        for r in rows
    ]


def decide(db, challenge_id: str, user_id: int, approve: bool) -> Optional[str]:
    """Retorna o novo status, EXPIRED se passou do prazo, ou None se não existe esse pedido
    pendente.
    """
    new_status = APPROVED if approve else DENIED
    challenge_id = _uuid(challenge_id)
    if challenge_id is None:
        return None
    row = db.execute(
        text(
            """
            UPDATE sea_login_challenges SET status = :s, decided_at = NOW()
            WHERE challenge_id = CAST(:id AS uuid) AND user_id = :u
              AND status = 'PENDING' AND expires_at > NOW()
            RETURNING status
            """
        ),
        {"s": new_status, "id": challenge_id, "u": user_id},
    ).fetchone()
    if row is not None:
        return row.status
    expired = db.execute(
        text(
            "SELECT 1 FROM sea_login_challenges WHERE challenge_id = CAST(:id AS uuid) "
            "AND user_id = :u AND status = 'PENDING'"
        ),
        {"id": challenge_id, "u": user_id},
    ).fetchone()
    return EXPIRED if expired else None


def describe_client(user_agent: str) -> str:
    ua = (user_agent or "").lower()
    browser = next((name for key, name in (
        ("edg/", "Edge"), ("opr/", "Opera"), ("chrome/", "Chrome"), ("firefox/", "Firefox"),
        ("safari/", "Safari"), ("okhttp", "App SEA"), ("expo", "App SEA"),
    ) if key in ua), "Navegador")
    system = next((name for key, name in (
        ("windows", "Windows"), ("android", "Android"), ("iphone", "iPhone"),
        ("mac os", "Mac"), ("linux", "Linux"),
    ) if key in ua), "")
    return f"{browser} no {system}" if system else browser
