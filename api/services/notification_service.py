"""Notificações do SEA (painel, e-mail e celular).
``create`` grava a notificação dentro da transação de quem chama: se a operação for desfeita, a
notificação também é. Depois do commit, ``dispatch`` entrega o e-mail ao worker; a requisição
nunca espera o servidor de e-mail.
Destinatários do e-mail: administradores ativos com e-mail. Servidor de e-mail pelo ambiente:
SEA_SMTP_HOST (sem ele, não envia), SEA_SMTP_PORT (587), SEA_SMTP_USER, SEA_SMTP_PASSWORD,
SEA_SMTP_FROM e SEA_SMTP_SECURITY (starttls, ssl ou none).
"""

from __future__ import annotations

import logging
import os
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Callable, Optional

from sqlalchemy import text

logger = logging.getLogger(__name__)

KIND_WITHDRAWAL_REQUESTED = "RETIRADA_SOLICITADA"
KIND_WITHDRAWAL_APPROVED = "RETIRADA_APROVADA"
# Quem pediu cancelou uma retirada já aceita: só quem aceitou é avisado.
KIND_WITHDRAWAL_CANCELLED = "RETIRADA_CANCELADA"
KIND_RECEIPT = "RECEBIMENTO"
KIND_STORAGE_DONE = "ARMAZENAGEM_CONCLUIDA"

SUBJECTS = {
    KIND_WITHDRAWAL_REQUESTED: "SEA - Solicitação de Retirada",
    KIND_WITHDRAWAL_APPROVED: "SEA - Retirada Aprovada",
    KIND_WITHDRAWAL_CANCELLED: "SEA - Retirada Cancelada",
    KIND_RECEIPT: "SEA - Recebimento de Materiais",
    KIND_STORAGE_DONE: "SEA - Conclusão de Armazenamento",
}

# Quem é avisado em cada etapa da retirada (além dos administradores). Os demais tipos vão para
# todos do local.
AUDIENCE = {
    KIND_WITHDRAWAL_REQUESTED: "retirada-avaliar",
    KIND_WITHDRAWAL_APPROVED: "retirada-fazer",
    KIND_WITHDRAWAL_CANCELLED: "retirada-fazer",
}

EMAIL_PENDING = "PENDENTE"
EMAIL_SENT = "ENVIADO"
EMAIL_NO_RECIPIENT = "SEM_DESTINATARIO"
EMAIL_NOT_CONFIGURED = "NAO_CONFIGURADO"
EMAIL_FAILED = "FALHA"

_PUSH_KEY = "sea_pending_pushes"
_SESSION_KEY = "sea_pending_notifications"
_SMTP_TIMEOUT_S = 15


@dataclass(frozen=True)
class SmtpConfig:
    host: str
    port: int
    user: Optional[str]
    password: Optional[str]
    sender: str
    security: str


def smtp_config() -> Optional[SmtpConfig]:
    host = (os.environ.get("SEA_SMTP_HOST") or "").strip()
    if not host:
        return None
    user = (os.environ.get("SEA_SMTP_USER") or "").strip() or None
    sender = (os.environ.get("SEA_SMTP_FROM") or "").strip() or user
    if not sender:
        raise RuntimeError("SEA_SMTP_FROM (ou SEA_SMTP_USER) é obrigatório quando SEA_SMTP_HOST está definido")
    security = (os.environ.get("SEA_SMTP_SECURITY") or "starttls").strip().lower()
    if security not in ("starttls", "ssl", "none"):
        raise RuntimeError("SEA_SMTP_SECURITY deve ser starttls, ssl ou none")
    return SmtpConfig(
        host=host,
        port=int(os.environ.get("SEA_SMTP_PORT") or 587),
        user=user,
        password=os.environ.get("SEA_SMTP_PASSWORD") or None,
        sender=sender,
        security=security,
    )


def create(db, *, kind: str, warehouse_id: int, title: str, message: str,
           ot: Optional[str] = None, username: Optional[str] = None,
           withdrawal_id: Optional[int] = None) -> int:
    if kind not in SUBJECTS:
        raise ValueError(f"unknown notification kind: {kind}")
    status = EMAIL_PENDING if smtp_config() else EMAIL_NOT_CONFIGURED
    notification_id = db.execute(
        text(
            """
            INSERT INTO sea_notifications (warehouse_id, kind, title, message, ot, created_by,
                                           email_status, withdrawal_id)
            VALUES (:wid, :kind, :title, :message, :ot, :user, :status, :withdrawal)
            RETURNING notification_id
            """
        ),
        {"wid": warehouse_id, "kind": kind, "title": title[:200], "message": message[:1000],
         "ot": ot, "user": username, "status": status, "withdrawal": withdrawal_id},
    ).scalar()
    if status == EMAIL_PENDING:
        db.info.setdefault(_SESSION_KEY, []).append(notification_id)
    if push_enabled():
        db.info.setdefault(_PUSH_KEY, []).append(notification_id)
    return notification_id


def dispatch(db) -> None:
    """Chamar depois do commit. Fila fora do ar não pode derrubar uma operação já gravada: a
    notificação fica PENDENTE e o erro vai para o log.
    """
    pending = db.info.pop(_SESSION_KEY, [])
    pushes = db.info.pop(_PUSH_KEY, [])
    if not pending and not pushes:
        return
    from kombu.exceptions import OperationalError

    from jobs.notification_tasks import send_notification_email, send_notification_push

    for notification_id in pending:
        try:
            send_notification_email.delay(notification_id)
        except OperationalError:
            logger.exception("fila de e-mail indisponível; notificação %s segue PENDENTE",
                             notification_id)
    for notification_id in pushes:
        try:
            send_notification_push.delay(notification_id)
        except OperationalError:
            logger.exception("fila indisponível; notificação %s sem aviso no celular",
                             notification_id)


# --- Celular
# Com o app fechado, os avisos passam pelo push do Expo (que entrega ao Google), o que manda título
# e texto para um serviço de fora. Por isso só ficam ligados com SEA_PUSH=expo. Com o app aberto, o
# próprio app consulta a API.

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def push_enabled() -> bool:
    return os.environ.get("SEA_PUSH", "").strip().lower() == "expo"


def push_tokens(db, warehouse_id: int, page_key: str | None = None) -> list[str]:
    """Celulares dos usuários ativos do local (administradores estão em todos). Com ``page_key``, só
    de quem tem essa permissão.
    """
    rows = db.execute(
        text(
            """
            SELECT t.token FROM sea_push_tokens t JOIN users u ON u.user_id = t.user_id
            WHERE u.is_active = TRUE AND t.signed_in = TRUE
              AND (u.role = 'ADMIN' OR (:wid = ANY(u.warehouse_ids)
                   AND (CAST(:page AS VARCHAR) IS NULL OR EXISTS (
                        SELECT 1 FROM user_page_permissions pp
                        WHERE pp.user_id = u.user_id AND pp.page_key = :page))))
            ORDER BY t.token
            """
        ),
        {"wid": warehouse_id, "page": page_key},
    ).fetchall()
    return [r.token for r in rows]


def user_push_tokens(db, username: str) -> list[str]:
    rows = db.execute(
        text(
            """
            SELECT t.token FROM sea_push_tokens t JOIN users u ON u.user_id = t.user_id
            WHERE u.username = :u AND u.is_active = TRUE AND t.signed_in = TRUE
            ORDER BY t.token
            """
        ),
        {"u": username},
    ).fetchall()
    return [r.token for r in rows]


def _expo_send(messages: list[dict]) -> None:
    import requests

    resp = requests.post(EXPO_PUSH_URL, json=messages, timeout=10,
                         headers={"Accept": "application/json"})
    resp.raise_for_status()


def send_push(db, notification_id: int, sender=_expo_send) -> int:
    row = db.execute(
        text(
            """
            SELECT n.warehouse_id, n.kind, n.title, n.message, wd.picked_by
            FROM sea_notifications n
            LEFT JOIN withdrawals wd ON wd.withdrawal_id = n.withdrawal_id
            WHERE n.notification_id = :id
            """
        ),
        {"id": notification_id},
    ).fetchone()
    if row is None or not push_enabled():
        return 0
    if row.picked_by:
        # Depois do aceite, só quem aceitou acompanha a retirada.
        tokens = (user_push_tokens(db, row.picked_by)
                  if row.kind == KIND_WITHDRAWAL_CANCELLED else [])
    else:
        tokens = push_tokens(db, row.warehouse_id, AUDIENCE.get(row.kind))
    if not tokens:
        return 0
    sender([
        {"to": token, "title": row.title, "body": row.message, "sound": "default",
         "channelId": "sea-avisos", "data": {"kind": row.kind, "notification_id": notification_id}}
        for token in tokens
    ])
    return len(tokens)


def send_login_approval_push(db, user_id: int, challenge_id: str, client: str,
                             sender=_expo_send, title: str | None = None,
                             body: str | None = None) -> int:
    """Vai até para um celular cujo usuário saiu do app: ele entra de novo e confirma. Falha no push
    não impede o login; o app também encontra o pedido sozinho.
    """
    if not push_enabled():
        return 0
    from services.login_approval import trusted_tokens

    tokens = trusted_tokens(db, user_id)
    if not tokens:
        return 0
    messages = [
        {"to": token, "title": title or "Tentativa de login no SEA",
         "body": body or f"{client} quer entrar na sua conta. Toque para confirmar ou negar.",
         "sound": "default", "priority": "high", "channelId": "sea-avisos",
         "data": {"kind": "login_approval", "challenge_id": challenge_id}}
        for token in tokens
    ]
    import requests

    try:
        sender(messages)
    except requests.RequestException as exc:
        logger.warning("push de confirmação de login não enviado: %s", type(exc).__name__)
        return 0
    return len(tokens)


def admin_recipients(db) -> list[str]:
    rows = db.execute(
        text(
            """
            SELECT email FROM users
            WHERE role = 'ADMIN' AND is_active = TRUE AND email IS NOT NULL
            ORDER BY user_id
            """
        )
    ).fetchall()
    return [r.email for r in rows]


def _smtp_send(config: SmtpConfig, message: EmailMessage) -> None:
    factory = smtplib.SMTP_SSL if config.security == "ssl" else smtplib.SMTP
    with factory(config.host, config.port, timeout=_SMTP_TIMEOUT_S) as server:
        if config.security == "starttls":
            server.starttls()
        if config.user:
            server.login(config.user, config.password or "")
        server.send_message(message)


def send_email(db, notification_id: int,
               mailer: Callable[[SmtpConfig, EmailMessage], None] = _smtp_send) -> str:
    """Só uma notificação PENDENTE é enviada, então uma tarefa repetida nunca manda o e-mail duas
    vezes.
    """
    row = db.execute(
        text(
            """
            SELECT n.notification_id, n.kind, n.title, n.message, n.created_by, n.created_at,
                   n.email_status, w.warehouse_code, w.warehouse_name
            FROM sea_notifications n JOIN warehouses w ON w.warehouse_id = n.warehouse_id
            WHERE n.notification_id = :id FOR UPDATE OF n
            """
        ),
        {"id": notification_id},
    ).fetchone()
    if row is None or row.email_status != EMAIL_PENDING:
        return row.email_status if row else EMAIL_FAILED

    config = smtp_config()
    recipients = admin_recipients(db)
    error = None
    if config is None:
        status = EMAIL_NOT_CONFIGURED
    elif not recipients:
        status = EMAIL_NO_RECIPIENT
    else:
        message = EmailMessage()
        message["Subject"] = SUBJECTS[row.kind]
        message["From"] = config.sender
        message["To"] = ", ".join(recipients)
        message.set_content(
            f"{row.title}\n\n{row.message}\n\n"
            f"Local: {row.warehouse_code} - {row.warehouse_name}\n"
            f"Responsável: {row.created_by or '-'}\n"
            f"Data/hora: {row.created_at:%d/%m/%Y %H:%M} (UTC)\n\n"
            "Mensagem automática do SEA - Sistema de Entrada e Armazenamento."
        )
        try:
            mailer(config, message)
            status = EMAIL_SENT
        except (smtplib.SMTPException, OSError) as exc:
            status = EMAIL_FAILED
            error = f"{type(exc).__name__}: {exc}"[:500]
            logger.error("falha ao enviar e-mail da notificação %s: %s", notification_id, error)

    db.execute(
        text(
            """
            UPDATE sea_notifications
            SET email_status = :s, email_error = :e,
                email_sent_at = CASE WHEN :s = 'ENVIADO' THEN NOW() END
            WHERE notification_id = :id
            """
        ),
        {"s": status, "e": error, "id": notification_id},
    )
    return status
