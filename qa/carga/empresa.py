"""Empresa FICTÍCIA de grande porte para a simulação de carga do SEA.

"Siderúrgica Aurora S.A." não existe: nomes, códigos de material, ordens, OTs e funcionários são
gerados aqui, com semente fixa, para cada execução ser comparável com a anterior. O porte imita uma
usina integrada (milhares de materiais de manutenção, centenas de ordens PM11/PM12 por dia).
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field

import bcrypt
from sqlalchemy import text

EMPRESA = "Siderúrgica Aurora S.A. (fictícia)"
SENHA = "Carga@2026"  # só do ambiente local da simulação
SEMENTE = 2026

FAMILIAS = [
    # (descrição, unidade, kg por caixa ou None)
    ("Rolamento rígido de esferas", "PC", None),
    ("Parafuso sextavado M16", "PC", None),
    ("Luva de raspa", "PAR", None),
    ("Disco de corte 7 pol", "PC", None),
    ("Eletrodo E7018 3,25 mm", "KG", 18),
    ("Filtro hidráulico", "PC", None),
    ("Correia em V", "PC", None),
    ("Válvula esfera 2 pol", "PC", None),
    ("Mangueira hidráulica 1/2 pol", "PC", None),
    ("Junta de vedação", "PC", None),
    ("Contator tripolar", "PC", None),
    ("Relé térmico", "PC", None),
    ("Graxa de lítio", "KG", 20),
    ("Arame de solda MIG 1,2 mm", "KG", 15),
    ("Bota de segurança", "PAR", None),
    ("Capacete classe B", "PC", None),
    ("Chapa de desgaste", "PC", None),
    ("Tinta epóxi", "PC", None),
    ("Sensor indutivo", "PC", None),
    ("Acoplamento elástico", "PC", None),
]
NOMES = [
    "Ana",
    "Bruno",
    "Carla",
    "Diego",
    "Elisa",
    "Fábio",
    "Gabriela",
    "Hugo",
    "Íris",
    "João",
    "Karina",
    "Lucas",
    "Marina",
    "Nelson",
    "Olívia",
    "Paulo",
    "Quésia",
    "Rafael",
    "Sílvia",
    "Tiago",
    "Úrsula",
    "Vítor",
    "Wanda",
    "Xavier",
    "Yara",
    "Zeca",
]
SOBRENOMES = [
    "Almeida",
    "Barros",
    "Cardoso",
    "Duarte",
    "Esteves",
    "Ferraz",
    "Gomes",
    "Henriques",
    "Lacerda",
    "Monteiro",
    "Nogueira",
    "Pacheco",
    "Queiroz",
    "Rezende",
    "Siqueira",
    "Teixeira",
    "Valadares",
]


@dataclass
class Porte:
    """Volumes de um dia de usina. ``escala`` multiplica tudo (1 = porte padrão)."""

    materiais: int = 3000
    ordens: int = 1500
    ots: int = 1200
    recebedores: int = 25
    avaliadores: int = 10
    almoxarifes: int = 20
    solicitantes: int = 60
    consultores: int = 15

    @classmethod
    def com_escala(cls, escala: float) -> Porte:
        base = cls()
        return cls(**{k: max(1, int(v * escala)) for k, v in base.__dict__.items()})


@dataclass
class Funcionario:
    username: str
    papel: str
    nome: str


@dataclass
class Dados:
    materiais: list[dict] = field(default_factory=list)
    ordens: list[dict] = field(default_factory=list)
    reservas: list[dict] = field(default_factory=list)
    funcionarios: list[Funcionario] = field(default_factory=list)


PAPEIS = {
    # papel: (páginas do painel, funções do app)
    "recebedor": (["receiving", "putaway", "purchase-orders"], ["receive", "putaway"]),
    "avaliador": (["retirada-avaliar"], []),
    "almoxarife": (["retirada-fazer"], []),
    "solicitante": (["retirada"], []),
    "consultor": (["inventory", "purchase-orders", "audit-log", "items"], []),
}


def gerar(porte: Porte) -> Dados:
    rnd = random.Random(SEMENTE)
    dados = Dados()
    for i in range(porte.materiais):
        desc, uom, caixa = FAMILIAS[i % len(FAMILIAS)]
        dados.materiais.append(
            {
                "material_code": f"AUR-{100000 + i}",
                "description": f"{desc} ref. {i:04d}",
                "uom": uom,
                **({"pack_weight_kg": caixa} if caixa else {}),
            }
        )
    for i in range(porte.ordens):
        dados.ordens.append(
            {
                "order_number": f"40{10000000 + i}",
                "order_type": "PM11" if i % 3 else "PM12",
                "description": f"Manutenção {'preventiva' if i % 3 else 'corretiva'} "
                f"- linha {i % 40:02d}",
            }
        )
    caixa_de = {m["material_code"]: m.get("pack_weight_kg") for m in dados.materiais}
    for i in range(porte.ots):
        ot = f"90{10000000 + i}"
        ordem = dados.ordens[rnd.randrange(len(dados.ordens))]["order_number"]
        solicitante = f"{rnd.choice(NOMES)} {rnd.choice(SOBRENOMES)}"
        for code in rnd.sample([m["material_code"] for m in dados.materiais], rnd.randint(1, 6)):
            caixa = caixa_de[code]
            qtd = caixa * rnd.randint(1, 4) if caixa else rnd.randint(2, 40)
            dados.reservas.append(
                {
                    "ot_number": ot,
                    "order_number": ordem,
                    "material_code": code,
                    "quantity": qtd,
                    "requester_name": solicitante,
                    "reservation_number": f"R{7000000 + i}",
                }
            )
    for papel, quantos in (
        ("recebedor", porte.recebedores),
        ("avaliador", porte.avaliadores),
        ("almoxarife", porte.almoxarifes),
        ("solicitante", porte.solicitantes),
        ("consultor", porte.consultores),
    ):
        for i in range(quantos):
            nome = f"{NOMES[(i * 7) % len(NOMES)]} {SOBRENOMES[(i * 5) % len(SOBRENOMES)]}"
            dados.funcionarios.append(Funcionario(f"aurora.{papel}.{i:03d}", papel, nome))
    return dados


def criar_funcionarios(db, funcionarios: list[Funcionario]) -> None:
    """Cadastro direto no banco da simulação (o cadastro de usuários não é o que se mede aqui)."""
    hash_ = bcrypt.hashpw(SENHA.encode(), bcrypt.gensalt()).decode()
    locais = [r[0] for r in db.execute(text("SELECT warehouse_id FROM warehouses ORDER BY 1"))]
    for f in funcionarios:
        paginas, funcoes = PAPEIS[f.papel]
        uid = db.execute(
            text("""
                INSERT INTO users (username, password_hash, full_name, role, warehouse_id,
                                   warehouse_ids, allowed_functions, must_change_password,
                                   external_id, email)
                VALUES (:u, :h, :n, 'USER', :w, :ws, :fn, FALSE, :ext, :e)
                ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
                RETURNING user_id
            """),
            {
                "u": f.username,
                "h": hash_,
                "n": f"{f.nome} ({f.papel}, fictício)",
                "w": locais[0],
                "ws": locais,
                "fn": funcoes,
                "ext": str(uuid.uuid4()),
                "e": f"{f.username}@aurora.example",
            },
        ).scalar()
        for pagina in paginas:
            db.execute(
                text(
                    "INSERT INTO user_page_permissions (user_id, page_key) VALUES (:u, :p) "
                    "ON CONFLICT DO NOTHING"
                ),
                {"u": uid, "p": pagina},
            )
    # Os avisos por e-mail vão para os administradores com e-mail: o da simulação recebe no Mailpit.
    db.execute(text("UPDATE users SET email = 'gestao@aurora.example' WHERE username = 'admin'"))
    db.commit()
