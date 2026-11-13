# SEA — Sistema de Expedição e Armazenamento

Protótipo. Usa somente **dados fictícios**. Licença Apache 2.0 (arquivos `LICENSE` e `NOTICE`).

## Executar localmente

Pré-requisito: Docker Desktop aberto.

```bash
cd sea
cp .env.example .env   # e gere os segredos indicados no README (primeira vez)
docker compose up -d
docker compose restart admin   # evita 502 no login quando a API sobe depois do painel
```

| Serviço | Endereço |
|---|---|
| Painel SEA | http://localhost:8080 |
| Terminal de retirada | http://localhost:8080/retirada/terminal |
| API | http://localhost:5000/api/health |
| E-mails enviados (Mailpit) | http://localhost:8025 |

Os serviços de integração do SEA (webhooks, publisher, snapshot) ficam desligados.
Para ligá-los: `docker compose --profile integracoes up -d`.

### Banco de dados

* Instalação nova: `db/schema.sql` já inclui as tabelas do SEA e `db/seed.sh` carrega
  `db/seed-sea.sql` (locais, endereços, materiais, ordens PM11/PM12 e usuários fictícios).
* Banco existente (atualização): aplique, nesta ordem,
  `db/migrations/082_sea.sql`, `db/migrations/083_sea_etiqueta.sql`,
  `db/migrations/084_sea_notificacoes.sql` e `db/seed-sea.sql`. Todos são idempotentes.

```bash
docker exec -i sea-db psql -U sea -d sea -v ON_ERROR_STOP=1 < db/migrations/082_sea.sql
docker exec -i sea-db psql -U sea -d sea -v ON_ERROR_STOP=1 < db/migrations/083_sea_etiqueta.sql
docker exec -i sea-db psql -U sea -d sea -v ON_ERROR_STOP=1 < db/migrations/084_sea_notificacoes.sql
docker exec -i sea-db psql -U sea -d sea -v ON_ERROR_STOP=1 < db/seed-sea.sql
```

### Usuários fictícios

| Usuário | Uso | Senha inicial |
|---|---|---|
| `admin` | administração | `admin` em instalação nova (troca obrigatória) |
| `almoxarife` | Expedição, Estoque, Retirada (painel e app) | `Sea@2026` (troca obrigatória) |
| `retirada` (ou `retirada@sea.example`) | funcionário de teste do terminal de retirada: solicita e confirma a retirada | `Sea@2026` |

### Locais

| Local (seletor da barra superior) | Endereços |
|---|---|
| `Expedição - Área da Expedição` | endereço único `EXPEDICAO` |
| `SP12 - Setor SP12 - Almoxarifado` | recebimento `SP12-RECEB` e prateleiras A0–C3 |
| `Solda - Contêiner de Solda` | recebimento `SOLDA-RECEB` e endereço geral `SOLDA` |

O material é recebido em um local e pode ser armazenado em outro: uma ordem recebida na
Expedição é armazenada nas prateleiras do SP12 ou no Contêiner de Solda. **Expedição >
Armazenagem** lista o que aguarda em todos os locais e oferece os endereços de todos eles
(agrupados por local). O estoque da ordem é localizado pelo número da OT em qualquer local;
a retirada entra na fila do local onde o material está armazenado. Os materiais de uma ordem
podem ficar em endereços e locais diferentes.

## Abas

| Aba | Função |
|---|---|
| Painel | Indicadores do SP12 e últimas movimentações |
| Estoque | Visão Geral (mapa de endereços, ordens PM11/PM12), Materiais (um por material de cada ordem), Endereços, Histórico |
| Expedição | Recebimento de Ordem (código de barras da OT), Armazenagem, Ordens |
| Retirada | Fila do almoxarife, histórico (entregues e canceladas) e terminal touchscreen |
| Sistema | Usuários (com e-mail), Configurações, Importação de dados |

O sino da barra superior mostra as notificações (retirada solicitada, recebimento,
armazenamento concluído) com aviso sonoro.

## Regras implementadas

* **OT** = pedido de compra do SEA com `order_type` PM11 ou PM12. O estoque recebido de uma
  OT recebe o número da OT como lote (`inventory.lot_number`), o que permite consultar o estoque
  por OT e rastrear cada unidade.
* **Armazenagem SP12** (validada na API em toda armazenagem de OT):
  * a ordem pode ser distribuída livremente por vários endereços;
  * materiais só dividem endereço se forem o mesmo material ou do mesmo grupo de compatibilidade;
  * endereços com classe de tamanho (A3 = `PEQUENO`, A2 = `GRANDE`) só recebem materiais da classe;
  * capacidade por endereço é opcional; em branco = não configurada (sem limite).
    Nenhuma capacidade numérica é inventada.
* **Retirada**: solicitada → em separação → pronta → entregue (ou cancelada).
  A solicitação **reserva** o saldo; a **baixa** só ocorre quando quem solicitou confirma o
  recebimento no terminal. Cada transição trava as linhas no banco e confere o status atual,
  impedindo baixa duplicada e retirada acima do saldo.
  * Toda solicitação fica registrada, mesmo a que não é executada: a cancelada permanece em
    **Retirada > Histórico** com quem cancelou, quando e o motivo.
  * O cancelamento exige motivo (a API recusa motivo em branco).
* **Identificação no terminal**: o terminal abre sempre na tela de login. O funcionário entra
  com o e-mail corporativo (ou usuário) e a senha, e a sessão termina ao fim da retirada.
  A sessão do terminal é própria (`admin/src/terminalApi.js`): não troca nem encerra a sessão
  do painel aberta no mesmo navegador.
  Enquanto o diretório da empresa não está integrado, o e-mail é o cadastrado em
  **Sistema > Usuários**. Ponto de integração: `api/services/identity_provider.py`
  (`SEA_IDENTITY_PROVIDER`, padrão `local`); nada do diretório corporativo foi presumido.
  O crachá RFID/NFC não é mais usado (a coluna `users.badge_uid` ficou sem uso).
* **SAP**: consulta simulada. As OTs são cadastradas no SEA (manual ou CSV).

## Recebimento por etiqueta da OT

A etiqueta que acompanha o material é registrada sobre as tabelas do SEA (migração `083`):

| Entidade | Tabela | Observação |
|---|---|---|
| Recebimento / OT | `purchase_orders` | OT = `po_number`; reserva, ordem de serviço (tipo `order_type` + número), datas, departamento, locais, solicitante e recebedor em colunas próprias |
| Material recebido | `purchase_order_lines` + `items` | um registro por material da OT, com lote, vencimento e unidade; `items` é o cadastro do material, compartilhado entre OTs |
| Armazenamento | `inventory` | endereço + OT (`lot_number` do estoque = número da OT) |
| Movimentações | `item_receipts`, `bin_transfers`, `withdrawals`, `audit_log` | consultadas juntas por material em `GET /api/sea/ots/<OT>` |

Fluxo em **Expedição > Recebimento**:

1. Leia o código de barras da OT. Se a OT não existir, o SEA oferece **Iniciar novo recebimento**.
2. Cole o texto da etiqueta e clique em **Interpretar etiqueta**: o formulário é preenchido.
   Campo não identificado fica **pendente** (nunca é preenchido por suposição); texto não
   reconhecido é guardado na OT para conferência; dados de impressão são descartados.
3. Confira, corrija e confirme. Outra etiqueta da mesma OT entra por **+ Adicionar material**;
   dados já cadastrados não são sobrescritos e divergências ficam registradas.
4. Receba (parcial ou integral), armazene e retire normalmente. **Detalhes** em cada material
   mostra lote, localização, saldo, quantidade retirada e todas as movimentações.

| Endpoint | Função |
|---|---|
| `GET /api/sea/recebimentos/consulta?codigo=` | a OT já está cadastrada? Se não, traz a OT da base do SAP |
| `POST /api/sea/etiquetas/interpretar` | texto da etiqueta → campos estruturados (não grava) |
| `POST /api/sea/recebimentos` | cria a OT (se nova) e cadastra os materiais |
| `PUT /api/sea/ots/<id>/dados` | corrige dados da OT |
| `PUT` / `DELETE /api/sea/ots/<id>/materiais/<linha>` | corrige ou remove um material (quantidade e remoção só antes do recebimento) |

Limites conhecidos do protótipo:

* a entrada da etiqueta é **texto** (colado ou digitado); não há OCR de foto;
* quantidades são **inteiras** (limite atual); etiqueta com quantidade fracionada fica pendente;
* cada OT tem **um registro por código de material**; o mesmo material com outro lote na mesma OT
  é recusado e sinalizado para conferência;
* o tipo da ordem de serviço (PM11/PM12) é obrigatório para criar a OT.

## Menu por local e exclusões

* A seção **Expedição** (recebimento, armazenagem, ordens, SAP) só aparece no menu com o local
  `Expedição` selecionado na barra superior; com SP12 ou Contêiner de Solda selecionado ela não é
  oferecida, e o endereço `/expedicao` volta para o Painel.
* **Excluir ordem** (Expedição > Ordens) e **excluir material** (Estoque > Materiais) são ações do
  administrador, com confirmação. A ordem é excluída com seus recebimentos, o estoque que veio
  dela, as movimentações e as retiradas; os materiais continuam no cadastro. O material é excluído
  do cadastro, das ordens, do estoque e das movimentações; uma ordem que fica sem materiais é
  excluída junto. O histórico de auditoria registra o que foi removido e por quem
  (`DELETE /api/sea/ots/<id>`, `DELETE /api/sea/materiais/<id>`).

* **Exportar CSV**: os botões "Exportar CSV" das listas aparecem para o administrador e para o
  usuário com a permissão extra `export-csv` (Sistema > Usuários > Permissões extras). O arquivo é
  montado no navegador com os dados que o usuário já vê na tela; a permissão controla o botão.
* **Cadastro de usuário**: o formulário lista o que falta ou está errado (campos obrigatórios,
  e-mail inválido, senha fraca com o motivo, local e acessos) antes de enviar.

* **Notificações**: clicar em uma notificação abre a tela relacionada; "Limpar notificações"
  esvazia a lista do próprio usuário (migração `086`; os registros continuam no banco).

* **Unidade e peso por caixa** (migração `087`): com unidade PC ou PAR, retirar 1 baixa 1 unidade.
  Um material em KG pode ter o **peso por caixa** no cadastro (Estoque > Materiais): o estoque
  continua em quilos e a retirada é feita por caixa inteira. Ex.: 36 KG em caixas de 18 KG são
  2 caixas; retirar 1 caixa baixa 18 KG. No terminal o seletor anda pelo peso da caixa
  (0 > 18 KG > 36 KG). A API recusa quantidade que não seja de caixas inteiras.

## Base do SAP

O SEA guarda um espelho dos dados que vêm do SAP (migração `085_sea_base_sap.sql`):

| Tabela | Conteúdo |
|---|---|
| `sap_orders` | ordens: número, tipo (PM11/PM12), descrição |
| `sap_materials` | materiais: código, descrição, unidade |
| `sap_reservations` | OTs / reservas abertas: OT, reserva, solicitante, data necessária |
| `sap_reservation_items` | materiais de cada OT: ordem, material, quantidade, unidade |

**Recebimento.** Ao ler o código de barras, o SEA procura a OT nesta base e mostra os materiais,
a ordem de cada um, as quantidades, as unidades e o solicitante. "Registrar entrega" cadastra a
OT exatamente como está na base (`POST /api/sea/recebimentos/base`; os dados são lidos da base no
servidor, nunca do navegador). O **recebedor** é sempre o usuário logado que registra a entrega;
não é digitado nem pode ser corrigido. Uma OT fora da base ainda pode ser cadastrada pela etiqueta.

Uma OT traz materiais de várias ordens: a ordem fica gravada em cada material da OT
(`purchase_order_lines.service_order_number` / `service_order_type`).

**Carga da base.** Em Sistema > Importação de dados há três importações (CSV ou JSON, com modelo
para baixar), nesta ordem: ordens, materiais, OTs / reservas (uma linha por material). Uma linha
já existente é atualizada; linhas com erro são listadas e as demais entram. A base é consultada
em Expedição > SAP. O banco de exemplo traz as OTs fictícias `1000000101` e `1000000102`.

| Endpoint | Função |
|---|---|
| `GET /api/sea/sap/base?q=` | totais e OTs da base com seus materiais |
| `POST /api/sea/sap/importar/<ordens\|materiais\|reservas>` | carrega a base (administrador ou permissão de importação) |
| `POST /api/sea/recebimentos/base` | registra a entrega de uma OT da base |

Limites: quantidades inteiras; um registro por material em cada OT (o mesmo material em duas
ordens da mesma OT é recusado na importação); a importação não remove da base o que saiu do SAP.

### Integração com o SAP

`api/services/ot_source.py` é o único ponto em que o recebimento consulta a origem de uma OT. A
fonte padrão (`SEA_OT_SOURCE=base`) é a base acima; `none` desliga a consulta. Uma integração ao
vivo pode (a) alimentar as tabelas `sap_*` ou (b) implementar `OtSource.lookup(db, codigo) ->
OtData` e registrar-se em `_SOURCES`. Nos dois casos recebimento, armazenagem e retirada não
mudam. Nenhum endpoint, credencial ou formato do SAP foi presumido.

## Notificações e e-mail

| Evento | Quando | Assunto do e-mail |
|---|---|---|
| Solicitação de retirada | uma retirada é solicitada no terminal | `SEA - Solicitação de Retirada` |
| Recebimento de materiais | materiais de uma ordem são recebidos | `SEA - Recebimento de Materiais na Expedição` |
| Conclusão de armazenamento | não resta material da ordem na área de recebimento | `SEA - Conclusão de Armazenamento` |

Cada evento grava uma linha em `sea_notifications` (migração `084`), aparece no sino do painel
com som e gera **um e-mail próprio** para os administradores ativos com e-mail cadastrado
(**Sistema > Usuários**). O envio é feito pelo worker Celery; a operação nunca espera o servidor
de e-mail. O painel mostra a situação de cada envio (enviado, na fila, falha, não configurado).

A pilha já sobe com um servidor de e-mail configurado: o **Mailpit** (serviço `mailpit` do
`docker-compose.yml`). Ele recebe todos os e-mails do SEA e os mostra em http://localhost:8025,
mas **não entrega para fora** (o e-mail não chega à caixa de entrada real do destinatário).

Para entregar de verdade, defina no `.env` o servidor SMTP da empresa ou de um provedor
(nenhum foi presumido):

| Variável | Uso | Padrão (Mailpit) |
|---|---|---|
| `SEA_SMTP_HOST` | servidor SMTP | `mailpit` |
| `SEA_SMTP_PORT` | porta | `1025` |
| `SEA_SMTP_USER` / `SEA_SMTP_PASSWORD` | credenciais, se o servidor exigir | vazio |
| `SEA_SMTP_FROM` | remetente | `sea@sea.local` |
| `SEA_SMTP_SECURITY` | `starttls`, `ssl` ou `none` | `none` |

Exemplo com Gmail (exige uma "senha de app" da conta): `SEA_SMTP_HOST=smtp.gmail.com`,
`SEA_SMTP_PORT=587`, `SEA_SMTP_SECURITY=starttls`, `SEA_SMTP_USER=<conta>`,
`SEA_SMTP_PASSWORD=<senha de app>`.

Depois de alterar o `.env`: `docker compose up -d api celery-worker`.

## Testes

```bash
# API (banco de testes separado)
docker compose run --rm --no-deps -v "$PWD/api:/app" api sh -c \
  'export TEST_DATABASE_URL="${DATABASE_URL%/*}/sea_test"; cd /app && python -m pytest tests/'
# Painel e app (dependências instaladas num volume do Docker)
docker run --rm -v "$PWD/admin:/app" -v sea_admin_nm:/app/node_modules -w /app node:20-alpine npx vitest run
docker run --rm -v "$PWD/mobile:/app" -v sea_mobile_nm:/app/node_modules -w /app node:20-alpine npx vitest run
```

Testes específicos do SEA: `api/tests/test_sea.py`, `api/tests/test_sea_etiqueta.py`,
`api/tests/test_sea_notificacoes.py` e `admin/src/test/sea.test.jsx`.
