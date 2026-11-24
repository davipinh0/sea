#!/bin/sh
# Simulação completa: prepara o ambiente isolado e roda as 5 etapas. Argumentos vão para
# simular.py (ex.: --escala 2 --patamares 10,50,100). Uso: sh qa/carga/rodar.sh [opções]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
sh qa/carga/preparar.sh
sleep 5
docker compose -f docker-compose.yml -f qa/carga/docker-compose.carga.yml run --rm --no-deps \
  -v "$PWD/qa/carga:/carga" api-carga python -u /carga/simular.py "$@"
