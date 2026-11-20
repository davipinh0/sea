"""O limite global de requisições conta por usuário, não por IP. Na rede da empresa todos saem pelo
mesmo IP; por IP, algumas dezenas de celulares bloqueariam todo mundo.
"""

import pytest
from services.rate_limit import DEFAULT_LIMITS, _rate_limit_key, limiter

from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user

LIMIT = int(DEFAULT_LIMITS[0].split()[0])


@pytest.fixture(autouse=True)
def _reset_limiter_storage():
    try:
        limiter._storage.reset()
    except Exception:
        pass
    yield


def _poll(client, headers):
    return client.get("/api/sea/notificacoes", headers=headers)


class TestSameNetworkManyUsers:
    def test_one_user_using_up_the_limit_does_not_block_the_others(
        self, client, auth_headers, _db_transaction
    ):
        other = _user(client, _db_transaction, "sea.limite.outro", ["retirada"], [WAREHOUSE])
        limiter._storage.reset()

        # Mesmo cliente de teste = mesmo IP para os dois usuários.
        for _ in range(LIMIT):
            assert _poll(client, auth_headers).status_code == 200
        assert _poll(client, auth_headers).status_code == 429
        assert _poll(client, other).status_code == 200


class TestTheKey:
    def test_bearer_token_counts_by_user(self, app, auth_headers):
        with app.test_request_context("/api/sea/notificacoes", headers=auth_headers):
            assert _rate_limit_key().startswith("user:")

    def test_panel_cookie_counts_by_user(self, app, auth_headers):
        token = auth_headers["Authorization"].split()[1]
        with app.test_request_context("/api/sea/notificacoes",
                                      headers={"Cookie": f"sea_auth={token}"}):
            assert _rate_limit_key().startswith("user:")

    def test_a_forged_or_missing_token_counts_by_ip(self, app):
        forged = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.assinatura-falsa"
        for headers in ({"Authorization": f"Bearer {forged}"}, {}):
            with app.test_request_context("/api/sea/notificacoes", headers=headers,
                                          environ_base={"REMOTE_ADDR": "10.0.0.7"}):
                assert _rate_limit_key() == "ip:10.0.0.7"
