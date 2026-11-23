# SEA - Sistema de Entrada e Armazenamento

Situação: protótipo em funcionamento, com dados fictícios. Novembro de 2026.

---

## 1. Resumo

O SEA controla o caminho do material desde a chegada até a entrega a quem pediu:

```
Chegada da OT  →  Recebimento  →  Armazenagem  →  Pedido de retirada  →  Avaliação  →  Separação  →  Entrega
 (Expedição)       (app/painel)    (SP12/SP13)      (terminal)            (avaliador)    (almoxarife)   (baixa)
```

Ele roda em três frentes:
- **Painel web**, no navegador, para gestão.
- **App Android**, para quem opera no chão: lê os códigos de barras com a câmera.
- **Terminal de retirada** em tela de toque, onde o funcionário pede o material.

Tudo fica registrado: quem fez, quando, em qual ordem (PM11/PM12) e se a pessoa confirmou a identidade.

O protótipo está publicado no Azure e funciona do começo ao fim, mas só com **dados fictícios**. Para entrar em produção faltam:
- infraestrutura da empresa (conta, domínio, backup externo);
- integração real com o SAP e com o login corporativo;
- dados reais (endereços, materiais, usuários);
- um piloto com usuários reais.

---

## 2. Por que foi desenvolvido

| Problema no processo atual | Como o SEA trata |
|---|---|
| Não se sabe com certeza o que chegou de cada OT nem de qual ordem. | O recebimento registra material por material, com lote. Quando chega só parte da OT, ela fica em "Recebimento parcial". |
| É difícil saber onde o material foi guardado. | A armazenagem registra o endereço (prateleira) e o sistema sugere um destino. Estoque por endereço no SP12 e no SP13. |
| A retirada é informal: falta o registro de quem pediu, quem aprovou e quem entregou. | O pedido é feito no terminal, passa por um avaliador e é separado por um almoxarife, que aparece com nome e foto. A baixa só acontece quando quem pediu confirma o recebimento. |
| Não há rastro das operações. | Log de auditoria à prova de alteração: o banco não permite editar nem apagar, e cada registro é encadeado com o anterior por hash. |
| Os avisos dependem de alguém lembrar de avisar. | Notificações automáticas no celular e por e-mail, para cada etapa e só para quem atua nela. |

---

## 3. Como foi desenvolvido

- **Base de código aberto:** o SEA parte do **Sentry WMS**, um sistema de armazém de código aberto (licença Apache 2.0, autor hightower-systems). A licença permite uso comercial e modificação, desde que se mantenham os avisos de autoria (arquivos `LICENSE` e `NOTICE`).
- **Adaptação:** a base foi adaptada ao processo da Expedição:
  - OTs com ordens PM11/PM12;
  - os locais Expedição, SP12 e SP13;
  - base do SAP e retirada com avaliação;
  - app próprio e terminal de retirada.
- **Ferramentas:** o painel foi feito em React, servido pelo Nginx; a API foi feita em Python com Flask, tendo o PostgreSQL como banco de dados. Foi usada IA para aplicar correções em algumas linhas e arquivos e para os testes. Nenhuma mudança é publicada sem passar pelos testes automatizados.
- **Testes automatizados** (todos passando na versão atual):

  | Parte | Testes |
  |---|---|
  | API | cerca de 3.180 |
  | Painel | 183 |
  | App | 70 |

- **Versionamento:** Git, no repositório privado `davipinh0/sea`. Cada mudança de banco é uma migração numerada que pode ser executada de novo sem efeito colateral. A versão atual é a 098.
- **Publicação:** um script de deploy envia a versão, aplica as migrações e reinicia os serviços. O app Android é gerado pelo Expo EAS, um serviço de build na nuvem.

---

## 4. Arquitetura

```
  Celular Android (app SEA)        Navegador (painel web)        Terminal de retirada
            │                                │                       (tela de toque)
            └───────────────── HTTPS (TLS) ──┴─────────────────────────────┘
                                             │
                                 ┌───────────▼───────────┐
                                 │ Caddy (proxy reverso) │  certificado Let's Encrypt automático
                                 └───────────┬───────────┘
                         ┌───────────────────┼───────────────────┐
                ┌────────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
                │ Painel (React,  │  │ API (Python /  │  │ Worker Celery  │
                │ Nginx)          │  │ Flask)         │  │ (e-mail, push) │
                └─────────────────┘  └───┬────────┬───┘  └───────┬────────┘
                                         │        │              │
                                ┌────────▼───┐  ┌─▼──────────────▼─┐
                                │ PostgreSQL │  │ Redis (fila)     │
                                │ 16         │  └──────────────────┘
                                └────────────┘
            Tudo em contêineres Docker, numa máquina virtual Linux no Azure.
```

| Camada | Tecnologia | Observação |
|---|---|---|
| Banco | PostgreSQL 16 | Todas as regras de estoque são garantidas com travas no banco. |
| API | Python 3, Flask, SQLAlchemy, Pydantic | Valida toda entrada. A consulta ao SAP fica em um único ponto (`ot_source`). |
| Tarefas | Celery + Redis | E-mails e notificações no celular, sem travar a operação. |
| Painel | React 19 + Vite | Modo claro e escuro. Exporta CSV conforme a permissão. |
| App | React Native (Expo SDK 54) | Android. Lê códigos de barras com a câmera e trava o app com digital/PIN. |
| Hospedagem | Azure VM Standard_B2s (2 vCPU, 4 GB), Ubuntu 24.04, Docker Compose | Um único servidor. Backup diário do banco. |

**Pontos de integração já preparados:**
- **SAP:** hoje a base do SAP (ordens, materiais e reservas) é importada por planilha. Quem fizer a integração implementa uma única interface (`api/services/ot_source.py`) e liga por configuração. O resto do sistema não muda.
- **Login corporativo:** a identificação no terminal passa por `api/services/identity_provider.py`, pronto para trocar a senha local pelo diretório da empresa (Microsoft Entra ID / AD).

---

## 5. O que o sistema faz hoje

- **Recebimento:**
  - lê a OT;
  - se ela está na base do SAP, mostra os materiais, as ordens, os lotes e quem pediu;
  - recebe material por material, inteiro ou em parte; o que não chegou fica em "Recebimento parcial".
- **Armazenagem:**
  - lista o que espera na área de recebimento;
  - sugere a prateleira, respeitando capacidade, tamanho e mistura de materiais.
- **Estoque:** por local e endereço, com transferências entre endereços e locais.
- **Retirada:**
  - o pedido é feito no terminal, com o login do SEA ou, para quem não tem acesso, só com o e-mail corporativo;
  - o avaliador aprova ou nega, com motivo;
  - quem aceita a separação passa a acompanhar sozinho o pedido;
  - a baixa no estoque acontece quando quem pediu confirma no terminal;
  - o material vendido em KG sai por caixa.
- **Permissões:** separadas por tela e por local, com perfis como avaliar retirada, fazer retirada e usuário só do terminal.
- **Histórico e log:** mostram cada operação com a ordem, quem fez e se a pessoa confirmou a identidade.
- **Notificações:** no celular e por e-mail, para cada etapa, só para quem precisa agir.

---

## 6. Segurança e criptografia

### Em trânsito
- Todo acesso é **HTTPS (TLS)**, com certificado renovado automaticamente.
- O navegador fica obrigado a usar HTTPS por um ano (HSTS).
- O painel tem uma política de segurança de conteúdo restritiva (CSP): só carrega código do próprio site e não pode ser embutido em outras páginas.

### Senhas, sessões e acesso
- **Senhas:**
  - guardadas com **bcrypt** (hash lento e com sal); o sistema não guarda a senha em si;
  - mínimo de 8 caracteres, com letra e número;
  - troca obrigatória no primeiro acesso.
- **Bloqueio:** a conta é bloqueada por 15 minutos após várias tentativas de login erradas.
- **Sessão:**
  - token **JWT assinado (HS256)**, que vale 8 horas;
  - no painel ele fica num cookie que o JavaScript não lê (HttpOnly), com proteção contra requisições forjadas (CSRF);
  - toda sessão também fica registrada no servidor: ao sair, ela termina de fato, e uma cópia do token deixa de funcionar;
  - o painel sai sozinho depois de **15 minutos sem uso**.
- **Confirmação no celular** (dois fatores, opcional por usuário): um login no painel ou no terminal pode exigir aprovação no app do celular do próprio usuário.
- **Processos sensíveis** (recebimento, armazenagem e retirada):
  - no **painel**, só funcionam depois de liberados no celular cadastrado;
  - no **app**, pedem a digital ou o PIN do aparelho;
  - o log registra "Usuário autenticado" e como a confirmação foi feita. A do painel é garantida pelo servidor. A do app é informada pelo próprio app, porque o servidor não tem como verificar a trava do celular.
- **Permissões** por tela e por local. A API recusa qualquer acesso fora da permissão, mesmo que alguém digite o endereço direto.

### Dados guardados
- **Log de auditoria à prova de alteração:** o banco não permite alterar nem apagar registros. Cada linha leva um hash **SHA-256** encadeado com a anterior, então qualquer alteração por fora quebra a cadeia e é detectada.
- **Credenciais de integração** (segredos de webhooks, por exemplo): cifradas com **Fernet**, que usa AES-128 e HMAC-SHA256. A chave fica só no servidor.
- **No celular:** o token fica no armazenamento seguro do Android (Keystore), nunca em texto puro, e o app trava com digital/PIN.
- **Senhas e chaves do servidor:** geradas na própria máquina, ficam só nela (arquivo `.env`) e não vão para o repositório.
- **Disco:** os discos gerenciados do Azure já são cifrados pela plataforma.

### Pontos de atenção (para avaliação da TI)
- **Notificações no celular:** passam pelo serviço Expo / Google FCM, então o título e o texto do aviso saem para esses serviços. Pode ser desligado, e aí o app consulta a própria API.
- **Login corporativo e e-mail corporativo:** ainda não integrados (hoje o usuário é local).
- **Backup:** fica na mesma máquina. Falta uma cópia externa e um teste periódico de restauração.
- **Proteção externa:** não há firewall de aplicação (WAF) nem teste de invasão (pentest) independente.
- **LGPD:** o sistema guarda nome, e-mail e foto de funcionários. Precisa de aviso de privacidade e aval do jurídico.

---

## 7. Comparação com o SmartBee e outras opções

O **SmartBee** (smartbee.group, sede na China) fornece **máquinas de dispensação industrial**:
- torres de gavetas, carrosséis, armários com travas e balanças;
- para ferramentas, EPIs e material de manutenção;
- com uma plataforma na nuvem de monitoramento, controle de acesso e relatórios de consumo.

O site não divulga preços nem diz se há representante no Brasil; isso precisa ser levantado com o fornecedor.

| Critério | SEA | SmartBee (dispensação automática) | WMS de mercado / SAP EWM | Planilha / papel |
|---|---|---|---|---|
| O que resolve | Fluxo inteiro: OT → recebimento → endereço → retirada aprovada → baixa | Entrega automática do item ao funcionário, no ponto de uso | Armazém completo, multi-site | Registro manual |
| Hardware | Celular Android comum, PC com tela de toque, impressora de etiquetas | Máquinas próprias (investimento alto por máquina) | Coletores, impressoras | Nenhum |
| Aderência ao processo da Expedição (OT, PM11/PM12, SP12/SP13) | Feito para ele | Genérico (catálogo de itens) | Configurável, com projeto de implantação | Total, mas sem controle |
| Fluxo de aprovação da retirada | Sim (avaliador, separador, confirmação de quem pediu) | Acesso controlado por crachá; aprovação depende do produto | Configurável | Não |
| Integração SAP | Ponto pronto; falta implementar | Normalmente por projeto | Nativa (EWM) | Não |
| Onde ficam os dados | Servidor escolhido pela empresa (Azure da Ternium) | Nuvem do fornecedor | SAP da empresa | Arquivos locais |
| Custo de licença | Nenhum (código próprio, base Apache 2.0) | Compra ou locação das máquinas + assinatura (sob consulta) | Licença + implantação (alto) | Nenhum |
| Dependência | Equipe interna (hoje uma pessoa) | Fornecedor | Fornecedor / consultoria | Pessoas |

As opções não se excluem. O SmartBee entrega um item no ponto de uso, sem atendente; o SEA controla o fluxo do material desde a chegada da OT. Para insumos de solda e ferramentaria, um caminho possível é **o SEA como sistema de controle, com uma máquina de dispensação nos pontos de maior giro**, ligadas por integração.

---

## 8. Custos prováveis

### Infraestrutura mensal (estimativa, em dólares)

| Item | Custo estimado | Observação |
|---|---|---|
| Máquina virtual Azure B2s (Linux) | cerca de **US$ 30/mês** sob demanda, cerca de US$ 17,50/mês com reserva de 1 ano | preço de tabela East US; impostos e descontos da empresa não incluídos |
| Disco de 64 GB + IP público + tráfego | poucos dólares por mês | conforme a calculadora do Azure |
| Backup externo (Azure Storage) | cerca de US$ 1 a 5/mês | banco atual com cerca de 0,3 MB por backup |
| Domínio próprio | cerca de US$ 10 a 20/ano | ou um subdomínio da empresa, sem custo |
| Build do app (Expo EAS) | US$ 0 no plano gratuito | planos pagos a partir de cerca de US$ 19/mês para builds mais rápidos |
| Notificações (Expo / FCM) | US$ 0 | |
| **Total da infraestrutura** | **cerca de US$ 35 a 60/mês** | |

### Investimento inicial (hardware)
- **Terminal:** um PC com tela de toque por ponto de retirada. Pode ser um computador que já existe, com monitor touch.
- **Celulares Android** para quem recebe e armazena. Podem ser aparelhos de entrada ou os que já existem.
- **Impressora de etiquetas** para as prateleiras.

### Custos operacionais (o maior custo não é de nuvem)
- **Manutenção e evolução:** hoje uma pessoa. É o principal risco e precisa de um responsável na TI.
- **Suporte aos usuários e treinamento:** principalmente no piloto.
- **Rotina:** atualizações de segurança (o servidor já se atualiza sozinho), conferência do backup e cadastro de usuários e materiais.

A título de comparação, uma única máquina de dispensação automática ou uma licença de WMS de mercado costumam custar muitas vezes o custo anual estimado da infraestrutura do SEA. Os valores do SmartBee são sob consulta.

---

## 9. Pontos positivos e negativos

### Positivos
- **Feito para o processo da Expedição:** OT, PM11/PM12, SP12/SP13, aprovação da retirada.
- **Custo baixo:** sem licença e com infraestrutura de algumas dezenas de dólares por mês.
- **Rastreabilidade completa:** log à prova de alteração, com quem fez, quando, em qual ordem e se confirmou a identidade.
- **Segurança acima do comum** para um sistema interno: dois fatores pelo celular, sessões encerráveis, confirmação por digital/PIN, criptografia em trânsito e nas credenciais.
- **Hardware simples:** celular comum e navegador; não exige coletor dedicado.
- **Código próprio e testado:** cerca de 3.400 testes automatizados, e a empresa controla o código e os dados.
- **Pronto para integrar:** SAP e login corporativo têm um ponto de entrada definido.

### Negativos e riscos
- **Uma pessoa só:** o conhecimento está concentrado no desenvolvedor. Precisa de documentação de passagem e de mais um responsável.
- **Ainda é protótipo:** dados fictícios, sem piloto com usuários reais.
- **Integrações por fazer:** SAP (hoje por planilha), login e e-mail corporativos.
- **Um único servidor:** se a máquina cair, o sistema para. O backup ainda fica nela, sem cópia externa.
- **Só Android:** iOS foi deixado de lado; exigiria conta Apple Developer.
- **Distribuição do app:** o app é instalado à mão (APK). Em escala, precisa da loja gerenciada da empresa ou de um gerenciador de celulares (MDM).
- **Quantidades inteiras:** quantidade fracionada (KG quebrado, por exemplo) ainda não é aceita.
- **Avaliação independente:** sem pentest nem revisão de segurança feita por terceiros.

---

## 10. Atualizações futuras

| Frente | O que acrescentar |
|---|---|
| **Insumos de solda** | Consumo por ordem e por equipe, mínimo e máximo por local, aviso de reposição, controle de lote e validade (eletrodos, arames, gases) e retirada por caixa ou peso. Boa parte já existe: KG por caixa, lote e validade no recebimento. |
| **Ferramentaria** | Empréstimo e **devolução** com prazo, responsável pela ferramenta, histórico de uso, controle de calibração e manutenção, e alerta de ferramenta não devolvida. |
| **EPIs** | Entrega por funcionário, com troca periódica e assinatura no terminal. |
| **Integração SAP** | Consulta direta das OTs e reservas e retorno das baixas, substituindo a planilha. |
| **Login corporativo** | Entrada com o usuário da empresa (Microsoft Entra ID / SSO) no painel, no app e no terminal. |
| **Máquinas de dispensação** | Integração com dispensadores automáticos (tipo SmartBee) nos pontos de maior giro. |
| **Gestão** | Painéis de consumo, giro de estoque, tempo de atendimento das retiradas e relatórios por centro de custo. |
| **Escala** | Outros almoxarifados e unidades, servidor com alta disponibilidade e app pela loja gerenciada. |

---

## 11. O que é preciso para ir para produção

1. **Hospedagem na conta Azure da empresa**, com domínio próprio, gerida pela TI.
2. **Backup externo diário** (Azure Storage) e teste de restauração.
3. **Monitoramento** com alerta de indisponibilidade.
4. **Dados reais:** endereços do SP12/SP13, cadastro de materiais e usuários; limpeza dos dados fictícios.
5. **Integrações:** login corporativo, e-mail corporativo e SAP.
6. **Segurança:**
   - revisão pela TI ou pentest;
   - aviso de privacidade (LGPD);
   - um segundo administrador.
7. **Distribuição do app** pela loja gerenciada da empresa ou por MDM.
8. **Piloto** de 2 a 4 semanas com uma equipe pequena; depois, treinamento e expansão.

---

## 12. O que se pede à TI

- **Avaliação de segurança e arquitetura:** a parecer da TI.
- **Ambiente:** uma conta Azure ou um servidor da empresa, e um domínio ou subdomínio.
- **Integrações:** acesso para integrar login corporativo, e-mail e SAP.
- **Governança:** um responsável técnico na TI para dividir manutenção e operação.
- **Piloto:** apoio para a Expedição e os almoxarifados SP12/SP13.

---

### Referências
- SmartBee, dispensação industrial: https://www.smartbee.group/
- Preço da VM Azure B2s, East US, por agregadores: https://cloudprice.net/vm/Standard_B2s e https://www.economize.cloud/resources/azure/pricing/virtual-machine/b2s/ (confirmar na calculadora oficial do Azure).
- Base de código aberto: Sentry WMS (hightower-systems), licença Apache 2.0. Ver `LICENSE` e `NOTICE` no repositório.
- Documentação técnica do SEA: `docs/SEA.md`.
