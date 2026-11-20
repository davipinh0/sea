"""Processos do painel liberados pelo celular.
No painel (sessão por cookie), Recebimento, Armazenagem e Retirada só funcionam depois da
confirmação no celular cadastrado. O pedido usa a mesma fila da confirmação de login, com
``purpose`` e a sessão que pediu. Aprovado, a sessão fica liberada naquele processo até passar
WINDOW_MINUTES sem uso.
O app e o terminal (token Bearer) não passam por aqui: o app pede a digital/PIN antes de cada
processo.
"""

from __future__ import annotations

import secrets

from sqlalchemy import text

from services import login_approval

PURPOSES = {
    "recebimento": "Recebimento",
    "armazenagem": "Armazenagem",
    "retirada": "Retirada",
    "exclusao-usuario": "Exclusão de usuário",
}
# Liberação que vale para uma única ação: depois de usada, é preciso confirmar de novo.
SINGLE_USE = {"exclusao-usuario"}
WINDOW_MINUTES = 15


def label(purpose: str) -> str:
    return PURPOSES.get(purpose, purpose)


def seconds_left(db, jti, purpose: str) -> int:
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
    """Cada uso reinicia a janela. Quem chama faz o commit."""
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


def revoke(db, jti, purpose: str) -> None:
    """Encerra a liberação. Quem chama faz o commit."""
    if not jti or not login_approval._uuid(jti):
        return
    db.execute(
        text("DELETE FROM sea_step_up WHERE jti = CAST(:j AS uuid) AND purpose = :p"),
        {"j": str(jti), "p": purpose},
    )


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
    """Retorna o id do pedido, ou None se o usuário não tem celular cadastrado. Quem chama faz o
    commit.
    """
    if not login_approval.trusted_tokens(db, user_id):
        return None
    # Ninguém acompanha este pedido com segredo: o painel acompanha pela própria sessão. O hash só
    # preenche a coluna.
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
    """Depois da aprovação, libera a sessão que pediu. Retorna o processo, ou None se era um login.
    Quem chama faz o commit.
    """
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
