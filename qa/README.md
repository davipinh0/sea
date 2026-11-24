# QA do SEA

Testes além dos unitários e de integração (`api/tests`, `admin/src/test`, `mobile/src/**/__tests__`).
Tudo roda **só no ambiente local** (`docker compose up -d`), com usuários fictícios.

## 1. Usuários de QA

```sh
docker compose exec -T api python - < qa/seed_qa.py
```

Cria os usuários `qa.*` (senha `Qa@12345`), cada um com um papel: admin, operador, avaliador,
almoxarife, solicitante, usuário do terminal, gestor de usuários e sem permissão. Os que confirmam
processos ganham um "celular" fictício cadastrado. Rodar de novo zera o estado deles.

## 2. API: coleção do Postman (Newman)

`qa/postman/SEA-API.postman_collection.json` (gerada por `build_collection.py`) com o ambiente
`SEA-local.postman_environment.json`. Pode ser importada no Postman ou rodada com o Newman:

```sh
docker run --rm --network sea_default -v "$PWD/qa/postman:/etc/newman" -w /etc/newman node:20-alpine \
  sh -c "npm i -g newman@6 && newman run SEA-API.postman_collection.json -e SEA-local.postman_environment.json --env-var base_url=http://admin:8080"
```

Cobre: cabeçalhos de segurança, login e sessão (token adulterado, token depois de sair), permissões
de cada papel, validação de entrada (injeção de SQL, quantidade negativa, e-mail inválido, fórmula
de planilha) e o fluxo completo com uma OT nova a cada execução: base do SAP → registro → recebimento
parcial → armazenagem → retirada por caixa → avaliação → separação → entrega → baixa → histórico.

## 3. Navegador: Playwright

```sh
docker run --rm --network sea_default --ipc=host -e BASE_URL=http://admin:8080 \
  -v "$PWD/qa/e2e:/e2e" -w /e2e mcr.microsoft.com/playwright:v1.49.1-jammy \
  sh -c "npm i && npx playwright test"
```

Relatório em `qa/e2e/relatorio/index.html`. Cobre: login e sessão, menu por permissão, usuário do
terminal, liberação pelo celular, tema escuro, terminal com e-mail corporativo, exclusão de usuário
com confirmação no celular, XSS guardado (texto com HTML nunca roda) e acessibilidade com axe
(regras WCAG A/AA, erros graves e críticos) no login, Painel, Usuários, Retirada e terminal.

Antes de rodar depois de mudar o painel: `docker compose build admin && docker compose up -d admin`
(o contêiner serve o build, não o código).

## 4. Simulação de carga e concorrência (empresa de grande porte)

```sh
sh qa/carga/rodar.sh
```

Simula um dia de uma usina fictícia de grande porte num ambiente isolado (banco `sea_carga`):
implantação da base do SAP, 800 OTs recebidas e armazenadas, 500 retiradas do terminal até a entrega,
consultas do painel o tempo todo, confrontos (muitas pessoas disputando a última unidade, a mesma
retirada, a mesma OT, a mesma entrega) e uma escalada de 5 a 400 usuários simultâneos até o limite.
No fim confere o banco (estoque nunca negativo, nada some, uma entrega um registro, log íntegro) e
grava o relatório em `qa/carga/resultados/`. Detalhes em `qa/carga/README.md`. Substitui o antigo
`qa/concorrencia.py`, cujos quatro casos estão nos confrontos.

## 5. Outras verificações feitas no QA

- Dependências: `pip-audit -r api/requirements.txt` e `npm audit --omit=dev` (painel e app).
- Banco novo: `db/schema.sql` + migrações 082–099 duas vezes seguidas + `db/seed-sea.sql`.
- Backup: `pg_dump -Fc` restaurado num banco novo, contagens conferidas e
  `SELECT verify_audit_log_chain();` (NULL = corrente do log íntegra).
