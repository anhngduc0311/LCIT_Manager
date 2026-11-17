#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/lock/lcit-maintenance.lock
flock -n 9 || { echo 'Another LCIT maintenance operation is running.' >&2; exit 1; }
was_active=0
if systemctl is-active --quiet lcit-api.service; then was_active=1; fi
resume() {
    if [ "$was_active" -eq 1 ]; then systemctl start lcit-api.service; fi
}
trap resume EXIT
# All API instances, schedulers, import jobs and SQL writers must use this maintenance window.
systemctl stop lcit-api.service
export LCIT_BACKUP_MAINTENANCE=on
backup_dir="/var/backups/lcit/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p /var/backups/lcit
/usr/bin/node /opt/lcit-manager/apps/api/scripts/recovery.cjs backup "$backup_dir"
# No automatic deletion: agree retention and an encrypted off-host copy before enabling the timer.
