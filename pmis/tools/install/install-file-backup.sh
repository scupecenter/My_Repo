#!/usr/bin/env bash
# GSDN Workspace: optional nightly backup of the stored files with restic (owner answer Q134). Called by install-ubuntu.sh when the owner chooses it,
# and runnable on its own:   sudo bash pmis/tools/install/install-file-backup.sh
#
# Why restic: it encrypts the repository, deduplicates, keeps snapshots with a retention policy in one command (14 daily, 8 weekly, 12 monthly)
# and sends to a local path, sftp or S3 alike. rsync would copy plaintext-looking trees without encryption or history. See infra/RUNBOOK.md.
#
# Asks (or reads FILES_BACKUP_REPO from the environment for a non-interactive run):
#   FILES_BACKUP_REPO   restic repository: an absolute path on another disk or share (/mnt/backup/gsdn-files),
#                       or sftp:user@host:/path for another building. The repository must not be on this server's data disk.
# Writes /etc/gsdn-pmis/backup.env and /etc/gsdn-pmis/restic.password (root and the service user only). The password is kept offline too:
# without it the backups cannot be read.
# Installs gsdn-pmis-files-backup.service and .timer (every night at 02:30, server time).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
CONF=/etc/gsdn-pmis/pmis.env
BACKUP_ENV=/etc/gsdn-pmis/backup.env
PASS_FILE=/etc/gsdn-pmis/restic.password
SERVICE_USER=gsdn-pmis
PMIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$PMIS_DIR/infra/backup/files-backup.sh"
STAGING=/var/tmp/gsdn-pmis-files-staging

[[ -r $CONF ]] || { echo "No installation found ($CONF missing). Run install-ubuntu.sh first." >&2; exit 1; }
[[ -r $SCRIPT ]] || { echo "Missing $SCRIPT" >&2; exit 1; }

REPO=${FILES_BACKUP_REPO:-}
if [[ -z $REPO ]]; then
  if [[ -r $BACKUP_ENV ]]; then REPO=$(sed -n 's/^RESTIC_REPOSITORY=//p' "$BACKUP_ENV"); fi
  REPO=${REPO:-/var/backups/gsdn-pmis/restic}
  read -rp "Backup repository (absolute path on another disk, or sftp:user@host:/path) [$REPO]: " ans || true
  [[ -n ${ans:-} ]] && REPO=$ans
fi
[[ $REPO == /* || $REPO == sftp:* || $REPO == s3:* ]] || { echo "Use an absolute path, sftp:... or s3:..." >&2; exit 1; }

echo "==> Installing restic"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq restic >/dev/null
id -u "$SERVICE_USER" >/dev/null 2>&1 || { echo "The service user $SERVICE_USER does not exist: run install-ubuntu.sh first." >&2; exit 1; }

echo "==> Password file (created once; never printed)"
install -d -m 750 -o root -g "$SERVICE_USER" /etc/gsdn-pmis
if [[ ! -s $PASS_FILE ]]; then
  umask 077
  openssl rand -base64 36 >"$PASS_FILE"
  echo "   Created $PASS_FILE. Copy it to a safe place outside this server now."
fi
chown root:"$SERVICE_USER" "$PASS_FILE"
chmod 640 "$PASS_FILE"

if [[ $REPO != sftp:* && $REPO != s3:* ]]; then
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$REPO"
fi

echo "==> Settings in $BACKUP_ENV"
cat >"$BACKUP_ENV" <<EOF
# Written by install-file-backup.sh on $(date -Is). Keep private (root and the service user).
RESTIC_REPOSITORY=$REPO
RESTIC_PASSWORD_FILE=$PASS_FILE
FILES_BACKUP_STAGING=$STAGING
EOF
chown root:"$SERVICE_USER" "$BACKUP_ENV"
chmod 640 "$BACKUP_ENV"

echo "==> Timer: every night at 02:30"
install -d -m 755 /usr/local/lib/gsdn-pmis
install -m 755 "$SCRIPT" /usr/local/lib/gsdn-pmis/files-backup.sh   # a copy, so the timer does not depend on the checkout
cat >/etc/systemd/system/gsdn-pmis-files-backup.service <<EOF
[Unit]
Description=GSDN Workspace nightly backup of the stored files (restic)
After=network-online.target gsdn-pmis-api.service
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$CONF
EnvironmentFile=$BACKUP_ENV
ExecStart=/bin/bash /usr/local/lib/gsdn-pmis/files-backup.sh
PrivateTmp=true
Nice=10
IOSchedulingClass=idle
EOF
cat >/etc/systemd/system/gsdn-pmis-files-backup.timer <<'EOF'
[Unit]
Description=Nightly backup of the GSDN Workspace stored files

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable -q --now gsdn-pmis-files-backup.timer
echo "Backup timer is on. Run once by hand: sudo systemctl start gsdn-pmis-files-backup.service; logs: journalctl -u gsdn-pmis-files-backup"
echo "Retention: 14 daily, 8 weekly, 12 monthly. Restore: infra/RUNBOOK.md (Restore drill)."
