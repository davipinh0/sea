"""Envio por e-mail das notificações do SEA. Roda no worker Celery para a operação nunca esperar o
servidor de e-mail.
"""

import logging

from jobs import celery_app

logger = logging.getLogger(__name__)


@celery_app.task
def send_notification_push(notification_id: int) -> dict:
    import models.database as db
    from services import notification_service

    session = db.SessionLocal()
    try:
        devices = notification_service.send_push(session, notification_id)
        logger.info("notificação %s: enviada a %s aparelho(s)", notification_id, devices)
        return {"notification_id": notification_id, "devices": devices}
    finally:
        session.close()


@celery_app.task
def send_notification_email(notification_id: int) -> dict:
    import models.database as db
    from services import notification_service

    session = db.SessionLocal()
    try:
        status = notification_service.send_email(session, notification_id)
        session.commit()
        logger.info("notificação %s: e-mail %s", notification_id, status)
        return {"notification_id": notification_id, "email_status": status}
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
