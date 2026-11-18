"""SEA: sessions tracked by the server (mig 093).

Regression: the web panel stayed signed in after the browser was closed
(8 h persistent cookie) and "Sair" only deleted the cookie -- a copy of
the token kept working.
"""

from services.auth_service import decode_token, generate_token
from services.web_sessions import WEB_IDLE_MINUTES
from sqlalchemy import text

from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user


def _login(client, conn, username):
    _user(client, conn, username, [], [WAREHOUSE])
    resp = client.post("/api/auth/login", json={"username": username, "password": "Senha123"})
    assert resp.status_code == 200, resp.get_json()
    return resp


def _session_cookie_headers(resp):
    return [
        h for h in resp.headers.getlist("Set-Cookie") if h.startswith(("sea_auth=", "sea_csrf="))
    ]


def _csrf(client):
    return {"X-CSRF-Token": client.get_cookie("sea_csrf").value}


def _age_session(conn, token_jti, minutes):
    conn.execute(
        text(
            "UPDATE sea_sessions SET last_seen_at = NOW() - make_interval(mins => :m) "
            "WHERE jti = :j"
        ),
        {"m": minutes, "j": token_jti},
    )


def _jti(token):
    return decode_token(token)["jti"]


class TestBrowserClose:
    def test_the_panel_cookies_die_with_the_browser(self, client, _db_transaction):
        resp = _login(client, _db_transaction, "sea.sess.cookie")
        cookies = _session_cookie_headers(resp)
        assert len(cookies) == 2
        for header in cookies:
            lowered = header.lower()
            assert "max-age" not in lowered and "expires" not in lowered, header
            assert "httponly" in lowered or header.startswith("sea_csrf=")

    def test_every_login_opens_a_session(self, client, _db_transaction):
        token = _login(client, _db_transaction, "sea.sess.abre").get_json()["token"]
        assert (
            _db_transaction.execute(
                text("SELECT COUNT(*) FROM sea_sessions WHERE jti = :j"), {"j": _jti(token)}
            ).scalar()
            == 1
        )


class TestLogout:
    def test_sair_ends_the_session_even_for_a_copied_token(self, client, _db_transaction):
        token = _login(client, _db_transaction, "sea.sess.sair").get_json()["token"]
        assert client.get("/api/auth/me").status_code == 200

        assert client.post("/api/auth/logout", json={}, headers=_csrf(client)).status_code == 200
        # A copy of the token (as cookie or as header) no longer works.
        client.set_cookie("sea_auth", token, domain="localhost")
        assert client.get("/api/auth/me").status_code == 401
        client.delete_cookie("sea_auth", domain="localhost")
        assert (
            client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code
            == 401
        )

    def test_the_terminal_ends_its_bearer_session(self, client, _db_transaction):
        token = _login(client, _db_transaction, "sea.sess.terminal").get_json()["token"]
        client.delete_cookie("sea_auth", domain="localhost")
        bearer = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/auth/me", headers=bearer).status_code == 200
        assert client.post("/api/auth/logout", json={}, headers=bearer).status_code == 200
        assert client.get("/api/auth/me", headers=bearer).status_code == 401


class TestIdle:
    def test_an_idle_panel_session_is_ended(self, client, _db_transaction):
        token = _login(client, _db_transaction, "sea.sess.ocioso").get_json()["token"]
        _age_session(_db_transaction, _jti(token), WEB_IDLE_MINUTES + 1)

        resp = client.get("/api/auth/me")
        assert resp.status_code == 401
        assert "inatividade" in resp.get_json()["error"]
        # Ended for good: the same token sent as a header does not revive it.
        client.delete_cookie("sea_auth", domain="localhost")
        assert (
            client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code
            == 401
        )

    def test_a_used_panel_session_stays_open(self, client, _db_transaction):
        token = _login(client, _db_transaction, "sea.sess.ativo").get_json()["token"]
        _age_session(_db_transaction, _jti(token), WEB_IDLE_MINUTES - 2)
        assert client.get("/api/auth/me").status_code == 200
        seen = _db_transaction.execute(
            text(
                "SELECT last_seen_at > NOW() - INTERVAL '1 minute' FROM sea_sessions WHERE jti = :j"
            ),
            {"j": _jti(token)},
        ).scalar()
        assert seen is True

    def test_the_app_is_not_logged_out_for_being_idle(self, client, _db_transaction):
        token = _login(client, _db_transaction, "sea.sess.app").get_json()["token"]
        client.delete_cookie("sea_auth", domain="localhost")
        _age_session(_db_transaction, _jti(token), WEB_IDLE_MINUTES + 30)
        assert (
            client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code
            == 200
        )


class TestUnknownSessions:
    def test_a_panel_cookie_without_a_session_is_refused(self, client, _db_transaction):
        _user(client, _db_transaction, "sea.sess.forjado", [], [WAREHOUSE])
        row = _db_transaction.execute(
            text(
                "SELECT user_id, username, role, warehouse_id FROM users "
                "WHERE username = 'sea.sess.forjado'"
            )
        ).fetchone()
        token = generate_token(dict(row._mapping))
        client.set_cookie("sea_auth", token, domain="localhost")
        assert client.get("/api/auth/me").status_code == 401

    def test_refresh_ends_the_previous_session(self, client, _db_transaction):
        old = _login(client, _db_transaction, "sea.sess.renova").get_json()["token"]
        resp = client.post("/api/auth/refresh", json={}, headers=_csrf(client))
        assert resp.status_code == 200
        client.delete_cookie("sea_auth", domain="localhost")
        assert (
            client.get("/api/auth/me", headers={"Authorization": f"Bearer {old}"}).status_code
            == 401
        )
        new = resp.get_json()["token"]
        assert (
            client.get("/api/auth/me", headers={"Authorization": f"Bearer {new}"}).status_code
            == 200
        )
