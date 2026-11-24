#!/bin/sh
# Prepara o ambiente da simulação: recria o banco sea_carga (só ele) com o esquema e os locais do
# SEA e sobe a cópia da API e do worker ligada a ele. Nada de produção, desenvolvimento ou testes é
# tocado. Uso: sh qa/carga/preparar.sh
set -eu
export MSYS_NO_PATHCONV=1  # Git Bash no Windows: não converter caminhos de dentro do container
cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f docker-compose.yml -f qa/carga/docker-compose.carga.yml"
DB=sea_carga  # fixo: este script nunca recria outro banco

$COMPOSE stop api-carga celery-carga >/dev/null 2>&1 || true
docker exec sea-db sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists $DB && createdb -U \"\$POSTGRES_USER\" $DB"
docker exec -i sea-db sh -c "psql -q -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $DB" \
  < db/schema.sql >/dev/null 2>&1
# Mesmo caminho de uma instalação nova: administrador e armazém padrão (seed.sh), depois os locais
# do SEA (seed-sea.sql, que o seed.sh carrega). Senha fictícia, só deste ambiente local.
docker exec -e POSTGRES_DB=$DB -e SKIP_SEED=true -e ADMIN_PASSWORD='Carga@2026' sea-db \
  sh /docker-entrypoint-initdb.d/02-seed.sh >/dev/null
$COMPOSE up -d api-carga celery-carga
echo "pronto: banco $DB e API em http://sea-api-carga:5000 (rede sea_default)"
