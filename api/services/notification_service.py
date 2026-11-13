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
    return notification_id


def dispatch(db) -> None:
    """Queue the e-mails of the notifications created on ``db``.

    Call after the commit. A broker outage must not fail an operation
    that is already committed: the notification stays PENDENTE (visible
    in the panel) and the failure is logged.
    """
    pending = db.info.pop(_SESSION_KEY, [])
    if not pending:
        return
    from kombu.exceptions import OperationalError

    from jobs.notification_tasks import send_notification_email

    for notification_id in pending:
        try:
            send_notification_email.delay(notification_id)
        except OperationalError:
            logger.exception("fila de e-mail indisponível; notificação %s segue PENDENTE",
                             notification_id)


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
