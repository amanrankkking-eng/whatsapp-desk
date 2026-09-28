#!/usr/bin/env bash
# Backs up the database (every message, send, reply and setting) and the WhatsApp sessions.
#   ./scripts/backup.sh            -> backups/desk-YYYY-MM-DD-HHMM.sql.gz and instances-....tgz
# Put it in cron for a daily copy:  15 2 * * * cd /path/to/whatsapp-desk && ./scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
stamp=$(date +%F-%H%M)
docker compose exec -T postgres pg_dump -U evolution -d evolution | gzip > "backups/desk-${stamp}.sql.gz"
vol=$(docker volume ls -q | grep -E '_evolution_instances$' | head -1)
if [ -n "$vol" ]; then
  docker run --rm -v "${vol}:/data:ro" -v "$PWD/backups:/b" alpine tar czf "/b/instances-${stamp}.tgz" -C /data .
fi
find backups -type f -mtime +30 -delete
ls -lh backups | tail -5
