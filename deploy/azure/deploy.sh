#!/bin/sh
# Envia a versão atual (último commit) para a VM e sobe o sistema.
#   sh deploy/azure/deploy.sh <dominio> [arquivo.dump]
set -eu
DOMAIN=${1:?informe o domínio}
DUMP=${2:-}
KEY="$HOME/.ssh/sea_azure"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new seaadmin@$DOMAIN"
cd "$(dirname "$0")/../.."

until $SSH 'test -f /var/lib/cloud/instance/boot-finished && docker info >/dev/null 2>&1'; do
  echo "aguardando a VM terminar a preparação..."; sleep 15
done
git archive --format=tar HEAD | $SSH 'tar -x -C /opt/sea'
REMOTE_DUMP=""
if [ -n "$DUMP" ]; then
  scp -i "$KEY" "$DUMP" "seaadmin@$DOMAIN:/var/backups/sea/restaurar.dump"
  REMOTE_DUMP=/var/backups/sea/restaurar.dump
fi
$SSH "cd /opt/sea && sh deploy/azure/setup-server.sh $DOMAIN $REMOTE_DUMP"
