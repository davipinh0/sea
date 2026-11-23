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
