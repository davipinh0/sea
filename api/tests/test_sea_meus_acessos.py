"""Gerenciar Acessos (app): o usuário vê só os próprios locais e celulares."""

from sqlalchemy import text

from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user, second_location  # noqa: F401

URL = "/api/sea/meus-acessos"
TOKEN_A = "ExponentPushToken[acessos-aaa111]"
TOKEN_B = "ExponentPushToken[acessos-bbb222]"


def _uid(conn, username):
    return conn.execute(
        text("SELECT user_id FROM users WHERE username = :u"), {"u": username}
    ).scalar()


def _register(client, headers, token, lock):
    resp = client.post(
        "/api/sea/push/registrar",
        json={"token": token, "secure_lock": lock, "device_name": "SM-A155M"},
        headers=headers,
    )
    assert resp.status_code == 200


def test_user_sees_only_their_own_locations_and_phones(
    client,
    _db_transaction,
    second_location,  # noqa: F811
):
    conn = _db_transaction
    me = _user(client, conn, "sea.acessos.eu", ["retirada"], [WAREHOUSE])
    other = _user(client, conn, "sea.acessos.outro", ["retirada"], [second_location])
    _register(client, me, TOKEN_A, True)
    _register(client, other, TOKEN_B, False)
    conn.execute(
        text("UPDATE users SET web_login_approval = TRUE WHERE username = 'sea.acessos.eu'")
    )

    body = client.get(URL, headers=me).get_json()
    assert body["all_locations"] is False
    codes = [loc["code"] for loc in body["locations"]]
    assert "T-OUTRO" not in codes and len(codes) == 1
    assert body["login_approval"] is True
    assert body["last_login"] and body["since"]
    assert body["devices"] == [
        {
            "device": "SM-A155M",
            "ending": "aaa111",
            "secure_lock": True,
            "signed_in": True,
            "updated_at": body["devices"][0]["updated_at"],
        },
    ]
    # O token inteiro nunca sai.
    assert "ExponentPushToken" not in str(body) and "bbb222" not in str(body)


def test_administrator_sees_every_location(client, auth_headers, second_location):  # noqa: F811
    body = client.get(URL, headers=auth_headers).get_json()
    assert body["all_locations"] is True
    assert "T-OUTRO" in [loc["code"] for loc in body["locations"]]


def test_needs_a_session_and_is_read_only(client, _db_transaction):
    assert client.get(URL).status_code == 401
    me = _user(client, _db_transaction, "sea.acessos.ro", [], [WAREHOUSE])
    for method in (client.post, client.put, client.delete):
        assert method(URL, headers=me, json={"locations": ["T-OUTRO"]}).status_code == 405


# --- Dispositivos conectados

BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36"
APP = "okhttp/4.12.0"
END_URL = "/api/sea/meus-acessos/sessoes/encerrar"


def _login(client, username, agent):
    resp = client.post(
        "/api/auth/login",
        json={"username": username, "password": "Senha123"},
        headers={"User-Agent": agent},
    )
    assert resp.status_code == 200, resp.get_json()
    return {"Authorization": f"Bearer {resp.get_json()['token']}"}


def test_lists_where_the_user_is_signed_in_without_exposing_the_session(
    client, _db_transaction
):
    conn = _db_transaction
    _user(client, conn, "sea.sessoes.eu", [], [WAREHOUSE])
    other = _user(client, conn, "sea.sessoes.outro", [], [WAREHOUSE])
    phone = _login(client, "sea.sessoes.eu", APP)
    browser = _login(client, "sea.sessoes.eu", BROWSER)

    sessions = client.get(URL, headers=browser).get_json()["sessions"]
    devices = sorted((s["device"], s["kind"], s["current"]) for s in sessions)
    assert ("App SEA", "App", False) in devices
    assert ("Chrome no Windows", "Navegador", True) in devices
    assert all(len(s["id"]) == 16 for s in sessions)
    jtis = [str(r.jti) for r in conn.execute(text("SELECT jti FROM sea_sessions")).fetchall()]
    assert not any(j in str(sessions) for j in jtis)
    # O outro usuário não aparece; e cada um vê a própria sessão como a atual.
    assert len(client.get(URL, headers=other).get_json()["sessions"]) == 1
    assert [s["device"] for s in client.get(URL, headers=phone).get_json()["sessions"]
            if s["current"]] == ["App SEA"]


def test_browser_left_idle_is_not_listed(client, _db_transaction):
    conn = _db_transaction
    _user(client, conn, "sea.sessoes.parado", [], [WAREHOUSE])
    _login(client, "sea.sessoes.parado", BROWSER)
    me = _login(client, "sea.sessoes.parado", APP)
    uid = _uid(conn, "sea.sessoes.parado")
    conn.execute(
        text("UPDATE sea_sessions SET last_seen_at = NOW() - INTERVAL '2 hours' "
             "WHERE user_id = :u AND user_agent NOT LIKE 'okhttp%'"), {"u": uid},
    )
    sessions = client.get(URL, headers=me).get_json()["sessions"]
    assert [s["device"] for s in sessions] == ["App SEA"]


def test_disconnecting_a_device_stops_it_right_away_and_is_logged(client, _db_transaction):
    conn = _db_transaction
    _user(client, conn, "sea.sessoes.sair", [], [WAREHOUSE])
    lost = _login(client, "sea.sessoes.sair", APP)
    me = _login(client, "sea.sessoes.sair", BROWSER)
    sessions = client.get(URL, headers=me).get_json()["sessions"]
    target = next(s["id"] for s in sessions if s["device"] == "App SEA")
    current = next(s["id"] for s in sessions if s["current"])

    resp = client.post(END_URL, headers=me, json={"ids": [target, current]})
    assert resp.status_code == 200 and resp.get_json() == {"ended": 1}
    assert client.get(URL, headers=lost).status_code == 401
    # A sessão em uso continua: essa sai por "Sair".
    assert client.get(URL, headers=me).status_code == 200
    log = conn.execute(
        text("SELECT details FROM audit_log WHERE action_type = 'USER_SESSIONS_ENDED' "
             "AND entity_id = :u ORDER BY log_id DESC LIMIT 1"),
        {"u": _uid(conn, "sea.sessoes.sair")},
    ).scalar()
    assert log["sessoes"] == 1 and log["aparelhos"] == ["App SEA"]

    again = client.post(END_URL, headers=me, json={"ids": [target]})
    assert again.status_code == 404 and again.get_json()["user_facing"] is True


def test_cannot_disconnect_someone_else_and_ids_are_checked(client, _db_transaction):
    conn = _db_transaction
    _user(client, conn, "sea.sessoes.a", [], [WAREHOUSE])
    _user(client, conn, "sea.sessoes.b", [], [WAREHOUSE])
    a = _login(client, "sea.sessoes.a", BROWSER)
    b_phone = _login(client, "sea.sessoes.b", APP)
    b_session = next(s["id"] for s in client.get(URL, headers=b_phone).get_json()["sessions"]
                     if s["current"])

    assert client.post(END_URL, headers=a, json={"ids": [b_session]}).status_code == 404
    assert client.get(URL, headers=b_phone).status_code == 200
    for bad in ({"ids": []}, {"ids": ["xyz"]}, {"ids": [b_session], "user_id": 1}, {}):
        assert client.post(END_URL, headers=a, json=bad).status_code == 400
    # Sem sessão: barrado (a proteção CSRF responde antes da autenticação).
    assert client.post(END_URL, json={"ids": [b_session]}).status_code in (401, 403)
