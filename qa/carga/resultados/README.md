# Execuções registradas

| Relatório | O que foi | Resultado |
|---|---|---|
| `2026-11-24_0133` | primeira execução no porte padrão, antes das correções | REPROVADO: 1 erro 500 ao registrar ao mesmo tempo duas OTs com o mesmo material novo; vazão travada em ~75 req/s pela lista de OTs (553 ms por chamada, sem índice do estoque pelo lote) |
| `2026-11-24_0140` | mesma execução depois da correção do cadastro do material e da migração `101` | APROVADO: nenhum erro, ~320 req/s, 400 simultâneos com p95 de 1,4 s |
| `2026-11-24_0145` | escalada estendida a 400, 800 e 1600 usuários simultâneos | APROVADO: nenhum erro até 1600 simultâneos; a vazão fica em ~320 req/s e o p95 sobe a 5,2 s (fila nos 4 processos da API) |

Números medidos no ambiente local (Docker no Windows, 16 núcleos). Em outra máquina, como a VM de
produção, os valores absolutos mudam; a comparação entre execuções na mesma máquina é o que vale.
