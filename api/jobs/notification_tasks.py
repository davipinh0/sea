"""SEA: e-mail delivery of operational notifications.

Runs in the Celery worker so the request that produced the event never
waits for the mail server. See services/notification_service.py.
"""

import logging

from jobs import celery_app

logger = logging.getLogger(__name__)


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
