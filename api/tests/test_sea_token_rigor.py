"""Tokens adulterados nunca abrem sessão (QA).
Regressão: o PyJWT 2.13.0 aceitava uma assinatura com caracteres fora do Base64URL colados no fim
(PYSEC-2026-4147); atualizado para 2.15.0.
"""

import base64
import json
import time

import jwt
import pytest
from services.auth_service import JWT_SECRET

from tests.test_sea import WAREHOUSE
from tests.test_sea_acesso import _user


def _b64(data):
    return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()


def _me(client, token):
    return client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})


@pytest.fixture()
def token(client, _db_transaction):
    headers = _user(client, _db_transaction, "sea.token.1", ["retirada"], [WAREHOUSE])
    return headers["Authorization"].split()[1]


class TestTamperedTokens:
    def test_the_real_token_works(self, client, token):
        assert _me(client, token).status_code == 200

    @pytest.mark.parametrize("suffix", ["!!!!", "%%", "==", " ", "\t"])
    def test_garbage_after_the_signature(self, client, token, suffix):
        assert _me(client, token + suffix).status_code == 401

    def test_alg_none(self, client, token):
        payload = jwt.decode(token, options={"verify_signature": False})
        forged = _b64({"alg": "none", "typ": "JWT"}) + "." + _b64(payload) + "."
        assert _me(client, forged).status_code == 401

    def test_signed_with_another_secret(self, client, token):
        payload = jwt.decode(token, options={"verify_signature": False})
        forged = jwt.encode(payload, "outra-chave-qualquer-com-32-bytes!!", algorithm="HS256")
        assert _me(client, forged).status_code == 401

    def test_admin_role_injected_in_the_payload(self, client, token):
        header, payload, signature = token.split(".")
        body = json.loads(base64.urlsafe_b64decode(payload + "=="))
        body["role"] = "ADMIN"
        assert _me(client, f"{header}.{_b64(body)}.{signature}").status_code == 401

    def test_expired(self, client, token):
        payload = jwt.decode(token, options={"verify_signature": False})
        payload["exp"] = int(time.time()) - 60
        assert _me(client, jwt.encode(payload, JWT_SECRET, algorithm="HS256")).status_code == 401

    def test_valid_signature_for_a_user_that_does_not_exist(self, client, token):
        payload = jwt.decode(token, options={"verify_signature": False})
        payload.update({"user_id": 999999, "username": "fantasma"})
        assert _me(client, jwt.encode(payload, JWT_SECRET, algorithm="HS256")).status_code == 401

    @pytest.mark.parametrize("bad", ["", "abc", "a.b", "a.b.c.d", "....", "x" * 5000])
    def test_malformed_never_500(self, client, bad):
        assert _me(client, bad).status_code == 401
