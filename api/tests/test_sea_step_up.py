"""SEA: processes of the web panel released by the phone (mig 095).

In the web panel (cookie session), Recebimento, Armazenagem and Retirada
only work after the registered phone confirms; the release lasts while
the process is used (15 minutes without use end it). The app and the
terminal (Bearer) are not gated by the API.
"""

from services.step_up import WINDOW_MINUTES
from sqlalchemy import text

from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user

PHONE = "ExponentPushToken[celular-do-processo]"
PAGES = ["receiving", "putaway", "retirada", "retirada-fazer"]


def _setup(client, conn, username, *, phone=True):
    _user(client, conn, username, PAGES, [WAREHOUSE])
    uid = conn.execute(
        text("SELECT user_id FROM users WHERE username = :u"), {"u": username}
    ).scalar()
    if phone:
        conn.execute(
            text("INSERT INTO sea_push_tokens (token, user_id, secure_lock) VALUES (:t, :u, TRUE)"),
            {"t": PHONE, "u": uid},
        )
    return uid


def _web_login(client, username):
    """Panel session: cookies kept by the test client."""
    resp = client.post("/api/auth/login", json={"username": username, "password": "Senha123"})
    assert resp.status_code == 200, resp.get_json()
    return {"X-CSRF-Token": client.get_cookie("sea_csrf").value}


def _phone(client, username):
    token = client.post(
        "/api/auth/login",
        json={"username": username, "password": "Senha123", "device_token": PHONE},
    ).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _putaway(client, headers):
    return client.post("/api/putaway/confirm", json={}, headers=headers)


def _gated(resp):
    return resp.status_code == 403 and (resp.get_json() or {}).get("step_up_required")


class TestTheGate:
    def test_the_web_panel_needs_the_phone(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.web")
        csrf = _web_login(client, "sea.step.web")
        assert _gated(_putaway(client, csrf))
        assert _gated(client.post("/api/receiving/receive", json={}, headers=csrf))
        assert _gated(client.post("/api/sea/retiradas/1/separar", json={}, headers=csrf))
        state = client.get("/api/sea/confirmacao/armazenagem").get_json()
        assert state == {"required": True, "granted": False, "seconds_left": 0, "has_phone": True}

    def test_the_app_is_not_gated_by_the_api(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.app")
        phone = _phone(client, "sea.step.app")
        client.delete_cookie("sea_auth", domain="localhost")
        assert not _gated(_putaway(client, phone))
        assert (
            client.get("/api/sea/confirmacao/armazenagem", headers=phone).get_json()["required"]
            is False
        )

    def test_without_a_registered_phone_the_process_is_blocked(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.semcel", phone=False)
        csrf = _web_login(client, "sea.step.semcel")
        resp = client.post("/api/sea/confirmacao/recebimento", json={}, headers=csrf)
        assert resp.status_code == 409
        assert "cadastre o app SEA" in resp.get_json()["error"]

    def test_an_unknown_process_is_refused(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.outro")
        _web_login(client, "sea.step.outro")
        assert client.get("/api/sea/confirmacao/estoque").status_code == 404


class TestReleasingOnThePhone:
    def _ask(self, client, username):
        csrf = _web_login(client, username)
        resp = client.post("/api/sea/confirmacao/armazenagem", json={}, headers=csrf)
        assert resp.status_code == 202, resp.get_json()
        return csrf, resp.get_json()["challenge_id"]

    def _decide(self, client, phone, challenge_id, approve):
        return client.post(
            f"/api/sea/login/{challenge_id}/decidir",
            json={"approve": approve, "device_token": PHONE},
            headers=phone,
        )

    def test_approved_on_the_phone_the_session_is_released(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.ok")
        phone = _phone(client, "sea.step.ok")
        csrf, challenge = self._ask(client, "sea.step.ok")

        pending = client.get("/api/sea/login/pendentes", headers=phone).get_json()["pending"]
        assert [p["purpose"] for p in pending] == ["armazenagem"]
        follow = f"/api/sea/confirmacao/armazenagem/{challenge}"
        assert client.get(follow).status_code == 202

        assert self._decide(client, phone, challenge, True).status_code == 200
        resp = client.get(follow)
        assert resp.status_code == 200 and resp.get_json()["granted"] is True
        # Released: the request reaches the route (which refuses the empty body).
        assert not _gated(_putaway(client, csrf))
        # Only this process.
        assert _gated(client.post("/api/receiving/receive", json={}, headers=csrf))

    def test_denied_on_the_phone_the_session_stays_blocked(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.nega")
        phone = _phone(client, "sea.step.nega")
        csrf, challenge = self._ask(client, "sea.step.nega")
        assert self._decide(client, phone, challenge, False).status_code == 200
        assert client.get(f"/api/sea/confirmacao/armazenagem/{challenge}").status_code == 403
        assert _gated(_putaway(client, csrf))

    def test_the_release_belongs_to_the_session_that_asked(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.sessao")
        phone = _phone(client, "sea.step.sessao")
        _, challenge = self._ask(client, "sea.step.sessao")
        self._decide(client, phone, challenge, True)
        csrf = _web_login(client, "sea.step.sessao")  # a new panel session
        assert _gated(_putaway(client, csrf))
        assert client.get(f"/api/sea/confirmacao/armazenagem/{challenge}").status_code == 404

    def test_it_ends_after_the_window_without_use(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.step.janela")
        phone = _phone(client, "sea.step.janela")
        csrf, challenge = self._ask(client, "sea.step.janela")
        self._decide(client, phone, challenge, True)
        _db_transaction.execute(
            text("UPDATE sea_step_up SET last_used_at = NOW() - make_interval(mins => :m)"),
            {"m": WINDOW_MINUTES + 1},
        )
        assert _gated(_putaway(client, csrf))

    def test_the_phone_audits_the_release(self, client, _db_transaction):
        uid = _setup(client, _db_transaction, "sea.step.audit")
        phone = _phone(client, "sea.step.audit")
        _, challenge = self._ask(client, "sea.step.audit")
        self._decide(client, phone, challenge, True)
        actions = (
            _db_transaction.execute(
                text(
                    "SELECT action_type FROM audit_log "
                    "WHERE entity_type = 'USER' AND entity_id = :u "
                    "ORDER BY log_id"
                ),
                {"u": uid},
            )
            .scalars()
            .all()
        )
        assert actions[-2:] == ["PROCESS_APPROVAL_REQUESTED", "PROCESS_APPROVED"]
