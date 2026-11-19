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
| `SP13 - Setor SP13 - Almoxarifado` | recebimento `SP13-RECEB` e endereço geral `SP13` (até a migração `090`, "Solda - Contêiner de Solda") |

O material é recebido em um local e pode ser armazenado em outro: uma ordem recebida na
Expedição é armazenada nas prateleiras do SP12 ou no SP13. **Expedição >
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
  * prateleiras livres: qualquer material, de qualquer ordem, em qualquer quantidade.
* **Retirada** (migração `096`): solicitada → **avaliada** (aprovada ou negada com motivo) →
  aceita por quem faz a retirada (em separação) → pronta → entregue (ou cancelada). Três
  permissões em **Sistema > Usuários**: **Solicitar retirada** (terminal), **Avaliar retirada**
  (aprovar ou negar) e **Fazer retirada** (aceitar e separar). Quem já tinha "Retirada" recebeu
  também "Fazer retirada". O avaliador é avisado de cada solicitação; aprovada, os usuários com
  "Fazer retirada" são avisados; quem aceitar aparece com **nome e foto** no terminal enquanto
  prepara o material. Negada, a reserva é desfeita e o terminal mostra o motivo.
  A solicitação **reserva** o saldo; a **baixa** só ocorre quando quem solicitou confirma o
  recebimento no terminal. Cada transição trava as linhas no banco e confere o status atual,
  impedindo baixa duplicada e retirada acima do saldo.
  * Toda solicitação fica registrada, mesmo a que não é executada: a cancelada permanece em
    **Retirada > Histórico** com quem cancelou, quando e o motivo.
  * O cancelamento exige motivo (a API recusa motivo em branco).
* **Usuário do terminal** (migração `098`): o terminal abre com um usuário que tem só a
  permissão **Terminal de retirada** (a API recusa somar outras). Ele entra no painel, vê apenas
  **Retirada > Abrir terminal de retirada** e não sai por inatividade (o token ainda expira em 8 h).
  O botão do terminal saiu da aba Retirada dos demais usuários.
* **Identificação no terminal**: o terminal abre sempre na escolha **Tenho acesso ao SEA** /
  **Não tenho acesso ao SEA**. Com acesso, o funcionário entra com o e-mail corporativo (ou
  usuário) e a senha, e a sessão termina ao fim da retirada. Sem acesso, informa só o e-mail
  corporativo: o pedido é feito pelo usuário do terminal em nome desse e-mail
  (`withdrawals.requester_email`), e a entrega é confirmada no próprio terminal.
* **Quem aceitou acompanha** (migração `098`): depois que alguém aceita a retirada, só essa pessoa
  dá andamento (marcar pronta; cancelar, além do solicitante e do administrador) e só ela recebe
  avisos dessa retirada; para os demais os avisos somem e fica o registro. Se o solicitante
  cancelar, quem aceitou recebe **Retirada cancelada**.
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
  `Expedição` selecionado na barra superior; com SP12 ou SP13 selecionado ela não é
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
  2 caixas; retirar 1 caixa baixa 18 KG. No recebimento pela etiqueta, ao informar a unidade KG o
  formulário pergunta os **KG por caixa** e completa o cadastro do material. No terminal o seletor anda pelo peso da caixa
  (0 > 18 KG > 36 KG). A API recusa quantidade que não seja de caixas inteiras.

* **Transferência entre endereços**: em Estoque > Materiais, ao abrir um material, "Localizações
  no estoque" traz o botão **Transferir** em cada endereço. O destino pode ser outra prateleira
  do mesmo local (A1 para B2) ou outro local (SP12 para o SP13). Só o saldo livre
  se move (o que está reservado para retirada fica); valem as regras de armazenagem e, para
  material com peso por caixa, caixas inteiras (`POST /api/sea/transferencias`).

* **Terminal e locais**: no terminal a ordem traz o material de **qualquer local** (SP12,
  SP13), mesmo que o funcionário não trabalhe nele. A solicitação vai para a fila
  do local que guarda o material; separar é dos usuários daquele local, e confirmar ou cancelar
  é de quem solicitou.

* **Cadastro de materiais** (Sistema, permissão própria; migração `088`): criar, alterar e excluir
  os materiais consultados ao montar uma OT. Ao informar o código (na aba SAP > Nova OT ou no
  recebimento pela etiqueta) o SEA traz descrição, unidade e peso por caixa.
* **Nova OT** (Expedição > SAP): monta uma OT na base com materiais do cadastro; ela passa a ser
  encontrada no recebimento como as que vêm do SAP.
* **Prateleiras**: todas são `GRANDE`, que aceita material de qualquer tamanho; `PEQUENO` fica
  restrito a material pequeno.
* **Atualização automática**: as telas do painel se atualizam após qualquer mudança feita nele e
  a cada 10 segundos, sem sair e voltar.

* **Tema escuro**: no painel, o botão de lua/sol na barra superior (a escolha fica no navegador;
  sem escolha, segue o sistema). No app, menu do usuário > Tema (Sistema, Claro, Escuro).
* **Contador do Receber**: conta as ordens que ainda não tiveram nada recebido; uma ordem
  recebida em parte sai do contador e continua na lista "aguardando recebimento".
* **Textos das notificações** citam a unidade do material (ex.: "18 KG de 1 material(is)").

* **Ordem em primeiro lugar**: o material é identificado pela **Ordem** (PM11/PM12); a OT é o
  documento com que ele chegou e aparece como referência. Estoque > Visão Geral lista uma linha por
  ordem (`GET /api/sea/ordens`), e Armazenagem, Transferência, Retirada e notificações citam a ordem.
* **Prateleiras livres** (migração `089`): qualquer material, de qualquer ordem, em qualquer
  quantidade. Classe de tamanho, capacidade e compatibilidade deixaram de ser aplicadas; só a área
  de recebimento e um endereço inativo são recusados como destino.
* **Histórico de auditoria**: ação e entidade aparecem em português.

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

## App mobile

App Android (Expo / React Native) em `mobile/`, para celular comum: os códigos são digitados ou
lidos com a **câmera**. Usa a mesma API do painel.

**iOS**: o projeto já está configurado (`ios.bundleIdentifier` `br.sea.prototipo`, Face ID, câmera,
avisos). O perfil `ios-simulator` do `eas.json` gera o app para o simulador sem conta Apple. Para
instalar em iPhone (perfil `preview`, distribuição interna) é preciso uma conta **Apple Developer**:
rode `eas device:create` para cadastrar os iPhones e depois `eas build -p ios --profile preview`
em modo interativo, entrando com a conta Apple (certificado e perfil ficam no Expo). Os avisos com o
app fechado no iPhone usam a chave APNs, que o EAS cria na mesma etapa.

| Módulo | O que faz | Quem vê |
|---|---|---|
| Receber | lê a OT; se ela está só na base do SAP, mostra os materiais e registra a entrega; recebe parcial ou integral | local Expedição; permissão Recebimento (ou módulo "Receber") |
| Armazenar | lista o que aguarda em todos os locais e guarda em qualquer prateleira (sugestão, lista ou código do endereço) | local Expedição; permissão Armazenagem (ou módulo "Armazenagem") |
| Retirada | avaliar (aprovar/negar), aceitar e separar, pronta para entrega, cancelar com motivo | Solicitar, Avaliar ou Fazer retirada |
| Histórico | movimentações do local e log completo do SEA | admin ou permissão Histórico |
| Transferir | busca o material e move entre endereços ou locais | permissão Materiais, Visão Geral ou Armazenagem |

O funcionário continua solicitando e confirmando a retirada no terminal (painel web).

**Digital ou PIN antes de cada processo:** no app, abrir uma OT para receber, escolher onde
armazenar um material e cada passo da retirada (avaliar, aceitar, pronta) pedem a digital ou a
senha do celular (PIN ou padrão).

**Processos do painel web liberados pelo celular** (migração `095`, `api/services/step_up.py`):
no painel web, **Recebimento**, **Armazenagem** e **Retirada** só abrem depois de confirmados no
app SEA do celular cadastrado: o painel envia o pedido, o celular recebe o push "Liberar ... no
painel", o usuário confirma com a digital/PIN e a tela abre. A liberação vale para aquela sessão do
painel e termina após 15 minutos sem uso (aí o painel pede de novo). Sem celular cadastrado o
processo fica bloqueado. A API exige a liberação nas rotas do processo (`403 step_up_required`);
o app e o terminal (token Bearer) não passam por essa trava, porque o app pede a digital/PIN.

**Últimas movimentações e Histórico** (migração `094`): as movimentações do Painel aparecem só
para administradores e quem tem a permissão **Histórico**. **Ocultar** recolhe a lista neste
navegador; **Limpar** recomeça a lista só para quem limpou (nada é apagado do histórico; "Mostrar
tudo de novo" desfaz).

**Lote do material** (migração `097`): a planilha de OTs / reservas da base do SAP traz o lote de
cada material (coluna `lot_number` ou `lote`). Ao registrar a entrega pela base, o lote segue para o
material da ordem e aparece na coluna **Lote** (painel: recebimento, base do SAP e detalhe da OT;
app: Receber e Ordens).

**Recebimento parcial** (migração `098`): quando chega só parte da OT (por exemplo, o material de
uma das ordens), o que chegou é registrado normalmente e a OT fica em **Recebimento parcial** até o
restante chegar. As listas de ordens mostram "OT em recebimento parcial: falta(m) N material(is)"
também nas ordens que já chegaram inteiras.

**KG por caixa** (migração `098`): o peso da caixa do **Cadastro de materiais** (ou da planilha de
materiais, coluna `pack_weight_kg` / `kg_por_caixa`) passa para o material do estoque, e a OT que
entra pela base do SAP leva esse peso. Antes, só a OT digitada pela etiqueta levava o peso, e a
retirada desses materiais não andava por caixa.

**Prateleiras do SP13** (migração `098`): o SP13 recebeu os mesmos endereços de armazenagem do SP12,
com o mesmo código (A0, B1…); o código de barras impresso leva o prefixo (`SP13-A0`). Um código
sem prefixo vai para o local selecionado.

**Atualizar no app**: em todas as telas de dados, puxar a tela para baixo recarrega na hora.

**Foto do usuário:** o painel lê a foto escolhida como `data:` (a política de segurança do site
bloqueia `blob:`, o que impedia a foto de ser salva).

Além desses, o app tem **Estoque** (o que há em cada endereço), **Ordens** (consulta de OTs e
materiais) e **Notificações**. As telas se atualizam sozinhas e o layout se ajusta à tela do
aparelho. Ícone e abertura usam a marca do SEA (`mobile/assets/make_icons.py` gera as imagens).

**Bloqueio por digital** (`mobile/src/auth/appLock.js`, `mobile/src/components/AppLock.js`):

- No primeiro login com senha de um usuário naquele celular, o app pede para ativar o bloqueio
  (obrigatório): com a digital ou, se o celular não tem digital, com a senha do celular (PIN, padrão
  ou senha de desbloqueio). Celular sem nenhum bloqueio de tela precisa configurar um antes de usar
  o app. Entrar com outro usuário no mesmo celular pede uma nova ativação.
- Ao ir para segundo plano ou ser fechado, o app bloqueia. A tela de bloqueio cobre as telas sem
  desmontá-las: o que estava em andamento (tela, códigos lidos, quantidades) continua após o
  desbloqueio. Janelas de permissão do próprio app (câmera, notificações) não bloqueiam.
- Desbloqueio pela digital ou pela senha da conta (conferida no servidor; senha errada mantém o
  bloqueio sem encerrar a sessão). "Sair da conta" encerra a sessão.
- A sessão continua expirando em 8 horas; depois disso o login volta a ser com senha.

**Login confirmado no celular** (migração `092`, `api/services/login_approval.py`):

- Parâmetro por usuário em Sistema > Usuários: **Confirmar login no celular**. A tela também lista os
  celulares cadastrados do usuário (sem mostrar o token) e tem **Remover celulares** para aparelho
  perdido ou trocado.
- Celular cadastrado = app SEA com o bloqueio ativo (digital ou PIN/padrão); o app informa isso ao
  registrar o aparelho. Ao sair do app, o celular deixa de receber os avisos do dia a dia, mas continua
  cadastrado para confirmar logins.
- Com o parâmetro ligado e um celular cadastrado, o login com senha em qualquer outro lugar (painel web,
  terminal de retirada, outro celular) responde `202` com uma tentativa pendente: o celular recebe o
  push "Tentativa de login no SEA", o usuário entra no app (login normal) e vê **Você está entrando no
  SEA?**, com origem, horário e IP. **Sim, sou eu** pede a digital ou o PIN do celular; **Não, negar**
  recusa. O painel/terminal acompanha em `POST /api/auth/login/aprovacao` com um segredo que só ele tem;
  aprovada, a sessão abre uma única vez. Prazo: 2 minutos.
- O login no próprio celular cadastrado não pede confirmação (o app envia o token do aparelho).
- Desbloquear o app com a senha do SEA também não pede confirmação: o app já tem a sessão aberta do
  mesmo usuário (vale mesmo para o APK 16).
- Se o único celular cadastrado não conseguir entrar, outro administrador desliga o parâmetro do
  usuário ou remove os celulares dele. A auditoria "Login aguardando o celular" mostra se o app
  informou o aparelho (`aparelho_informado`).
- Sem celular cadastrado, o login segue só com a senha mesmo com o parâmetro ligado.
- Auditoria: "Login aguardando o celular", "Login confirmado/negado no celular", mudança do parâmetro e
  remoção de celulares. Reinstalar o app troca o token do aparelho: se o celular antigo era o único
  cadastrado, um administrador remove os celulares do usuário e ele cadastra de novo.

**Sessão do painel web** (migração `093`, `api/services/web_sessions.py`,
`admin/src/utils/sessionGuard.js`):

- Cada login abre uma sessão registrada no servidor (`sea_sessions`, pelo `jti` do token). **Sair**
  encerra a sessão no servidor: uma cópia do cookie ou do token deixa de valer na hora. Vale também
  para o terminal de retirada e para o app.
- O cookie do painel é de sessão do navegador: fechar o navegador apaga o cookie.
- A sessão pertence à aba que fez o login. Uma aba nova, o navegador reaberto ou uma aba
  restaurada só continua logada se outra aba do painel estiver aberta; senão a sessão é encerrada
  e aparece o login. Sair em uma aba tira todas as abas do painel.
- Inatividade: 15 minutos sem usar mouse/teclado no painel encerram a sessão ("Sua sessão foi
  encerrada por inatividade"). O servidor também encerra a sessão do painel que fica 15 minutos sem
  nenhuma requisição (por exemplo, navegador fechado); ajuste com `SEA_WEB_IDLE_MINUTES`.
- O app não sai por inatividade: ele tem o bloqueio por digital/PIN. O terminal de retirada volta
  ao login após 2 minutos sem uso enquanto o funcionário ainda não pediu material.

**Foto do usuário** (migração `091`): só o administrador coloca, troca ou remove, em
Sistema > Usuários (editar o usuário). O painel corta a foto em quadrado e reduz para 256 px (JPEG)
antes de enviar; a API aceita só JPG, PNG ou WEBP (conferido pelo conteúdo) de até 1 MB e registra a
troca na auditoria ("Foto do usuário"). A foto aparece na lista de usuários, na barra superior do
painel e no app (cabeçalho e menu). Cada usuário vê a própria; quem gerencia usuários vê todas.

**Servidor no app.** O endereço do servidor não aparece em nenhuma tela. Só um administrador o
altera (tela de login > "Servidor (administrador)" ou menu do usuário > Servidor), confirmando com
usuário e senha válidos no novo endereço. O APK já sai com o endereço de `eas.json`
(`EXPO_PUBLIC_API_URL`).

**Notificações no celular.** Com o app aberto, ele consulta a API e mostra os avisos novos como
notificação do aparelho. Com o app **fechado**, o aviso depende do serviço de push do Expo/Google:
(1) criar um projeto no Firebase e enviar a chave ao Expo (`eas credentials`, Android > FCM V1),
colocando o `google-services.json` em `mobile/`; (2) definir `SEA_PUSH=expo` no `.env`. Com isso o
título e o texto de cada aviso passam pelos servidores do Expo e do Google; por isso vem desligado.

**Servidor.** O celular acessa o painel pela rede: defina `ADMIN_BIND_HOST=0.0.0.0` no `.env`,
recrie os serviços e informe no app (tela de login, "URL do servidor") `http://IP-DO-COMPUTADOR:8080`.

**Rodar e gerar.** Em `mobile/`: `npm install`; `npm test` (testes); `npx expo start` (abrir no
celular com o Expo Go); `npx eas-cli login`, `npx eas-cli init` e `npm run build:apk` (gerar o APK).

## Notificações e e-mail

| Evento | Quando | Assunto do e-mail |
|---|---|---|
| Solicitação de retirada | uma retirada é solicitada no terminal (avisa quem avalia) | `SEA - Solicitação de Retirada` |
| Retirada aprovada | o avaliador aprova (avisa quem faz a retirada) | `SEA - Retirada Aprovada` |
| Retirada cancelada | o solicitante cancela uma retirada já aceita (avisa só quem aceitou) | `SEA - Retirada Cancelada` |
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

## Hospedagem no Azure

Uma VM Linux (Ubuntu 24.04, 2 vCPU, 4 GB) roda o mesmo `docker compose` do ambiente local.
Em produção: VM `SEA` (grupo `SEA_group`, East US), endereço
`https://sea-expedicao.eastus.cloudapp.azure.com`, usuário de implantação `seaadmin`
(chave `~/.ssh/sea_azure`). Arquivos em `deploy/azure/`:

| Arquivo | Função |
|---|---|
| `provision.sh <rótulo>` | cria grupo `rg-sea`, VM `vm-sea`, IP com DNS `<rótulo>.centralus.cloudapp.azure.com` e firewall (80/443 abertas; SSH só do IP de quem provisionou) |
| `cloud-init.yml` | prepara a VM: Docker, atualizações automáticas, 2 GB de troca, backup diário |
| `prepare-vm.sh` | a mesma preparação para uma VM criada pelo portal: `ssh seaadmin@<domínio> 'sh -s' < deploy/azure/prepare-vm.sh` |
| `deploy.sh <domínio> [dump]` | envia o último commit para a VM e sobe o sistema; com um `.dump`, restaura o banco |
| `setup-server.sh` | na VM: cria o `.env` com senhas aleatórias (só na VM), aplica as migrações do SEA e sobe tudo |
| `docker-compose.azure.yml` + `Caddyfile` | Caddy com HTTPS automático (Let's Encrypt) na frente da API e do painel |
| `configure-smtp.sh` | na VM: pergunta servidor, usuário e senha de e-mail (a senha não aparece nem sai da VM), grava `SEA_SMTP_*` no `.env`, reinicia a API e testa o login: `ssh -t -i ~/.ssh/sea_azure seaadmin@<domínio> 'sh /opt/sea/deploy/azure/configure-smtp.sh'` |
| `backup.sh` | `pg_dump` diário às 03:00 UTC em `/var/backups/sea`, guardando 14 dias |

API, painel, banco, Redis e Mailpit só escutam no `127.0.0.1` da VM; a única entrada é o Caddy.
Atualizar o sistema: `git commit` e `sh deploy/azure/deploy.sh sea-expedicao.eastus.cloudapp.azure.com`
(sem o dump, o banco da VM é mantido). Se o IP deste PC mudar, a regra `ssh-admin` do
grupo de segurança `SEA-nsg` precisa do IP novo.
O Mailpit não entrega e-mail para fora: para e-mails reais, configure `SEA_SMTP_*` no `.env` da VM.
