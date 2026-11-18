"""SEA operational notifications (panel + e-mail).

Three events are announced, each with its own e-mail:

    RETIRADA_SOLICITADA    a withdrawal was requested at the terminal
    RECEBIMENTO            materials of an order were received
    ARMAZENAGEM_CONCLUIDA  every received unit of an order left the
                           receiving area

``create`` writes one ``sea_notifications`` row inside the caller's
transaction, so a rolled-back operation leaves no notification. The
panel polls that table. After the commit the route calls ``dispatch``,
which hands the e-mail to the Celery worker; the request never waits
for the mail server.

Recipients are the active administrators with an e-mail on their user.
The mail server comes from the environment (nothing is assumed):

    SEA_SMTP_HOST      required to send; unset = e-mails are not sent
    SEA_SMTP_PORT      default 587
    SEA_SMTP_USER      optional (no login when unset)
    SEA_SMTP_PASSWORD  optional
    SEA_SMTP_FROM      sender address (default: SEA_SMTP_USER)
    SEA_SMTP_SECURITY  starttls (default) | ssl | none
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
KIND_RECEIPT = "RECEBIMENTO"
KIND_STORAGE_DONE = "ARMAZENAGEM_CONCLUIDA"

SUBJECTS = {
    KIND_WITHDRAWAL_REQUESTED: "SEA - Solicitação de Retirada",
    KIND_RECEIPT: "SEA - Recebimento de Materiais na Expedição",
    KIND_STORAGE_DONE: "SEA - Conclusão de Armazenamento",
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
    """Mail server settings, or None when e-mail is not configured."""
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
           ot: Optional[str] = None, username: Optional[str] = None) -> int:
    """Record a notification in the caller's transaction."""
    if kind not in SUBJECTS:
        raise ValueError(f"unknown notification kind: {kind}")
    status = EMAIL_PENDING if smtp_config() else EMAIL_NOT_CONFIGURED
    notification_id = db.execute(
        text(
            """
            INSERT INTO sea_notifications (warehouse_id, kind, title, message, ot, created_by,
                                           email_status)
            VALUES (:wid, :kind, :title, :message, :ot, :user, :status)
            RETURNING notification_id
            """
        ),
        {"wid": warehouse_id, "kind": kind, "title": title[:200], "message": message[:1000],
         "ot": ot, "user": username, "status": status},
    ).scalar()
    if status == EMAIL_PENDING:
        db.info.setdefault(_SESSION_KEY, []).append(notification_id)
    if push_enabled():
        db.info.setdefault(_PUSH_KEY, []).append(notification_id)
    return notification_id


def dispatch(db) -> None:
    """Queue the e-mails of the notifications created on ``db``.

    Call after the commit. A broker outage must not fail an operation
    that is already committed: the notification stays PENDENTE (visible
    in the panel) and the failure is logged.
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


# ------------------------------------------------------------ Celular
#
# Notifications on the phone while the app is closed go through the Expo
# push service (which hands them to Google). That sends the title and the
# text of the notification to an outside service, so it is off unless
# SEA_PUSH=expo is set. With the app open, the app itself polls the API.

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def push_enabled() -> bool:
    return os.environ.get("SEA_PUSH", "").strip().lower() == "expo"


def push_tokens(db, warehouse_id: int) -> list[str]:
    """Devices of the active users who work in the location of the event
    (administrators work in all of them)."""
    rows = db.execute(
        text(
            """
            SELECT t.token FROM sea_push_tokens t JOIN users u ON u.user_id = t.user_id
            WHERE u.is_active = TRUE AND t.signed_in = TRUE
              AND (u.role = 'ADMIN' OR :wid = ANY(u.warehouse_ids))
            ORDER BY t.token
            """
        ),
        {"wid": warehouse_id},
    ).fetchall()
    return [r.token for r in rows]


def _expo_send(messages: list[dict]) -> None:
    import requests

    resp = requests.post(EXPO_PUSH_URL, json=messages, timeout=10,
                         headers={"Accept": "application/json"})
    resp.raise_for_status()


def send_push(db, notification_id: int, sender=_expo_send) -> int:
    """Send one notification to the phones. Returns how many devices."""
    row = db.execute(
        text("SELECT warehouse_id, kind, title, message FROM sea_notifications "
             "WHERE notification_id = :id"),
        {"id": notification_id},
    ).fetchone()
    if row is None or not push_enabled():
        return 0
    tokens = push_tokens(db, row.warehouse_id)
    if not tokens:
        return 0
    sender([
        {"to": token, "title": row.title, "body": row.message, "sound": "default",
         "channelId": "sea-avisos", "data": {"kind": row.kind, "notification_id": notification_id}}
        for token in tokens
    ])
    return len(tokens)


def send_login_approval_push(db, user_id: int, challenge_id: str, client: str,
                             sender=_expo_send) -> int:
    """Push to the user's registered phones: a login waits for confirmation.

    Sent even to a phone whose user left the app (signed_in = FALSE): the
    user logs in again in the app and then confirms. A push failure does
    not stop the login: the app also finds the pending login by itself.
    """
    if not push_enabled():
        return 0
    from services.login_approval import trusted_tokens

    tokens = trusted_tokens(db, user_id)
    if not tokens:
        return 0
    messages = [
        {"to": token, "title": "Tentativa de login no SEA",
         "body": f"{client} quer entrar na sua conta. Toque para confirmar ou negar.",
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
    """Send the e-mail of one notification and record the outcome.

    Returns the resulting ``email_status``. Only a PENDENTE notification
    is sent, so a retried task never mails twice.
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
            "Mensagem automática do SEA - Sistema de Expedição e Armazenamento."
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
