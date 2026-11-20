# ruff: noqa: E501  (script de QA com SQL e JavaScript embutidos)
"""Usuários fictícios para os testes de QA (Newman e Playwright). Só para o ambiente local.

Rodar dentro do contêiner da API:
    docker compose exec -T api python - < qa/seed_qa.py

Cria (ou recria) os usuários qa.* com a senha QA_PASSWORD, sem troca obrigatória, com acesso a
todos os locais. Os que confirmam processos no painel ganham um "celular" cadastrado (token de
push fictício com a trava ligada), para os testes aprovarem pela API como o app faria.
"""

import os
import sys
import uuid

import bcrypt

sys.path.insert(0, "/app")
import models.database as database  # noqa: E402
from sqlalchemy import text  # noqa: E402

if os.environ.get("SEA_ENV", "").lower() == "production" or "azure" in os.environ.get("SEA_DOMAIN", ""):
    raise SystemExit("Seed de QA é só para o ambiente local.")

QA_PASSWORD = "Qa@12345"
USERS = {
    # usuário: (papel, páginas, tem celular)
    "qa.admin": ("ADMIN", [], True),
    "qa.oper": ("USER", ["receiving", "putaway", "purchase-orders", "inventory", "items", "bins"], True),
    "qa.avaliador": ("USER", ["retirada-avaliar"], True),
    "qa.almox": ("USER", ["retirada-fazer"], True),
    "qa.solic": ("USER", ["retirada"], False),
    "qa.terminal": ("USER", ["terminal-retirada"], False),
    "qa.gestor": ("USER", ["users"], True),
    "qa.semperm": ("USER", [], False),
}

db = database.SessionLocal()
warehouses = [r[0] for r in db.execute(text("SELECT warehouse_id FROM warehouses ORDER BY warehouse_id"))]
pw = bcrypt.hashpw(QA_PASSWORD.encode(), bcrypt.gensalt()).decode()
for username, (role, pages, phone) in USERS.items():
    uid = db.execute(text("SELECT user_id FROM users WHERE username = :u"), {"u": username}).scalar()
    if uid is None:
        uid = db.execute(
            text(
                """
                INSERT INTO users (username, password_hash, full_name, role, warehouse_id,
                                   warehouse_ids, external_id, must_change_password, email)
                VALUES (:u, :pw, :n, :r, :w, :ws, :ext, FALSE, :e) RETURNING user_id
                """
            ),
            {"u": username, "pw": pw, "n": f"QA {username[3:].title()} (fictício)", "r": role,
             "w": warehouses[0], "ws": warehouses, "ext": str(uuid.uuid4()),
             "e": f"{username}@qa.example"},
        ).scalar()
    else:
        db.execute(
            text("UPDATE users SET password_hash = :pw, role = :r, is_active = TRUE, "
                 "must_change_password = FALSE, warehouse_ids = :ws, web_login_approval = FALSE "
                 "WHERE user_id = :id"),
            {"pw": pw, "r": role, "ws": warehouses, "id": uid},
        )
    db.execute(text("DELETE FROM user_page_permissions WHERE user_id = :u"), {"u": uid})
    for page in pages:
        db.execute(text("INSERT INTO user_page_permissions (user_id, page_key) VALUES (:u, :p)"),
                   {"u": uid, "p": page})
    db.execute(text("DELETE FROM sea_push_tokens WHERE user_id = :u"), {"u": uid})
    if phone:
        db.execute(
            text("INSERT INTO sea_push_tokens (token, user_id, secure_lock) VALUES (:t, :u, TRUE)"),
            {"t": f"ExponentPushToken[{username}]", "u": uid},
        )
# Zera bloqueios de login de rodadas anteriores.
db.execute(text("DELETE FROM login_attempts WHERE key LIKE '%qa.%'"))
db.commit()
print("usuarios QA prontos:", ", ".join(USERS))
