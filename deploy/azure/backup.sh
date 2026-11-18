#!/bin/sh
# Backup diário do banco do SEA (executado pelo cron da VM). Mantém 14 dias.
set -eu
DEST=/var/backups/sea
STAMP=$(date +%Y-%m-%d_%H%M)
docker exec sea-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DEST/sea-$STAMP.dump"
find "$DEST" -name 'sea-*.dump' -mtime +14 -delete
echo "$STAMP backup ok ($(du -h "$DEST/sea-$STAMP.dump" | cut -f1))"
