"""Testes de concorrência do SEA contra a API local (conexões reais, requisições em paralelo).

    docker compose exec -T api python - < qa/concorrencia.py

Usa os usuários de qa/seed_qa.py e cria OTs fictícias novas a cada execução. Só ambiente local.
Verifica que requisições simultâneas nunca reservam além do saldo, nunca baixam duas vezes e
nunca deixam estoque negativo.
"""

import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "http://localhost:5000"
PASSWORD = "Qa@12345"
EXPEDICAO = 1
falhas = []


def call(method, path, token=None, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def login(user):
    status, body = call("POST", "/api/auth/login", body={"username": user, "password": PASSWORD})
    assert status == 200, (user, status, body)
    return body["token"]


def check(nome, cond, detalhe=""):
    print(("OK   " if cond else "FALHA"), nome, detalhe)
    if not cond:
        falhas.append(nome)


def nova_ot(qtd, uom="PC", pack=None, guardar=True):
    n = str(time.time_ns())[-9:]
    ot, ordem, mat = f"4{n}", f"3{n}", f"QAC{n}"
    adm, oper = login("qa.admin"), login("qa.oper")
    material = {"material_code": mat, "description": "Material concorrência (fictício)", "uom": uom}
    if pack:
        material["pack_weight_kg"] = pack
    for kind, rec in (
        ("ordens", {"order_number": ordem, "order_type": "PM11"}),
        ("materiais", material),
        (
            "reservas",
            {"ot_number": ot, "order_number": ordem, "material_code": mat, "quantity": qtd},
        ),
    ):
        s, b = call("POST", f"/api/sea/sap/importar/{kind}", adm, {"records": [rec]})
        assert s == 200 and not b["errors"], (kind, b)
    s, reg = call(
        "POST", "/api/sea/recebimentos/base", oper, {"warehouse_id": EXPEDICAO, "ot_code": ot}
    )
    assert s == 201, reg
    area = call("GET", f"/api/sea/recebimentos/areas?warehouse_id={EXPEDICAO}", oper)[1]["bins"][0][
        "bin_id"
    ]
    line = call("GET", f"/api/receiving/po/{ot}", oper)[1]["lines"][0]
    s, b = call(
        "POST",
        "/api/receiving/receive",
        oper,
        {
            "po_id": reg["po_id"],
            "items": [{"item_id": line["item_id"], "quantity": qtd, "bin_id": area}],
        },
    )
    assert s == 200, b
    pend = next(
        p
        for p in call("GET", "/api/sea/armazenagem/pendentes", oper)[1]["pending_items"]
        if p["lot_number"] == ot
    )
    dest = next(
        b
        for b in call("GET", "/api/sea/armazenagem/destinos", oper)[1]["bins"]
        if b["warehouse_code"] == "SP12"
    )
    ctx = {
        "ot": ot,
        "ordem": ordem,
        "item_id": line["item_id"],
        "from_bin": pend["bin_id"],
        "to_bin": dest["bin_id"],
        "oper": oper,
    }
    if guardar:
        s, b = call(
            "POST",
            "/api/putaway/confirm",
            oper,
            {
                "item_id": line["item_id"],
                "from_bin_id": pend["bin_id"],
                "to_bin_id": dest["bin_id"],
                "quantity": qtd,
                "lot_number": ot,
            },
        )
        assert s == 200, b
    return ctx


def estoque(ordem, token):
    return call("GET", f"/api/sea/ordens/{ordem}", token)[1]["stock"]


def paralelo(n, fn):
    with ThreadPoolExecutor(max_workers=n) as ex:
        return list(ex.map(lambda i: fn(i), range(n)))


# 1. 30 pedidos simultâneos de 1 unidade sobre 10 disponíveis -------------------------------
ctx = nova_ot(10)
solic = login("qa.solic")
inv = estoque(ctx["ordem"], solic)[0]["inventory_id"]
res = paralelo(
    30,
    lambda i: call(
        "POST",
        "/api/sea/retiradas",
        solic,
        {"ot": ctx["ot"], "lines": [{"inventory_id": inv, "quantity": 1}]},
    ),
)
ok = [r for r in res if r[0] == 201]
check("1. reserva nunca passa do saldo", len(ok) == 10, f"(aceitos {len(ok)} de 30)")
check(
    "1. recusados com 409, nunca 500",
    all(r[0] in (201, 409) for r in res),
    str(sorted({r[0] for r in res})),
)
check("1. saldo livre zerado, nunca negativo", estoque(ctx["ordem"], solic) == [])

# 2. 10 confirmações de entrega simultâneas ---------------------------------------------------
ctx = nova_ot(5)
inv = estoque(ctx["ordem"], solic)[0]["inventory_id"]
s, b = call(
    "POST",
    "/api/sea/retiradas",
    solic,
    {"ot": ctx["ot"], "lines": [{"inventory_id": inv, "quantity": 3}]},
)
wid = b["withdrawal"]["withdrawal_id"]
aval, almox, almox2 = login("qa.avaliador"), login("qa.almox"), login("qa.admin")
call("POST", f"/api/sea/retiradas/{wid}/avaliar", aval, {"approve": True})

# 3. dois almoxarifes aceitam ao mesmo tempo (o segundo é um admin) ---------------------------
res = paralelo(
    10, lambda i: call("POST", f"/api/sea/retiradas/{wid}/separar", almox if i % 2 else almox2, {})
)
check(
    "3. só um aceite vence", sum(1 for r in res if r[0] == 200) == 1, str(sorted(r[0] for r in res))
)
quem = call("GET", f"/api/sea/retiradas/{wid}", solic)[1]["withdrawal"]["picked_by"]
dono = almox if quem == "qa.almox" else almox2
call("POST", f"/api/sea/retiradas/{wid}/pronta", dono, {})
res = paralelo(10, lambda i: call("POST", f"/api/sea/retiradas/{wid}/entregar", solic, {}))
check(
    "2. só uma entrega vence",
    sum(1 for r in res if r[0] == 200) == 1,
    str(sorted(r[0] for r in res)),
)
restante = estoque(ctx["ordem"], solic)
check("2. baixa feita uma vez só", restante and restante[0]["available"] == 2, str(restante))

# 4. armazenagens simultâneas do mesmo material além do que há na área ------------------------
ctx = nova_ot(6, guardar=False)
oper = ctx["oper"]
res = paralelo(
    6,
    lambda i: call(
        "POST",
        "/api/putaway/confirm",
        oper,
        {
            "item_id": ctx["item_id"],
            "from_bin_id": ctx["from_bin"],
            "to_bin_id": ctx["to_bin"],
            "quantity": 2,
            "lot_number": ctx["ot"],
        },
    ),
)
ok = sum(1 for r in res if r[0] == 200)
check(
    "4. armazena no máximo o que havia (3 x 2)",
    ok == 3,
    f"(aceitos {ok} de 6: {sorted(r[0] for r in res)})",
)
guardado = sum(s["available"] for s in estoque(ctx["ordem"], solic))
check("4. estoque guardado = 6, sem duplicar", guardado == 6, f"(guardado {guardado})")

print("\nRESULTADO:", "tudo certo" if not falhas else f"{len(falhas)} falha(s): {falhas}")
sys.exit(1 if falhas else 0)
