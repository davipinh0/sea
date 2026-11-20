"""Login com senha confirmado no celular cadastrado."""

from sqlalchemy import text

from services import login_approval
from services.notification_service import send_login_approval_push
from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user

PHONE = "ExponentPushToken[telefone-confiavel-1]"
OTHER = "ExponentPushToken[outro-aparelho-22]"
BROWSER = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36"}


def _uid(conn, username):
    return conn.execute(text("SELECT user_id FROM users WHERE username = :u"), {"u": username}).scalar()


def _setup(client, conn, username, *, flag=True, trusted=True):
    _user(client, conn, username, [], [WAREHOUSE])
    uid = _uid(conn, username)
    conn.execute(text("UPDATE users SET web_login_approval = :f WHERE user_id = :u"), {"f": flag, "u": uid})
    if trusted:
        conn.execute(
            text("INSERT INTO sea_push_tokens (token, user_id, secure_lock) VALUES (:t, :u, TRUE)"),
            {"t": PHONE, "u": uid},
        )
    return uid


def _login(client, username, device_token=None):
    body = {"username": username, "password": "Senha123"}
    if device_token:
        body["device_token"] = device_token
    return client.post("/api/auth/login", json=body, headers=BROWSER)


def _phone(client, username):
    """Sessão do celular cadastrado (o login dele não precisa de confirmação)."""
    resp = _login(client, username, PHONE)
    assert resp.status_code == 200, resp.get_json()
    return {"Authorization": f"Bearer {resp.get_json()['token']}"}


def _poll(client, challenge):
    return client.post("/api/auth/login/aprovacao",
                       json={"challenge_id": challenge["challenge_id"], "poll_token": challenge["poll_token"]})


def _decide(client, headers, challenge_id, approve, device=PHONE):
    return client.post(f"/api/sea/login/{challenge_id}/decidir",
                       json={"approve": approve, "device_token": device}, headers=headers)


class TestWhenTheLoginWaits:
    def test_without_the_parameter_the_login_is_immediate(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.off", flag=False)
        resp = _login(client, "sea.conf.off")
        assert resp.status_code == 200 and resp.get_json()["token"]

    def test_without_a_registered_phone_the_login_is_immediate(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.semcel", trusted=False)
        assert _login(client, "sea.conf.semcel").status_code == 200

    def test_a_phone_without_the_app_lock_does_not_count(self, client, _db_transaction):
        uid = _setup(client, _db_transaction, "sea.conf.semtrava", trusted=False)
        _db_transaction.execute(text("INSERT INTO sea_push_tokens (token, user_id) VALUES (:t, :u)"),
                                {"t": PHONE, "u": uid})
        assert _login(client, "sea.conf.semtrava").status_code == 200

    def test_the_registered_phone_logs_in_by_itself(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.cel")
        assert _login(client, "sea.conf.cel", PHONE).status_code == 200

    def test_a_wrong_password_never_creates_a_challenge(self, client, _db_transaction):
        uid = _setup(client, _db_transaction, "sea.conf.errada")
        resp = client.post("/api/auth/login", json={"username": "sea.conf.errada", "password": "x"})
        assert resp.status_code == 401
        assert _db_transaction.execute(text("SELECT COUNT(*) FROM sea_login_challenges WHERE user_id = :u"),
                                       {"u": uid}).scalar() == 0


class TestConfirmation:
    def test_approved_on_the_phone_opens_one_session(self, client, _db_transaction):
        uid = _setup(client, _db_transaction, "sea.conf.ok")
        resp = _login(client, "sea.conf.ok")
        assert resp.status_code == 202
        challenge = resp.get_json()
        assert challenge["approval_required"] and "token" not in challenge
        assert _poll(client, challenge).status_code == 202

        phone = _phone(client, "sea.conf.ok")
        pending = client.get("/api/sea/login/pendentes", headers=phone).get_json()["pending"]
        assert [p["challenge_id"] for p in pending] == [challenge["challenge_id"]]
        assert pending[0]["client"] == "Chrome no Windows"

        assert _decide(client, phone, challenge["challenge_id"], True).get_json()["status"] == "APPROVED"
        done = _poll(client, challenge)
        assert done.status_code == 200
        body = done.get_json()
        assert body["user"]["user_id"] == uid and body["token"]
        assert done.headers.getlist("Set-Cookie")
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
        assert me.status_code == 200
        # Uma aprovação, uma sessão.
        assert _poll(client, challenge).status_code == 410
        actions = _db_transaction.execute(text(
            "SELECT action_type FROM audit_log WHERE entity_id = :u AND action_type LIKE 'LOGIN_%' ORDER BY log_id"),
            {"u": uid}).scalars().all()
        assert actions == ["LOGIN_APPROVAL_REQUESTED", "LOGIN_APPROVED"]

    def test_denied_on_the_phone(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.nega")
        challenge = _login(client, "sea.conf.nega").get_json()
        phone = _phone(client, "sea.conf.nega")
        assert _decide(client, phone, challenge["challenge_id"], False).get_json()["status"] == "DENIED"
        resp = _poll(client, challenge)
        assert resp.status_code == 403 and "negado" in resp.get_json()["error"]
        # Decidido uma vez, o celular não muda de ideia.
        assert _decide(client, phone, challenge["challenge_id"], True).status_code == 404

    def test_the_challenge_id_alone_does_not_open_the_session(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.segredo")
        challenge = _login(client, "sea.conf.segredo").get_json()
        forged = dict(challenge, poll_token="adivinhado")
        assert _poll(client, forged).status_code == 404
        assert _poll(client, dict(challenge, challenge_id="nao-e-uuid")).status_code == 404

    def test_too_late(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.tarde")
        challenge = _login(client, "sea.conf.tarde").get_json()
        _db_transaction.execute(
            text("UPDATE sea_login_challenges SET expires_at = NOW() - INTERVAL '1 second' "
                 "WHERE challenge_id = CAST(:id AS uuid)"), {"id": challenge["challenge_id"]})
        assert _poll(client, challenge).status_code == 410
        phone = _phone(client, "sea.conf.tarde")
        assert client.get("/api/sea/login/pendentes", headers=phone).get_json()["pending"] == []
        assert _decide(client, phone, challenge["challenge_id"], True).status_code == 410

    def test_only_a_registered_phone_of_the_user_decides(self, client, _db_transaction):
        conn = _db_transaction
        _setup(client, conn, "sea.conf.dono")
        challenge = _login(client, "sea.conf.dono").get_json()
        phone = _phone(client, "sea.conf.dono")
        refused = _decide(client, phone, challenge["challenge_id"], True, device=OTHER)
        assert refused.status_code == 403
        _setup(client, conn, "sea.conf.intruso", trusted=False)
        intruder = {"Authorization": "Bearer " + _login(client, "sea.conf.intruso").get_json()["token"]}
        assert _decide(client, intruder, challenge["challenge_id"], True).status_code == 403
        assert _poll(client, challenge).status_code == 202


class TestDevices:
    def test_leaving_the_app_keeps_the_phone_for_confirmations_only(self, client, _db_transaction):
        conn = _db_transaction
        uid = _setup(client, conn, "sea.conf.sair")
        phone = _phone(client, "sea.conf.sair")
        assert client.post("/api/sea/push/remover", json={"token": PHONE}, headers=phone).status_code == 200
        row = conn.execute(text("SELECT secure_lock, signed_in FROM sea_push_tokens WHERE token = :t"),
                           {"t": PHONE}).fetchone()
        assert row.secure_lock is True and row.signed_in is False
        assert login_approval.trusted_tokens(conn, uid) == [PHONE]
        assert _login(client, "sea.conf.sair").status_code == 202

    def test_register_reports_the_app_lock(self, client, _db_transaction):
        conn = _db_transaction
        uid = _setup(client, conn, "sea.conf.reg", trusted=False)
        headers = {"Authorization": "Bearer " + _login(client, "sea.conf.reg").get_json()["token"]}
        client.post("/api/sea/push/registrar", json={"token": OTHER}, headers=headers)
        assert login_approval.trusted_tokens(conn, uid) == []
        client.post("/api/sea/push/registrar", json={"token": OTHER, "secure_lock": True, "device_name": "SM-S711B"},
                    headers=headers)
        assert login_approval.trusted_tokens(conn, uid) == [OTHER]

    def test_administrator_turns_it_on_sees_and_removes_the_phones(self, client, auth_headers, _db_transaction):
        conn = _db_transaction
        uid = _setup(client, conn, "sea.conf.adm", flag=False)
        resp = client.put(f"/api/admin/users/{uid}", json={"web_login_approval": True}, headers=auth_headers)
        assert resp.status_code == 200 and resp.get_json()["web_login_approval"] is True
        listed = client.get("/api/admin/users?per_page=1000", headers=auth_headers).get_json()["users"]
        mine = next(u for u in listed if u["user_id"] == uid)
        assert mine["web_login_approval"] is True and mine["trusted_devices"] == 1

        devices = client.get(f"/api/admin/users/{uid}/aparelhos", headers=auth_headers).get_json()["devices"]
        assert len(devices) == 1 and devices[0]["secure_lock"] is True
        assert "telefone" not in str(devices)
        assert _login(client, "sea.conf.adm").status_code == 202

        # Celular perdido: removendo os celulares, o usuário volta a entrar só com a senha.
        assert client.delete(f"/api/admin/users/{uid}/aparelhos", headers=auth_headers).get_json()["removed"] == 1
        assert _login(client, "sea.conf.adm").status_code == 200

    def test_a_user_without_the_users_page_cannot_see_the_phones(self, client, _db_transaction):
        uid = _setup(client, _db_transaction, "sea.conf.alvo")
        headers = _user(client, _db_transaction, "sea.conf.curioso", [], [WAREHOUSE])
        assert client.get(f"/api/admin/users/{uid}/aparelhos", headers=headers).status_code == 403
        assert client.delete(f"/api/admin/users/{uid}/aparelhos", headers=headers).status_code == 403


class TestPush:
    def test_push_goes_to_the_registered_phones_with_the_challenge(self, _db_transaction, client, monkeypatch):
        uid = _setup(client, _db_transaction, "sea.conf.push")
        sent = []
        monkeypatch.setenv("SEA_PUSH", "expo")
        assert send_login_approval_push(_db_transaction, uid, "abc", "Chrome no Windows", sender=sent.extend) == 1
        assert sent[0]["to"] == PHONE
        assert sent[0]["data"] == {"kind": "login_approval", "challenge_id": "abc"}
        assert "Chrome no Windows" in sent[0]["body"]

    def test_push_off_sends_nothing(self, _db_transaction, client, monkeypatch):
        uid = _setup(client, _db_transaction, "sea.conf.semPush")
        monkeypatch.delenv("SEA_PUSH", raising=False)
        assert send_login_approval_push(_db_transaction, uid, "abc", "x", sender=lambda m: 1 / 0) == 0

    def test_describe_client(self):
        assert login_approval.describe_client("Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537") == "Chrome no Windows"
        assert login_approval.describe_client("Mozilla/5.0 (Windows NT 10.0) Chrome/131 Edg/131") == "Edge no Windows"
        assert login_approval.describe_client("okhttp/4.12.0") == "App SEA"
        assert login_approval.describe_client("") == "Navegador"


class TestLockedAppUnlockingWithThePassword:
    """Regressão: "Desbloquear com a senha" no celular cadastrado não mandava o token do aparelho,
    recebia 202 e o app saía.
    """

    def _unlock(self, client, username, headers):
        return client.post("/api/auth/login", json={"username": username, "password": "Senha123"},
                           headers=headers)

    def test_the_open_app_session_unlocks_without_confirmation(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.desbloq")
        phone = _phone(client, "sea.conf.desbloq")
        resp = self._unlock(client, "sea.conf.desbloq", phone)
        assert resp.status_code == 200 and resp.get_json()["token"]

    def test_a_session_of_another_user_does_not_count(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.alvo")
        _setup(client, _db_transaction, "sea.conf.intruso", flag=False, trusted=False)
        other = _login(client, "sea.conf.intruso").get_json()["token"]
        resp = self._unlock(client, "sea.conf.alvo", {"Authorization": f"Bearer {other}"})
        assert resp.status_code == 202

    def test_an_ended_session_does_not_count(self, client, _db_transaction):
        _setup(client, _db_transaction, "sea.conf.encerrada")
        phone = _phone(client, "sea.conf.encerrada")
        assert client.post("/api/auth/logout", json={}, headers=phone).status_code == 200
        assert self._unlock(client, "sea.conf.encerrada", phone).status_code == 202

    def test_the_audit_says_whether_the_app_sent_its_device(self, client, _db_transaction):
        uid = _setup(client, _db_transaction, "sea.conf.audit")
        _login(client, "sea.conf.audit", OTHER)
        details = _db_transaction.execute(
            text("SELECT details FROM audit_log WHERE action_type = 'LOGIN_APPROVAL_REQUESTED' "
                 "AND entity_id = :u ORDER BY log_id DESC LIMIT 1"),
            {"u": uid},
        ).scalar()
        assert details["aparelho_informado"] is True
