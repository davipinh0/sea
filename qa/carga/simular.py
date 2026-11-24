"""Simulação de uso real do SEA numa empresa FICTÍCIA de grande porte (qa/carga/README.md).

Etapas:
  1. Implantação: a base do SAP da empresa entra pela importação do painel e os funcionários entram.
  2. Dia de operação (comprimido): recebedores recebem as OTs no Recebimento e armazenam no SP12/SP13,
     solicitantes pedem material pelo terminal, avaliadores aprovam ou negam, almoxarifes separam
     e o solicitante confirma a entrega; consultores olham painel, ordens e histórico o tempo todo.
  3. Confrontos: muitas pessoas disputando a mesma coisa no mesmo instante (último material, mesma
     retirada, mesma OT, entrega em dobro).
  4. Escalada: a carga sobe por patamares até o sistema passar do limite.
  5. Conferência: regras do banco (invariantes.py) e relatório em qa/carga/resultados/.

Roda num container com a configuração da API da simulação (README); fala com ela pela rede interna
e lê o banco sea_carga só para preparar funcionários e conferir no fim.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import random
import sys
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import requests
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).parent))
import empresa  # noqa: E402
import invariantes  # noqa: E402

API = os.environ.get("CARGA_API", "http://sea-api-carga:5000")
APP = {"X-SEA-Identidade": "digital-pin"}  # o app avisa que confirmou a digital/PIN
RECEBIMENTO = "Recebimento"
RESULTADOS = Path(__file__).parent / "resultados"


# --- Medição


class Metricas:
    def __init__(self):
        self._lock = threading.Lock()
        self.tempos = defaultdict(list)
        self.status = defaultdict(Counter)
        self.falhas = defaultdict(list)

    def registrar(self, rotulo, ms, status, ok, detalhe=None):
        with self._lock:
            self.tempos[rotulo].append(ms)
            self.status[rotulo][status] += 1
            if not ok and len(self.falhas[rotulo]) < 5:
                self.falhas[rotulo].append({"status": status, "detalhe": detalhe})

    def resumo(self):
        linhas = []
        for rotulo, tempos in sorted(self.tempos.items()):
            erros = sum(n for s, n in self.status[rotulo].items() if s == 0 or s >= 500)
            linhas.append(
                {
                    "rota": rotulo,
                    "n": len(tempos),
                    "erros_servidor": erros,
                    "status": dict(self.status[rotulo]),
                    **percentis(tempos),
                    "falhas": self.falhas.get(rotulo, []),
                }
            )
        return linhas


def percentis(tempos):
    if not tempos:
        return {"p50": 0, "p95": 0, "p99": 0, "max": 0}
    ordenado = sorted(tempos)

    def p(q):
        return round(ordenado[min(len(ordenado) - 1, int(q * len(ordenado)))], 1)

    return {"p50": p(0.50), "p95": p(0.95), "p99": p(0.99), "max": round(ordenado[-1], 1)}


class Cliente:
    """Um funcionário com a sessão dele (token Bearer, como o app e o terminal)."""

    def __init__(self, username, papel, metricas):
        self.username, self.papel, self.metricas = username, papel, metricas
        self.http = requests.Session()
        self.http.headers.update(APP)

    def entrar(self, senha=empresa.SENHA):
        status, corpo = self.chamar(
            "POST",
            "/api/auth/login",
            "POST /auth/login",
            {"username": self.username, "password": senha},
        )
        if status != 200:
            raise RuntimeError(f"login de {self.username} falhou: {status} {corpo}")
        self.http.headers["Authorization"] = f"Bearer {corpo['token']}"
        return self

    def chamar(self, metodo, caminho, rotulo, corpo=None, esperado=(200, 201), metricas=None):
        inicio = time.perf_counter()
        try:
            r = self.http.request(metodo, API + caminho, json=corpo, timeout=90)
            status = r.status_code
            try:
                dados = r.json()
            except ValueError:
                dados = {"texto": r.text[:200]}
        except requests.RequestException as exc:
            status, dados = 0, {"erro": type(exc).__name__}
        ms = (time.perf_counter() - inicio) * 1000
        ok = status in esperado
        (metricas or self.metricas).registrar(
            rotulo,
            ms,
            status,
            ok,
            None if ok else (dados.get("error") if isinstance(dados, dict) else None),
        )
        return status, dados


# --- 1. Implantação


def implantar(dados, metricas, admin_senha):
    admin = Cliente("admin", "admin", metricas).entrar(admin_senha)
    tempos = {}
    for tipo, linhas in (
        ("ordens", dados.ordens),
        ("materiais", dados.materiais),
        ("reservas", dados.reservas),
    ):
        inicio = time.perf_counter()
        for i in range(0, len(linhas), 5000):
            status, corpo = admin.chamar(
                "POST",
                f"/api/sea/sap/importar/{tipo}",
                f"POST /sap/importar/{tipo}",
                {"records": linhas[i : i + 5000]},
            )
            if status != 200 or corpo.get("errors"):
                raise RuntimeError(f"importação de {tipo}: {status} {str(corpo)[:300]}")
        tempos[tipo] = {"linhas": len(linhas), "segundos": round(time.perf_counter() - inicio, 1)}
    return admin, tempos


def entrar_todos(funcionarios, metricas):
    with ThreadPoolExecutor(16) as pool:
        clientes = list(
            pool.map(lambda f: Cliente(f.username, f.papel, metricas).entrar(), funcionarios)
        )
    por_papel = defaultdict(list)
    for c in clientes:
        por_papel[c.papel].append(c)
    return por_papel


# --- 2. Dia de operação


class Dia:
    def __init__(self, por_papel, dados, metricas, alvo_ots, alvo_retiradas, locais):
        self.p, self.m = por_papel, metricas
        self.locais = locais
        self.rnd = random.Random(empresa.SEMENTE + 1)
        ots = defaultdict(list)
        for r in dados.reservas:
            ots[r["ot_number"]].append(r)
        self.fila_receber = queue.Queue()
        for ot in list(ots)[:alvo_ots]:
            self.fila_receber.put(ot)
        self.alvo_ots = min(alvo_ots, len(ots))
        self.alvo_retiradas = alvo_retiradas
        self.fila_armazenar = queue.Queue()
        self.fila_avaliar = queue.Queue()
        self.fila_separar = queue.Queue()
        self.fila_entregar = queue.Queue()
        self.ordens_guardadas = []
        self.ordem_de_ot = {ot: linhas[0]["order_number"] for ot, linhas in ots.items()}
        self._lock = threading.Lock()
        self.cont = Counter()
        self.fim_recebimento = threading.Event()
        self.fim_retiradas = threading.Event()
        self.area = None
        self.destinos = None

    def _conta(self, chave, n=1):
        with self._lock:
            self.cont[chave] += n

    def preparar(self):
        c = self.p["recebedor"][0]
        _, corpo = c.chamar(
            "GET",
            f"/api/sea/recebimentos/areas?warehouse_id={self.locais[RECEBIMENTO]}",
            "GET /recebimentos/areas",
        )
        self.area = corpo["bins"][0]["bin_id"]
        _, corpo = c.chamar("GET", "/api/sea/armazenagem/destinos", "GET /armazenagem/destinos")
        self.destinos = [b for b in corpo["bins"] if b.get("warehouse_code") in ("SP12", "SP13")]

    def recebedor(self, c):
        while True:
            try:
                ot = self.fila_receber.get_nowait()
            except queue.Empty:
                return
            status, corpo = c.chamar(
                "POST",
                "/api/sea/recebimentos/base",
                "POST /recebimentos/base",
                {"warehouse_id": self.locais[RECEBIMENTO], "ot_code": ot},
            )
            if status != 201:
                self._conta("ot não registrada")
                continue
            po_id = corpo["po_id"]
            _, corpo = c.chamar("GET", f"/api/receiving/po/{ot}", "GET /receiving/po/{ot}")
            linhas = corpo.get("lines", [])
            # 1 em 4 chega em duas entregas (recebimento parcial), como acontece na usina.
            partes = 2 if self.rnd.random() < 0.25 else 1
            for parte in range(partes):
                itens = []
                for ln in linhas:
                    total = ln["quantity_ordered"]
                    qtd = (
                        total // 2
                        if partes == 2 and parte == 0
                        else total - (total // 2 if partes == 2 else 0)
                    )
                    if qtd > 0:
                        itens.append(
                            {"item_id": ln["item_id"], "quantity": qtd, "bin_id": self.area}
                        )
                if itens:
                    c.chamar(
                        "POST",
                        "/api/receiving/receive",
                        "POST /receiving/receive",
                        {"po_id": po_id, "items": itens},
                    )
            c.chamar("GET", "/api/sea/notificacoes", "GET /notificacoes")
            self._conta("OTs recebidas")
            self.fila_armazenar.put(ot)

    def armazenador(self, c):
        while True:
            try:
                ot = self.fila_armazenar.get(timeout=1)
            except queue.Empty:
                if self.fim_recebimento.is_set():
                    return
                continue
            _, corpo = c.chamar(
                "GET", "/api/sea/armazenagem/pendentes", "GET /armazenagem/pendentes"
            )
            pendentes = [x for x in corpo.get("pending_items", []) if x.get("lot_number") == ot]
            for item in pendentes:
                destino = self.rnd.choice(self.destinos)
                status, _ = c.chamar(
                    "POST",
                    "/api/putaway/confirm",
                    "POST /putaway/confirm",
                    {
                        "item_id": item["item_id"],
                        "from_bin_id": item["bin_id"],
                        "to_bin_id": destino["bin_id"],
                        "quantity": item["quantity"],
                        "lot_number": ot,
                    },
                )
                self._conta("materiais armazenados" if status == 200 else "armazenagem recusada")
            with self._lock:
                self.ordens_guardadas.append(self.ordem_de_ot[ot])

    def solicitante(self, c):
        while not self.fim_retiradas.is_set():
            with self._lock:
                if self.cont["retiradas pedidas"] >= self.alvo_retiradas:
                    return
                ordem = self.rnd.choice(self.ordens_guardadas) if self.ordens_guardadas else None
            if ordem is None:
                time.sleep(0.2)
                continue
            _, corpo = c.chamar("GET", f"/api/sea/ordens/{ordem}", "GET /ordens/{n} (terminal)")
            estoque = [s for s in corpo.get("stock", []) if s["available"] > 0]
            if not estoque:
                self._conta("ordem sem saldo no terminal")
                continue
            grupo = self.rnd.choice(estoque)
            mesmos = [
                s
                for s in estoque
                if (s["ot"], s["warehouse_id"]) == (grupo["ot"], grupo["warehouse_id"])
            ]
            linhas = []
            for s in self.rnd.sample(mesmos, min(len(mesmos), self.rnd.randint(1, 3))):
                caixa = s.get("pack_weight_kg") or 1
                caixas = s["available"] // caixa
                if caixas:
                    linhas.append(
                        {
                            "inventory_id": s["inventory_id"],
                            "quantity": caixa * self.rnd.randint(1, max(1, caixas // 2 or 1)),
                        }
                    )
            if not linhas:
                continue
            status, corpo = c.chamar(
                "POST",
                "/api/sea/retiradas",
                "POST /retiradas",
                {"ot": grupo["ot"], "lines": linhas},
                esperado=(201, 409),
            )
            if status == 201:
                self._conta("retiradas pedidas")
                self.fila_avaliar.put((corpo["withdrawal"]["withdrawal_id"], c))
            elif status == 409:
                self._conta("pedido recusado (saldo tomado por outro)")

    def avaliador(self, c):
        while True:
            try:
                wid, quem = self.fila_avaliar.get(timeout=1)
            except queue.Empty:
                if self.fim_retiradas.is_set():
                    return
                continue
            if self.rnd.random() < 0.92:
                status, _ = c.chamar(
                    "POST",
                    f"/api/sea/retiradas/{wid}/avaliar",
                    "POST /retiradas/{id}/avaliar",
                    {"approve": True},
                )
                if status == 200:
                    self.fila_separar.put((wid, quem))
            else:
                c.chamar(
                    "POST",
                    f"/api/sea/retiradas/{wid}/avaliar",
                    "POST /retiradas/{id}/avaliar",
                    {"approve": False, "note": "Ordem sem programação nesta semana (simulação)"},
                )
                self._conta("retiradas negadas")
                self._conta("retiradas concluídas")
            c.chamar("GET", "/api/sea/retiradas?status=REQUESTED", "GET /retiradas?status")

    def almoxarife(self, c):
        while True:
            try:
                wid, quem = self.fila_separar.get(timeout=1)
            except queue.Empty:
                if self.fim_retiradas.is_set():
                    return
                continue
            ok1, _ = c.chamar(
                "POST", f"/api/sea/retiradas/{wid}/separar", "POST /retiradas/{id}/separar", {}
            )
            ok2, _ = c.chamar(
                "POST", f"/api/sea/retiradas/{wid}/pronta", "POST /retiradas/{id}/pronta", {}
            )
            if ok1 == 200 and ok2 == 200:
                self.fila_entregar.put((wid, quem))

    def entrega(self, _c):
        while True:
            try:
                wid, quem = self.fila_entregar.get(timeout=1)
            except queue.Empty:
                if self.fim_retiradas.is_set():
                    return
                continue
            if self.rnd.random() < 0.05:
                quem.chamar(
                    "POST",
                    f"/api/sea/retiradas/{wid}/cancelar",
                    "POST /retiradas/{id}/cancelar",
                    {"reason": "Desistiu no balcão (simulação)"},
                )
                self._conta("retiradas canceladas")
            else:
                status, _ = quem.chamar(
                    "POST",
                    f"/api/sea/retiradas/{wid}/entregar",
                    "POST /retiradas/{id}/entregar",
                    {},
                )
                self._conta("retiradas entregues" if status == 200 else "entrega recusada")
            self._conta("retiradas concluídas")

    def consultor(self, c, parar):
        rotas = [
            ("/api/sea/painel?warehouse_id={w}", "GET /painel"),
            ("/api/sea/ots?warehouse_id={w}", "GET /ots (lista)"),
            ("/api/sea/ordens?warehouse_id={w}", "GET /ordens (lista)"),
            ("/api/admin/audit-log?page=1&per_page=50", "GET /admin/audit-log"),
            ("/api/sea/materiais?warehouse_id={w}&q=AUR-1", "GET /materiais?q"),
            ("/api/sea/notificacoes", "GET /notificacoes"),
        ]
        while not parar.is_set():
            caminho, rotulo = self.rnd.choice(rotas)
            c.chamar("GET", caminho.format(w=self.rnd.choice(list(self.locais.values()))), rotulo)
            time.sleep(self.rnd.uniform(0.2, 1.0))

    def rodar(self):
        self.preparar()
        inicio = time.perf_counter()
        parar_consulta = threading.Event()
        threads = []

        def iniciar(alvo, *args):
            t = threading.Thread(target=alvo, args=args, daemon=True)
            t.start()
            threads.append(t)
            return t

        recebedores = self.p["recebedor"]
        metade = max(1, len(recebedores) // 2)
        receb = [iniciar(self.recebedor, c) for c in recebedores[:metade]]
        armaz = [iniciar(self.armazenador, c) for c in recebedores[metade:]]
        consult = [iniciar(self.consultor, c, parar_consulta) for c in self.p["consultor"]]
        solic = [iniciar(self.solicitante, c) for c in self.p["solicitante"]]
        aval = [iniciar(self.avaliador, c) for c in self.p["avaliador"]]
        almox = [iniciar(self.almoxarife, c) for c in self.p["almoxarife"]]
        entreg = [iniciar(self.entrega, None) for _ in range(8)]

        for t in receb:
            t.join()
        self.fim_recebimento.set()
        for t in armaz:
            t.join()
        fim_receb = time.perf_counter()
        for t in solic:
            t.join()
        # Espera as retiradas pedidas chegarem ao fim (entregues, negadas ou canceladas).
        limite = time.time() + 600
        while time.time() < limite:
            with self._lock:
                if self.cont["retiradas concluídas"] >= self.cont["retiradas pedidas"]:
                    break
            time.sleep(0.5)
        self.fim_retiradas.set()
        for t in aval + almox + entreg:
            t.join()
        parar_consulta.set()
        for t in consult:
            t.join()
        return {
            "segundos": round(time.perf_counter() - inicio, 1),
            "segundos_recebimento_e_armazenagem": round(fim_receb - inicio, 1),
            "contagem": dict(self.cont),
            "ordens_com_estoque": sorted(set(self.ordens_guardadas)),
        }


# --- 3. Confrontos


def revezar(pessoas, n):
    """n posições ocupadas pelas pessoas em rodízio."""
    return [pessoas[i % len(pessoas)] for i in range(n)]


def ao_mesmo_tempo(funcoes):
    """Dispara todas as chamadas no mesmo instante (barreira) e devolve os status."""
    barreira = threading.Barrier(len(funcoes))
    resultados = [None] * len(funcoes)

    def rodar(i, f):
        barreira.wait()
        resultados[i] = f()

    threads = [threading.Thread(target=rodar, args=(i, f)) for i, f in enumerate(funcoes)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return resultados


def confrontos(por_papel, dados, locais, ordens, metricas, db):
    rnd = random.Random(empresa.SEMENTE + 2)
    solic, aval, almox, receb = (
        por_papel[p] for p in ("solicitante", "avaliador", "almoxarife", "recebedor")
    )
    casos = []

    def caso(nome, esperado, obtido, ok, extra=None):
        casos.append(
            {"caso": nome, "esperado": esperado, "obtido": obtido, "ok": ok, **(extra or {})}
        )

    def estoque_livre(minimo, maximo=10**9, pc=True):
        for ordem in rnd.sample(ordens, len(ordens)):
            _, corpo = solic[0].chamar(
                "GET", f"/api/sea/ordens/{ordem}", "GET /ordens/{n} (terminal)"
            )
            for s in corpo.get("stock", []):
                if minimo <= s["available"] <= maximo and (not pc or not s.get("pack_weight_kg")):
                    return s
        return None

    # a) Último material: 30 pessoas pedem 1 unidade de um material que tem poucas.
    s = estoque_livre(3, 25)
    if s:
        pedidos = 30
        st = ao_mesmo_tempo(
            [
                (
                    lambda c=c: c.chamar(
                        "POST",
                        "/api/sea/retiradas",
                        "POST /retiradas (confronto)",
                        {
                            "ot": s["ot"],
                            "lines": [{"inventory_id": s["inventory_id"], "quantity": 1}],
                        },
                        esperado=(201, 409),
                    )[0]
                )
                for c in revezar(solic, pedidos)
            ]
        )
        ganhos = st.count(201)
        caso(
            "30 pessoas pedem a última unidade ao mesmo tempo",
            f"{s['available']} pedidos aceitos (o saldo), {pedidos - s['available']} recusados",
            f"{ganhos} aceitos, {st.count(409)} recusados, "
            f"outros: {[x for x in st if x not in (201, 409)]}",
            ganhos == s["available"] and st.count(409) == pedidos - s["available"],
        )

    # b) Mesma retirada aceita por 10 almoxarifes ao mesmo tempo.
    s = estoque_livre(2)
    if s:
        c = solic[1 % len(solic)]
        _, corpo = c.chamar(
            "POST",
            "/api/sea/retiradas",
            "POST /retiradas",
            {"ot": s["ot"], "lines": [{"inventory_id": s["inventory_id"], "quantity": 1}]},
        )
        wid = corpo["withdrawal"]["withdrawal_id"]
        aval[0].chamar(
            "POST",
            f"/api/sea/retiradas/{wid}/avaliar",
            "POST /retiradas/{id}/avaliar",
            {"approve": True},
        )
        st = ao_mesmo_tempo(
            [
                (
                    lambda a=a: a.chamar(
                        "POST",
                        f"/api/sea/retiradas/{wid}/separar",
                        "POST /retiradas/{id}/separar (confronto)",
                        {},
                        esperado=(200, 409),
                    )[0]
                )
                for a in revezar(almox, 10)
            ]
        )
        caso(
            "10 almoxarifes aceitam a mesma retirada ao mesmo tempo",
            "1 aceita, 9 recusadas",
            f"{st.count(200)} aceitas, {st.count(409)} recusadas",
            st.count(200) == 1 and st.count(409) == 9,
        )

        # c) A mesma entrega confirmada 10 vezes ao mesmo tempo: o estoque baixa uma vez só.
        quem_aceitou = db.execute(
            text("SELECT picked_by FROM withdrawals WHERE withdrawal_id = :w"), {"w": wid}
        ).scalar()
        dono = next((a for a in almox if a.username == quem_aceitou), almox[0])
        dono.chamar("POST", f"/api/sea/retiradas/{wid}/pronta", "POST /retiradas/{id}/pronta", {})
        antes = db.execute(
            text("SELECT quantity_on_hand FROM inventory WHERE inventory_id = :i"),
            {"i": s["inventory_id"]},
        ).scalar()
        st = ao_mesmo_tempo(
            [
                (
                    lambda: c.chamar(
                        "POST",
                        f"/api/sea/retiradas/{wid}/entregar",
                        "POST /retiradas/{id}/entregar (confronto)",
                        {},
                        esperado=(200, 409),
                    )[0]
                )
                for _ in range(10)
            ]
        )
        depois = db.execute(
            text("SELECT quantity_on_hand FROM inventory WHERE inventory_id = :i"),
            {"i": s["inventory_id"]},
        ).scalar()
        caso(
            "Entrega confirmada 10 vezes ao mesmo tempo",
            "1 confirmada; estoque baixa 1 unidade",
            f"{st.count(200)} confirmadas; estoque {antes} → {depois}",
            st.count(200) == 1 and antes - depois == 1,
        )

    # d) A mesma OT da base do SAP registrada por 10 recebedores ao mesmo tempo.
    registradas = {r[0] for r in db.execute(text("SELECT po_number FROM purchase_orders"))}
    livre = next(
        (r["ot_number"] for r in dados.reservas if r["ot_number"] not in registradas), None
    )
    if livre:
        st = ao_mesmo_tempo(
            [
                (
                    lambda r=r: r.chamar(
                        "POST",
                        "/api/sea/recebimentos/base",
                        "POST /recebimentos/base (confronto)",
                        {"warehouse_id": locais[RECEBIMENTO], "ot_code": livre},
                        esperado=(201, 409),
                    )[0]
                )
                for r in revezar(receb, 10)
            ]
        )
        cadastros = db.execute(
            text("SELECT COUNT(*) FROM purchase_orders WHERE po_number = :o"), {"o": livre}
        ).scalar()
        caso(
            "10 recebedores registram a mesma OT ao mesmo tempo",
            "1 cadastro, 9 recusados",
            f"{st.count(201)} cadastros pela API, {st.count(409)} recusados; {cadastros} no banco",
            st.count(201) == 1 and cadastros == 1,
        )

        # e) O mesmo material recebido inteiro por 10 pessoas ao mesmo tempo.
        _, corpo = receb[0].chamar("GET", f"/api/receiving/po/{livre}", "GET /receiving/po/{ot}")
        po_id = corpo["purchase_order"]["po_id"]
        ln = corpo["lines"][0]
        area = receb[0].chamar(
            "GET",
            f"/api/sea/recebimentos/areas?warehouse_id={locais[RECEBIMENTO]}",
            "GET /recebimentos/areas",
        )[1]["bins"][0]["bin_id"]
        st = ao_mesmo_tempo(
            [
                (
                    lambda r=r: r.chamar(
                        "POST",
                        "/api/receiving/receive",
                        "POST /receiving/receive (confronto)",
                        {
                            "po_id": po_id,
                            "items": [
                                {
                                    "item_id": ln["item_id"],
                                    "quantity": ln["quantity_ordered"],
                                    "bin_id": area,
                                }
                            ],
                        },
                        esperado=(200, 400, 409),
                    )[0]
                )
                for r in revezar(receb, 10)
            ]
        )
        recebido = db.execute(
            text("SELECT quantity_received FROM purchase_order_lines WHERE po_line_id = :l"),
            {"l": ln["po_line_id"]},
        ).scalar()
        caso(
            "10 pessoas recebem o mesmo material inteiro ao mesmo tempo",
            f"recebido = {ln['quantity_ordered']} (o previsto), 9 recusados",
            f"{st.count(200)} aceitos; recebido no banco = {recebido}",
            recebido == ln["quantity_ordered"] and st.count(200) == 1,
        )

        # f) A mesma armazenagem confirmada 10 vezes ao mesmo tempo.
        _, corpo = receb[0].chamar(
            "GET", "/api/sea/armazenagem/pendentes", "GET /armazenagem/pendentes"
        )
        item = next(
            (x for x in corpo.get("pending_items", []) if x.get("lot_number") == livre), None
        )
        destinos = receb[0].chamar(
            "GET", "/api/sea/armazenagem/destinos", "GET /armazenagem/destinos"
        )[1]["bins"]
        destino = next(b for b in destinos if b.get("warehouse_code") == "SP12")
        if item:
            st = ao_mesmo_tempo(
                [
                    (
                        lambda r=r: r.chamar(
                            "POST",
                            "/api/putaway/confirm",
                            "POST /putaway/confirm (confronto)",
                            {
                                "item_id": item["item_id"],
                                "from_bin_id": item["bin_id"],
                                "to_bin_id": destino["bin_id"],
                                "quantity": item["quantity"],
                                "lot_number": livre,
                            },
                            esperado=(200, 400, 409),
                        )[0]
                    )
                    for r in revezar(receb, 10)
                ]
            )
            guardado = db.execute(
                text(
                    "SELECT COALESCE(SUM(quantity_on_hand), 0) FROM inventory "
                    "WHERE lot_number = :o AND item_id = :i"
                ),
                {"o": livre, "i": item["item_id"]},
            ).scalar()
            caso(
                "10 pessoas armazenam o mesmo material ao mesmo tempo",
                f"1 armazenagem; total do material continua {item['quantity']}",
                f"{st.count(200)} aceitas; total no estoque = {guardado}",
                st.count(200) == 1 and guardado == item["quantity"],
            )
    return casos


# --- 4. Escalada


def escalada(por_papel, ordens, locais, patamares, segundos, limite_p95):
    rnd = random.Random(empresa.SEMENTE + 3)
    leitura = por_papel["consultor"] + por_papel["recebedor"]
    solic = por_papel["solicitante"]
    resultado = []
    for n in patamares:
        met = Metricas()
        parar = threading.Event()

        def trabalhador(i, met, parar):
            c_leitura = leitura[i % len(leitura)]
            c_solic = solic[i % len(solic)]
            while not parar.is_set():
                sorteio = rnd.random()
                w = rnd.choice(list(locais.values()))
                if sorteio < 0.30:
                    c_solic.chamar(
                        "GET",
                        f"/api/sea/ordens/{rnd.choice(ordens)}",
                        "GET /ordens/{n} (terminal)",
                        metricas=met,
                    )
                elif sorteio < 0.45:
                    c_leitura.chamar(
                        "GET", f"/api/sea/painel?warehouse_id={w}", "GET /painel", metricas=met
                    )
                elif sorteio < 0.55:
                    c_leitura.chamar(
                        "GET", "/api/sea/notificacoes", "GET /notificacoes", metricas=met
                    )
                elif sorteio < 0.65:
                    c_leitura.chamar(
                        "GET", f"/api/sea/ots?warehouse_id={w}", "GET /ots (lista)", metricas=met
                    )
                elif sorteio < 0.72:
                    c_leitura.chamar(
                        "GET",
                        f"/api/sea/ordens?warehouse_id={w}",
                        "GET /ordens (lista)",
                        metricas=met,
                    )
                elif sorteio < 0.85:
                    por_papel["recebedor"][i % len(por_papel["recebedor"])].chamar(
                        "GET",
                        "/api/sea/armazenagem/pendentes",
                        "GET /armazenagem/pendentes",
                        metricas=met,
                    )
                else:
                    # Escrita: pede 1 unidade e cancela (o estoque volta ao que era).
                    _, corpo = c_solic.chamar(
                        "GET",
                        f"/api/sea/ordens/{rnd.choice(ordens)}",
                        "GET /ordens/{n} (terminal)",
                        metricas=met,
                    )
                    livres = [
                        s
                        for s in corpo.get("stock", [])
                        if s["available"] > 0 and not s.get("pack_weight_kg")
                    ]
                    if livres:
                        s = rnd.choice(livres)
                        st, corpo = c_solic.chamar(
                            "POST",
                            "/api/sea/retiradas",
                            "POST /retiradas",
                            {
                                "ot": s["ot"],
                                "lines": [{"inventory_id": s["inventory_id"], "quantity": 1}],
                            },
                            esperado=(201, 409),
                            metricas=met,
                        )
                        if st == 201:
                            c_solic.chamar(
                                "POST",
                                f"/api/sea/retiradas/{corpo['withdrawal']['withdrawal_id']}/cancelar",
                                "POST /retiradas/{id}/cancelar",
                                {"reason": "teste de carga"},
                                metricas=met,
                            )

        threads = [
            threading.Thread(target=trabalhador, args=(i, met, parar), daemon=True)
            for i in range(n)
        ]
        inicio = time.perf_counter()
        for t in threads:
            t.start()
        time.sleep(segundos)
        parar.set()
        for t in threads:
            t.join(timeout=120)
        duracao = time.perf_counter() - inicio
        todos = [ms for tempos in met.tempos.values() for ms in tempos]
        erros = sum(n_ for st in met.status.values() for s, n_ in st.items() if s == 0 or s >= 500)
        linha = {
            "usuarios_simultaneos": n,
            "requisicoes": len(todos),
            "req_por_segundo": round(len(todos) / duracao, 1),
            "erros_servidor_pct": round(100 * erros / max(1, len(todos)), 2),
            **percentis(todos),
            "rotas": met.resumo(),
        }
        resultado.append(linha)
        print(
            f"  {n:>4} simultâneos: {linha['req_por_segundo']:>6} req/s  p95 {linha['p95']:>7} ms  "
            f"erros {linha['erros_servidor_pct']}%",
            flush=True,
        )
        if linha["erros_servidor_pct"] > 5 or linha["p95"] > limite_p95:
            break
    return resultado


# --- 5. Notificações e relatório


def esperar_emails(db, segundos=120):
    limite = time.time() + segundos
    while time.time() < limite:
        pendentes = db.execute(
            text("SELECT COUNT(*) FROM sea_notifications WHERE email_status = 'PENDING'")
        ).scalar()
        if not pendentes:
            break
        time.sleep(2)
    linhas = db.execute(
        text("SELECT email_status, COUNT(*) FROM sea_notifications GROUP BY 1")
    ).fetchall()
    return {str(s): n for s, n in linhas}


def capacidade(escalada_):
    boas = [x for x in escalada_ if x["p95"] <= 1000 and x["erros_servidor_pct"] < 1]
    return boas[-1] if boas else None


def relatorio_md(r):
    linhas = [
        f"# Simulação de carga do SEA: {r['empresa']}",
        "",
        f"Execução: {r['inicio']} · duração {r['duracao_min']} min · ambiente: {r['ambiente']}",
        "",
        "## Porte simulado",
        "",
        "| Item | Quantidade |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in r["porte"].items()],
        "",
        "## Implantação (importação da base do SAP pelo painel)",
        "",
        "| Arquivo | Linhas | Tempo (s) |",
        "|---|---|---|",
        *[f"| {k} | {v['linhas']} | {v['segundos']} |" for k, v in r["implantacao"].items()],
        "",
        "## Dia de operação",
        "",
        f"Duração: {r['dia']['segundos']} s (recebimento e armazenagem em "
        f"{r['dia']['segundos_recebimento_e_armazenagem']} s).",
        "",
        "| Evento | Quantidade |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in sorted(r["dia"]["contagem"].items())],
        "",
        "Tempo de resposta por rota durante o dia (ms):",
        "",
        "| Rota | Chamadas | p50 | p95 | p99 | máx | Erros 5xx | Status |",
        "|---|---|---|---|---|---|---|---|",
        *[
            f"| {x['rota']} | {x['n']} | {x['p50']} | {x['p95']} | {x['p99']} | {x['max']} | "
            f"{x['erros_servidor']} | {x['status']} |"
            for x in r["metricas_dia"]
        ],
        "",
        "## Confrontos (muitas pessoas, mesma coisa, mesmo instante)",
        "",
        "| Caso | Esperado | Obtido | Resultado |",
        "|---|---|---|---|",
        *[
            f"| {c['caso']} | {c['esperado']} | {c['obtido']} | {'OK' if c['ok'] else 'FALHOU'} |"
            for c in r["confrontos"]
        ],
        "",
        "## Escalada até o limite (leituras + pedidos cancelados)",
        "",
        "| Usuários simultâneos | Req/s | p50 | p95 | p99 | Erros 5xx (%) |",
        "|---|---|---|---|---|---|",
        *[
            f"| {x['usuarios_simultaneos']} | {x['req_por_segundo']} | {x['p50']} | "
            f"{x['p95']} | {x['p99']} | "
            f"{x['erros_servidor_pct']} |"
            for x in r["escalada"]
        ],
        "",
    ]
    cap = r.get("capacidade")
    linhas += [
        (
            "Capacidade sustentável (p95 ≤ 1 s e menos de 1% de erros): "
            f"**{cap['usuarios_simultaneos']} usuários "
            f"simultâneos, {cap['req_por_segundo']} req/s**."
            if cap
            else "Nenhum patamar ficou com p95 ≤ 1 s e menos de 1% de erros."
        ),
        "",
        "Rotas mais lentas no último patamar (p95, ms):",
        "",
        *[
            f"- {x['rota']}: p95 {x['p95']} ms em {x['n']} chamadas"
            for x in sorted(
                r["escalada"][-1]["rotas"] if r["escalada"] else [], key=lambda x: -x["p95"]
            )[:6]
        ],
        "",
        "## E-mails das notificações (worker da simulação, Mailpit local)",
        "",
        *[f"- {k}: {v}" for k, v in r["emails"].items()],
        "",
        "## Conferência do banco",
        "",
        "| Regra | Violações |",
        "|---|---|",
        *[f"| {x['regra']} | {x['violacoes']} |" for x in r["invariantes"]],
        "",
        "## Banco ao final",
        "",
        *[f"- {k}: {v}" for k, v in r["banco"].items()],
        "",
        f"**Resultado geral: {'APROVADO' if r['aprovado'] else 'REPROVADO'}**",
        "",
    ]
    return "\n".join(linhas)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--escala", type=float, default=1.0, help="multiplica o porte (1 = usina padrão)"
    )
    ap.add_argument("--ots", type=int, default=800, help="OTs recebidas no dia")
    ap.add_argument("--retiradas", type=int, default=500, help="retiradas pedidas no dia")
    ap.add_argument("--patamares", default="5,10,25,50,100,200,400")
    ap.add_argument("--segundos", type=int, default=30, help="duração de cada patamar")
    ap.add_argument(
        "--limite-p95", type=float, default=5000, help="ms; acima disso a escalada para"
    )
    ap.add_argument("--admin-senha", default=empresa.SENHA)
    args = ap.parse_args()

    banco = os.environ["DATABASE_URL"]
    if not banco.rstrip("/").endswith("/sea_carga"):
        raise SystemExit("Só roda contra o banco sea_carga (veja qa/carga/README.md).")
    db = create_engine(banco).connect()
    inicio = time.perf_counter()
    agora = datetime.now()
    porte = empresa.Porte.com_escala(args.escala)
    dados = empresa.gerar(porte)
    locais = {
        r.warehouse_code: r.warehouse_id
        for r in db.execute(text("SELECT warehouse_code, warehouse_id FROM warehouses"))
    }

    print(
        f"1/5 implantação: {len(dados.materiais)} materiais, {len(dados.ordens)} ordens, "
        f"{len(dados.reservas)} linhas de OT, {len(dados.funcionarios)} funcionários",
        flush=True,
    )
    empresa.criar_funcionarios(db, dados.funcionarios)
    m_impl = Metricas()
    _, implantacao = implantar(dados, m_impl, args.admin_senha)
    m_dia = Metricas()
    por_papel = entrar_todos(dados.funcionarios, m_dia)

    print(f"2/5 dia de operação: {args.ots} OTs, {args.retiradas} retiradas", flush=True)
    dia = Dia(por_papel, dados, m_dia, args.ots, args.retiradas, locais).rodar()
    ordens = dia.pop("ordens_com_estoque")
    print(f"    {dia['segundos']} s · {dia['contagem']}", flush=True)

    print("3/5 confrontos", flush=True)
    casos = confrontos(por_papel, dados, locais, ordens, m_dia, db)
    for c in casos:
        print(f"    {'OK    ' if c['ok'] else 'FALHOU'} {c['caso']}: {c['obtido']}", flush=True)

    print("4/5 escalada", flush=True)
    esc = escalada(
        por_papel,
        ordens,
        locais,
        [int(x) for x in args.patamares.split(",")],
        args.segundos,
        args.limite_p95,
    )

    print("5/5 conferência", flush=True)
    emails = esperar_emails(db)
    regras = invariantes.conferir(db)
    for x in regras:
        print(
            f"    {'OK    ' if not x['violacoes'] else 'FALHOU'} {x['regra']} ({x['violacoes']})",
            flush=True,
        )
    resultado = {
        "empresa": empresa.EMPRESA,
        "inicio": agora.isoformat(timespec="seconds"),
        "duracao_min": round((time.perf_counter() - inicio) / 60, 1),
        "ambiente": "local (Docker): API com 4 processos gunicorn, PostgreSQL 16, banco sea_carga",
        "porte": {**porte.__dict__, "linhas de OT": len(dados.reservas)},
        "implantacao": implantacao,
        "dia": dia,
        "metricas_dia": m_dia.resumo(),
        "confrontos": casos,
        "escalada": esc,
        "capacidade": capacidade(esc),
        "emails": emails,
        "invariantes": regras,
        "banco": invariantes.resumo_do_banco(db),
    }
    erros_dia = sum(x["erros_servidor"] for x in resultado["metricas_dia"])
    resultado["erros_servidor_no_dia"] = erros_dia
    resultado["aprovado"] = (
        all(c["ok"] for c in casos) and not any(x["violacoes"] for x in regras) and erros_dia == 0
    )
    RESULTADOS.mkdir(exist_ok=True)
    nome = agora.strftime("%Y-%m-%d_%H%M")
    (RESULTADOS / f"{nome}.json").write_text(
        json.dumps(resultado, ensure_ascii=False, indent=1, default=str), encoding="utf-8"
    )
    (RESULTADOS / f"{nome}.md").write_text(relatorio_md(resultado), encoding="utf-8")
    print(
        f"relatório: qa/carga/resultados/{nome}.md · "
        f"{'APROVADO' if resultado['aprovado'] else 'REPROVADO'}"
    )
    return 0 if resultado["aprovado"] else 1


if __name__ == "__main__":
    sys.exit(main())
