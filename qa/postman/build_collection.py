# ruff: noqa: E501  (script de QA com SQL e JavaScript embutidos)
"""Gera a coleção do Postman do SEA (qa/postman/SEA-API.postman_collection.json).

    python qa/postman/build_collection.py

Rodar com o Newman (ou importar no Postman, junto com SEA-local.postman_environment.json):
    newman run qa/postman/SEA-API.postman_collection.json -e qa/postman/SEA-local.postman_environment.json
Os usuários qa.* vêm de qa/seed_qa.py (só ambiente local).
"""

import json
from pathlib import Path

HERE = Path(__file__).parent


def req(name, method, path, *, token=None, body=None, tests="", pre=""):
    headers = [{"key": "Content-Type", "value": "application/json"}]
    if token:
        headers.append({"key": "Authorization", "value": "Bearer {{" + token + "}}"})
    item = {
        "name": name,
        "request": {
            "method": method,
            "header": headers,
            "url": {"raw": "{{base_url}}" + path, "host": ["{{base_url}}"],
                    "path": [p for p in path.split("?")[0].split("/") if p],
                    **({"query": [{"key": k, "value": v} for k, v in
                                  (q.split("=", 1) for q in path.split("?", 1)[1].split("&"))]}
                       if "?" in path else {})},
        },
        "event": [],
    }
    if body is not None:
        item["request"]["body"] = {"mode": "raw", "raw": json.dumps(body, ensure_ascii=False)
                                   if not isinstance(body, str) else body}
    if pre:
        item["event"].append({"listen": "prerequest", "script": {"exec": pre.strip().split("\n")}})
    if tests:
        item["event"].append({"listen": "test", "script": {"exec": tests.strip().split("\n")}})
    return item


def status(code, label=None):
    return f"pm.test('{label or 'status ' + str(code)}', () => pm.response.to.have.status({code}));"


def login(user, var):
    return req(f"Login {user}", "POST", "/api/auth/login",
               body={"username": user, "password": "{{qa_password}}"},
               tests=f"""
{status(200)}
const b = pm.response.json();
pm.test('traz o token', () => pm.expect(b.token).to.be.a('string'));
pm.collectionVariables.set('{var}', b.token);
""")


folders = []

# 1. Saúde, cabeçalhos e CORS ------------------------------------------
folders.append({"name": "1. Saúde e cabeçalhos de segurança", "item": [
    req("Health", "GET", "/api/health", tests=f"""
{status(200)}
pm.test('responde rápido (< 1 s)', () => pm.expect(pm.response.responseTime).to.be.below(1000));
"""),
    req("Cabeçalhos de segurança", "GET", "/", tests="""
pm.test('CSP presente', () => pm.expect(pm.response.headers.get('Content-Security-Policy')).to.include("default-src 'self'"));
pm.test('não pode ser embutido (X-Frame-Options)', () => pm.expect(pm.response.headers.get('X-Frame-Options')).to.eql('DENY'));
pm.test('nosniff', () => pm.expect(pm.response.headers.get('X-Content-Type-Options')).to.eql('nosniff'));
pm.test('index.html não fica em cache', () => pm.expect(String(pm.response.headers.get('Cache-Control'))).to.match(/no-cache|no-store/));
"""),
]})

# 2. Autenticação e sessão ----------------------------------------------
folders.append({"name": "2. Autenticação e sessão", "item": [
    # Antes de qualquer login: o Newman guarda os cookies e os mandaria junto.
    req("Sem token", "GET", "/api/auth/me", tests=status(401)),
    req("Senha errada: mensagem genérica", "POST", "/api/auth/login",
        body={"username": "qa.admin", "password": "errada"}, tests=f"""
{status(401)}
pm.test('não diz se o usuário existe', () => pm.expect(pm.response.text()).to.not.match(/não existe|not found|usuário inválido/i));
"""),
    req("Usuário inexistente: mesma resposta", "POST", "/api/auth/login",
        body={"username": "qa.ninguem", "password": "x"}, tests=status(401)),
    req("Corpo inválido", "POST", "/api/auth/login", body="{nao e json", tests="""
pm.test('recusa sem erro 500', () => pm.expect(pm.response.code).to.be.within(400, 499));
"""),
    login("qa.admin", "t_admin"),
    req("Quem sou eu (com token)", "GET", "/api/auth/me", token="t_admin", tests=f"""
{status(200)}
pm.test('é o qa.admin', () => pm.expect(pm.response.json().username).to.eql('qa.admin'));
pm.test('não devolve o hash da senha', () => pm.expect(pm.response.text()).to.not.include('password_hash'));
"""),
    req("Token adulterado", "GET", "/api/auth/me", token="t_fake",
        pre="pm.collectionVariables.set('t_fake', pm.collectionVariables.get('t_admin').slice(0, -4) + 'AAAA');",
        tests=status(401)),
    login("qa.semperm", "t_tmp"),
    req("Sair encerra a sessão", "POST", "/api/auth/logout", token="t_tmp", body={}, tests=status(200)),
    req("Token depois de sair não vale", "GET", "/api/auth/me", token="t_tmp", tests=status(401)),
]})

# 3. Permissões -----------------------------------------------------------
login_items = [login(u, v) for u, v in (
    ("qa.semperm", "t_semperm"), ("qa.solic", "t_solic"), ("qa.avaliador", "t_avaliador"),
    ("qa.almox", "t_almox"), ("qa.terminal", "t_terminal"), ("qa.oper", "t_oper"),
    ("qa.gestor", "t_gestor"))]
folders.append({"name": "3. Permissões (autorização)", "item": login_items + [
    req("Sem permissão: fila de retirada", "GET", "/api/sea/retiradas", token="t_semperm", tests=status(403)),
    req("Sem permissão: usuários", "GET", "/api/admin/users", token="t_semperm", tests=status(403)),
    req("Solicitante não lista usuários", "GET", "/api/admin/users", token="t_solic", tests=status(403)),
    req("Solicitante não importa base do SAP", "POST", "/api/sea/sap/importar/ordens", token="t_solic",
        body={"records": [{"order_number": "1", "order_type": "PM11"}]}, tests=status(403)),
    req("Terminal não lista a fila", "GET", "/api/sea/retiradas", token="t_terminal", tests=status(403)),
    req("Terminal não abre usuários", "GET", "/api/admin/users", token="t_terminal", tests=status(403)),
    req("Gestor não troca a própria permissão para admin", "PUT", "/api/admin/users/{{qa_gestor_id}}",
        token="t_gestor", body={"role": "ADMIN"},
        pre="""
const me = pm.collectionVariables.get('qa_gestor_id');
if (!me) { pm.sendRequest({url: pm.environment.get('base_url') + '/api/auth/me', header: {Authorization: 'Bearer ' + pm.collectionVariables.get('t_gestor')}}, (e, r) => pm.collectionVariables.set('qa_gestor_id', r.json().user_id)); }
""",
        tests="""
pm.test('não vira administrador', () => pm.expect(pm.response.code).to.be.oneOf([400, 403]));
"""),
    req("Usuário do terminal não ganha outras permissões", "PUT", "/api/admin/users/{{qa_terminal_id}}/permissions",
        token="t_admin", body={"page_keys": ["terminal-retirada", "users"]},
        pre="""
pm.sendRequest({url: pm.environment.get('base_url') + '/api/auth/me', header: {Authorization: 'Bearer ' + pm.collectionVariables.get('t_terminal')}}, (e, r) => pm.collectionVariables.set('qa_terminal_id', r.json().user_id));
""",
        tests=status(400)),
]})

# 4. Validação de entrada ---------------------------------------------------
folders.append({"name": "4. Validação de entrada", "item": [
    req("Ordem com injeção de SQL", "GET", "/api/sea/ordens/1'%20OR%20'1'='1", token="t_solic", tests="""
pm.test('não quebra (404, nunca 500)', () => pm.expect(pm.response.code).to.eql(404));
"""),
    req("Retirada com quantidade negativa", "POST", "/api/sea/retiradas", token="t_solic",
        body={"ot": "X", "lines": [{"inventory_id": 1, "quantity": -5}]}, tests=status(400)),
    req("Retirada sem linhas", "POST", "/api/sea/retiradas", token="t_solic",
        body={"ot": "X", "lines": []}, tests=status(400)),
    req("Terminal: e-mail inválido", "POST", "/api/sea/retiradas", token="t_terminal",
        body={"ot": "X", "lines": [{"inventory_id": 1, "quantity": 1}], "requester_email": "sem-arroba"},
        tests=status(400)),
    req("Terminal: sem e-mail", "POST", "/api/sea/retiradas", token="t_terminal",
        body={"ot": "X", "lines": [{"inventory_id": 1, "quantity": 1}]}, tests=status(400)),
    req("Base do SAP: fórmula de planilha recusada", "POST", "/api/sea/sap/importar/materiais", token="t_admin",
        body={"records": [{"material_code": "QA-FORMULA", "description": "=HYPERLINK(\"http://x\")", "uom": "PC"}]},
        tests="""
pm.test('a linha com fórmula é rejeitada', () => pm.expect(pm.response.json().errors.length).to.be.above(0));
"""),
    req("Texto enorme no motivo", "POST", "/api/sea/retiradas/999999/cancelar", token="t_admin",
        body={"reason": "x" * 5000}, tests="""
pm.test('recusa sem erro 500', () => pm.expect(pm.response.code).to.be.within(400, 499));
"""),
]})

# 5. Fluxo completo ---------------------------------------------------------
setup_vars = """
const n = String(Date.now()).slice(-9);
pm.collectionVariables.set('ot', '7' + n);
pm.collectionVariables.set('ordem', '8' + n);
pm.collectionVariables.set('material', 'QA' + n);
"""
flow = [
    req("Base: ordem", "POST", "/api/sea/sap/importar/ordens", token="t_admin", pre=setup_vars,
        body='{"records": [{"order_number": "{{ordem}}", "order_type": "PM12"}]}',
        tests=f"{status(200)}\npm.test('sem erros', () => pm.expect(pm.response.json().errors).to.eql([]));"),
    req("Base: material (KG, caixa de 18)", "POST", "/api/sea/sap/importar/materiais", token="t_admin",
        body='{"records": [{"material_code": "{{material}}", "description": "Arame QA (fictício)", "uom": "KG", "pack_weight_kg": 18}]}',
        tests=f"{status(200)}\npm.test('sem erros', () => pm.expect(pm.response.json().errors).to.eql([]));"),
    req("Base: OT com 54 KG", "POST", "/api/sea/sap/importar/reservas", token="t_admin",
        body='{"records": [{"ot_number": "{{ot}}", "order_number": "{{ordem}}", "material_code": "{{material}}", "quantity": 54, "lot_number": "LQA-1", "requester_name": "Solicitante QA"}]}',
        tests=f"{status(200)}\npm.test('sem erros', () => pm.expect(pm.response.json().errors).to.eql([]));"),
    req("Consulta: OT na base do SAP", "GET", "/api/sea/recebimentos/consulta?codigo={{ot}}", token="t_oper",
        tests=f"""
{status(200)}
const m = pm.response.json().integration.data.materials[0];
pm.test('traz lote e peso da caixa', () => {{ pm.expect(m.lot_number).to.eql('LQA-1'); pm.expect(m.pack_weight_kg).to.eql(18); }});
"""),
    req("Registrar a entrega (Expedição)", "POST", "/api/sea/recebimentos/base", token="t_oper",
        body='{"warehouse_id": {{expedicao_id}}, "ot_code": "{{ot}}"}',
        tests=f"{status(201)}\npm.collectionVariables.set('po_id', pm.response.json().po_id);"),
    req("Registrar de novo é recusado", "POST", "/api/sea/recebimentos/base", token="t_oper",
        body='{"warehouse_id": {{expedicao_id}}, "ot_code": "{{ot}}"}', tests=status(409)),
    req("Área de recebimento", "GET", "/api/sea/recebimentos/areas?warehouse_id={{expedicao_id}}", token="t_oper",
        tests=f"{status(200)}\npm.collectionVariables.set('area_id', pm.response.json().bins[0].bin_id);"),
    req("Linhas da OT", "GET", "/api/receiving/po/{{ot}}", token="t_oper", tests=f"""
{status(200)}
const l = pm.response.json().lines[0];
pm.collectionVariables.set('item_id', l.item_id);
pm.test('54 a receber', () => pm.expect(l.quantity_remaining).to.eql(54));
"""),
    req("Receber 36 (parcial)", "POST", "/api/receiving/receive", token="t_oper",
        body='{"po_id": {{po_id}}, "items": [{"item_id": {{item_id}}, "quantity": 36, "bin_id": {{area_id}}}]}',
        tests=status(200)),
    req("OT em recebimento parcial", "GET", "/api/sea/ordens?warehouse_id={{expedicao_id}}&q={{ot}}", token="t_oper",
        tests=f"""
{status(200)}
const o = pm.response.json().orders[0];
pm.test('status parcial', () => pm.expect(o.status).to.eql('PARTIAL'));
"""),
    req("Receber mais que o previsto é recusado", "POST", "/api/receiving/receive", token="t_oper",
        body='{"po_id": {{po_id}}, "items": [{"item_id": {{item_id}}, "quantity": 999, "bin_id": {{area_id}}}]}',
        tests="pm.test('recusado', () => pm.expect(pm.response.code).to.be.within(400, 499));"),
    req("Pendente de armazenagem", "GET", "/api/sea/armazenagem/pendentes", token="t_oper", tests=f"""
{status(200)}
const p = pm.response.json().pending_items.find(x => x.lot_number === pm.collectionVariables.get('ot'));
pm.test('o material espera armazenagem', () => pm.expect(p).to.be.an('object'));
pm.collectionVariables.set('from_bin', p.bin_id);
pm.test('peso da caixa chegou ao estoque', () => pm.expect(p.pack_weight_kg).to.eql(18));
"""),
    req("Destinos", "GET", "/api/sea/armazenagem/destinos", token="t_oper", tests=f"""
{status(200)}
const b = pm.response.json().bins.find(x => x.warehouse_code === 'SP12');
pm.collectionVariables.set('to_bin', b.bin_id);
"""),
    req("Armazenar 36 no SP12", "POST", "/api/putaway/confirm", token="t_oper",
        body='{"item_id": {{item_id}}, "from_bin_id": {{from_bin}}, "to_bin_id": {{to_bin}}, "quantity": 36, "lot_number": "{{ot}}"}',
        tests=status(200)),
    req("Terminal: estoque da ordem", "GET", "/api/sea/ordens/{{ordem}}", token="t_solic", tests=f"""
{status(200)}
const s = pm.response.json().stock[0];
pm.collectionVariables.set('inv_id', s.inventory_id);
pm.test('36 disponíveis, caixa de 18', () => {{ pm.expect(s.available).to.eql(36); pm.expect(s.pack_weight_kg).to.eql(18); }});
"""),
    req("Pedir 10 KG (não é caixa inteira)", "POST", "/api/sea/retiradas", token="t_solic",
        body='{"ot": "{{ot}}", "lines": [{"inventory_id": {{inv_id}}, "quantity": 10}]}', tests=status(400)),
    req("Pedir 1 caixa (18 KG)", "POST", "/api/sea/retiradas", token="t_solic",
        body='{"ot": "{{ot}}", "lines": [{"inventory_id": {{inv_id}}, "quantity": 18}]}', tests=f"""
{status(201)}
pm.collectionVariables.set('wid', pm.response.json().withdrawal.withdrawal_id);
pm.test('aguarda avaliação', () => pm.expect(pm.response.json().withdrawal.status).to.eql('REQUESTED'));
"""),
    req("Almoxarife não avalia", "POST", "/api/sea/retiradas/{{wid}}/avaliar", token="t_almox",
        body={"approve": True}, tests=status(403)),
    req("Separar antes de aprovar é recusado", "POST", "/api/sea/retiradas/{{wid}}/separar", token="t_almox",
        body={}, tests=status(409)),
    req("Negar sem motivo é recusado", "POST", "/api/sea/retiradas/{{wid}}/avaliar", token="t_avaliador",
        body={"approve": False}, tests=status(400)),
    req("Avaliador aprova", "POST", "/api/sea/retiradas/{{wid}}/avaliar", token="t_avaliador",
        body={"approve": True}, tests=status(200)),
    req("Avaliar de novo é recusado", "POST", "/api/sea/retiradas/{{wid}}/avaliar", token="t_avaliador",
        body={"approve": True}, tests=status(409)),
    req("Almoxarife aceita", "POST", "/api/sea/retiradas/{{wid}}/separar", token="t_almox", body={},
        tests=status(200)),
    req("Terminal vê quem aceitou", "GET", "/api/sea/retiradas/{{wid}}/responsavel", token="t_solic",
        tests=f"{status(200)}\npm.test('tem nome', () => pm.expect(pm.response.json().name).to.include('QA'));"),
    req("Outro usuário não marca pronta", "POST", "/api/sea/retiradas/{{wid}}/pronta", token="t_admin",
        body={}, tests=status(403)),
    req("Entregar antes de pronta é recusado", "POST", "/api/sea/retiradas/{{wid}}/entregar", token="t_solic",
        body={}, tests=status(409)),
    req("Almoxarife marca pronta", "POST", "/api/sea/retiradas/{{wid}}/pronta", token="t_almox", body={},
        tests=status(200)),
    req("Outra pessoa não recebe a entrega", "POST", "/api/sea/retiradas/{{wid}}/entregar", token="t_admin",
        body={}, tests="pm.test('recusado', () => pm.expect(pm.response.code).to.be.oneOf([403, 404]));"),
    req("Solicitante confirma o recebimento", "POST", "/api/sea/retiradas/{{wid}}/entregar", token="t_solic",
        body={}, tests=f"{status(200)}\npm.test('entregue', () => pm.expect(pm.response.json().withdrawal.status).to.eql('DELIVERED'));"),
    req("Confirmar de novo não baixa duas vezes", "POST", "/api/sea/retiradas/{{wid}}/entregar", token="t_solic",
        body={}, tests=status(409)),
    req("Estoque depois da baixa", "GET", "/api/sea/ordens/{{ordem}}", token="t_solic", tests=f"""
{status(200)}
pm.test('sobraram 18 KG', () => pm.expect(pm.response.json().stock[0].available).to.eql(18));
"""),
    req("Histórico mostra a ordem, não a OT", "GET", "/api/sea/historico?warehouse_id={{sp12_id}}&limit=50", token="t_admin",
        tests=f"""
{status(200)}
const m = pm.response.json().movements.find(x => x.action_type === 'WITHDRAWAL_DELIVERED' && x.entity_id == pm.collectionVariables.get('wid'));
pm.test('a entrega tem a ordem', () => pm.expect(m.orders[0]).to.eql('PM12 - ' + pm.collectionVariables.get('ordem')));
"""),
]
folders.append({"name": "5. Fluxo completo: OT → recebimento → armazenagem → retirada", "item": flow})

collection = {
    "info": {"name": "SEA - API (QA)", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
             "description": "Testes de contrato, segurança e fluxo do SEA. Só ambiente local, usuários de qa/seed_qa.py."},
    "item": folders,
    "variable": [],
}
(HERE / "SEA-API.postman_collection.json").write_text(json.dumps(collection, ensure_ascii=False, indent=1),
                                                      encoding="utf-8")
env = {"name": "SEA local", "values": [
    {"key": "base_url", "value": "http://localhost:8080", "enabled": True},
    {"key": "qa_password", "value": "Qa@12345", "enabled": True},
    {"key": "expedicao_id", "value": "1", "enabled": True},
    {"key": "sp12_id", "value": "2", "enabled": True},
]}
(HERE / "SEA-local.postman_environment.json").write_text(json.dumps(env, ensure_ascii=False, indent=1),
                                                         encoding="utf-8")
print("coleção:", sum(len(f["item"]) for f in folders), "requisições")
