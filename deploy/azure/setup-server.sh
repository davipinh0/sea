#!/bin/sh
# Roda na VM, em /opt/sea, a cada implantação.
#   sh deploy/azure/setup-server.sh <dominio> [arquivo.dump]
# Na primeira vez cria o .env com senhas e chaves aleatórias, que nunca saem da VM. Com um .dump, o
# banco é substituído pelo backup.
set -eu
DOMAIN=${1:?informe o domínio, ex.: sea-xxxx.centralus.cloudapp.azure.com}
DUMP=${2:-}
cd /opt/sea
# O backup diário chama o backup.sh direto, e o pacote do deploy pode perder a permissão de
# execução.
chmod +x deploy/azure/backup.sh
COMPOSE="docker compose -f docker-compose.yml -f deploy/azure/docker-compose.azure.yml"

rand() { openssl rand -hex "$1"; }
if [ ! -f .env ]; then
  umask 077
  cat > .env <<ENV
POSTGRES_USER=sea
POSTGRES_PASSWORD=$(rand 24)
POSTGRES_DB=sea
JWT_SECRET=$(rand 32)
REDIS_PASSWORD=$(rand 24)
SEA_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_')
SEA_PUBSUB_HMAC_KEY=$(rand 32)
SEA_TOKEN_PEPPER=$(rand 32)
SEA_DOMAIN=$DOMAIN
SEA_PUSH=expo
ENV
  echo ".env criado"
fi
grep -q "^SEA_DOMAIN=$DOMAIN\$" .env || sed -i "s|^SEA_DOMAIN=.*|SEA_DOMAIN=$DOMAIN|" .env

$COMPOSE build
$COMPOSE up -d db redis
# Na primeira subida o Postgres monta o esquema num servidor temporário; pg_isready por TCP só
# responde quando o definitivo está no ar.
until docker exec sea-db pg_isready -q -h 127.0.0.1; do sleep 2; done

if [ -n "$DUMP" ]; then
  echo "restaurando $DUMP"
  docker exec sea-db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists -f "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
  # --disable-triggers: o histórico de auditoria entra como estava (a corrente de hashes não é
  # recalculada).
  docker exec -i sea-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --disable-triggers' < "$DUMP"
fi

# Migrações do SEA (podem rodar de novo): mantêm um banco restaurado em dia.
for f in db/migrations/08[2-9]_*.sql db/migrations/09[0-9]_*.sql; do
  docker exec -i sea-db sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$f"
done

$COMPOSE up -d
$COMPOSE ps --format '{{.Name}} {{.Status}}'
