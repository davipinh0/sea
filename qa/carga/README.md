# Simulação de carga: o SEA numa empresa de grande porte

Simula um dia de operação de uma usina **fictícia** ("Siderúrgica Aurora S.A."), no porte de uma
siderúrgica, mineradora ou indústria de bebidas de grande porte, usando o SEA do jeito que ele foi
projetado: base do SAP importada pelo painel, OTs recebidas na Expedição, armazenadas no SP12/SP13,
pedidas no terminal, avaliadas, separadas e entregues. Depois leva o sistema ao limite e confere o
banco. Todos os nomes, códigos e funcionários são inventados (semente fixa: cada execução é
comparável com a anterior).

## Como rodar

Com o ambiente local no ar (`docker compose up -d`):

```sh
sh qa/carga/rodar.sh                      # porte padrão (~10 min)
sh qa/carga/rodar.sh --escala 2           # o dobro de materiais, ordens, OTs e funcionários
sh qa/carga/rodar.sh --escala 0.1 --ots 40 --retiradas 30 --patamares 5,10 --segundos 5   # ensaio rápido
```

O relatório sai em `qa/carga/resultados/AAAA-MM-DD_HHMM.md` (e `.json` com todos os números). O
comando termina com erro se algum confronto ou regra do banco falhar, ou se houver erro 5xx no dia.

## Isolamento

- `preparar.sh` recria **só** o banco `sea_carga`, pelo mesmo caminho de uma instalação nova
  (`schema.sql`, `seed.sh`, `seed-sea.sql`). Desenvolvimento (`sentry`), testes (`sentry_test`) e
  produção não são tocados.
- `docker-compose.carga.yml` sobe `sea-api-carga` e `sea-celery-carga`, cópias da API e do worker
  ligadas a `sea_carga`, com fila própria no Redis (banco 5), e-mail no Mailpit local (não entrega
  para fora) e push no celular desligado.
- O gerador de carga roda num container separado, para não disputar processador com a API medida.
- O administrador da simulação usa a senha fictícia `Carga@2026`, só deste ambiente local.

## O que é simulado

| Etapa | O que acontece |
|---|---|
| 1. Implantação | importa pelo painel 3.000 materiais, 1.500 ordens PM11/PM12 e ~4.200 linhas de 1.200 OTs; 130 funcionários entram (recebedores, avaliadores, almoxarifes, solicitantes, consultores) |
| 2. Dia de operação | 800 OTs registradas da base do SAP e recebidas (1 em 4 em duas entregas), armazenadas no SP12/SP13; 500 retiradas pedidas pelo terminal, 92% aprovadas, separadas, prontas e entregues (5% canceladas no balcão); consultores olhando painel, listas, histórico e notificações o tempo todo |
| 3. Confrontos | 30 pessoas pedindo a última unidade; 10 almoxarifes aceitando a mesma retirada; a mesma entrega confirmada 10 vezes; a mesma OT registrada por 10 recebedores; o mesmo material recebido e armazenado por 10 pessoas ao mesmo tempo |
| 4. Escalada | carga mista (terminal, painel, listas, notificações, pendências de armazenagem e pedidos cancelados) em patamares de 5 a 400 usuários simultâneos, 30 s cada, até o p95 passar de 5 s ou os erros 5xx passarem de 5% |
| 5. Conferência | regras de `invariantes.py`: estoque nunca negativo nem reservado além do saldo, reserva = retiradas em andamento, recebido = em estoque + entregue, nada recebido além do previsto, uma OT um cadastro, uma entrega um registro no log, corrente de hashes do log íntegra; e-mails processados pelo worker |

"Capacidade sustentável" no relatório é o maior patamar com p95 até 1 s e menos de 1% de erros.

## Arquivos

- `empresa.py`: a empresa fictícia (porte, catálogo, ordens, OTs, funcionários).
- `simular.py`: as cinco etapas e o relatório.
- `invariantes.py`: as regras conferidas no banco.
- `preparar.sh`, `rodar.sh`, `docker-compose.carga.yml`: ambiente isolado.
- `resultados/`: relatórios das execuções.
