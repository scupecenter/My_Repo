#!/usr/bin/env bash
# GSDN Workspace: optional ClamAV virus scan for uploads (owner answer Q134). Called by install-ubuntu.sh when the owner chooses it, and runnable
# on its own after a git pull:   sudo bash pmis/tools/install/install-clamav.sh
#
# What it does: installs clamav-daemon and clamav-freshclam (virus signatures, updated by freshclam), enables both services, lets the
# API user read the clamd socket (group clamav), makes the API start after clamd, and sets in /etc/gsdn-pmis/pmis.env:
#   MALWARE_SCAN=clamd, CLAMD_SOCKET=/run/clamav/clamd.ctl, SCAN_FAILURE=fail_closed (an upload is refused with 503 while clamd is down).
# Use SCAN_FAILURE=fail_open only with the owner's decision (Q195): the file is then stored and rescanned at 04:00.
# Running it again changes nothing that is already in place.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
CONF=/etc/gsdn-pmis/pmis.env
SERVICE_USER=gsdn-pmis
SOCKET=/run/clamav/clamd.ctl
DROPIN_DIR=/etc/systemd/system/gsdn-pmis-api.service.d

[[ -r $CONF ]] || { echo "No installation found ($CONF missing). Run install-ubuntu.sh first." >&2; exit 1; }

echo "==> Installing ClamAV (clamav-daemon, clamav-freshclam)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq clamav-daemon clamav-freshclam >/dev/null

echo "==> Starting freshclam (signature update) and clamd"
systemctl enable -q clamav-freshclam
systemctl restart clamav-freshclam || true     # the first update can take minutes; clamd starts with the signatures it has
systemctl enable -q clamav-daemon
systemctl restart clamav-daemon

echo "==> Waiting for the clamd socket"
for _ in $(seq 1 120); do
  [[ -S $SOCKET ]] && break
  sleep 2
done
[[ -S $SOCKET ]] || { journalctl -u clamav-daemon -n 20 --no-pager; echo "clamd did not create $SOCKET (the signature database may still be loading: try again in a few minutes)." >&2; exit 1; }

echo "==> Letting the API user read the socket"
id -u "$SERVICE_USER" >/dev/null 2>&1 || { echo "The service user $SERVICE_USER does not exist: run install-ubuntu.sh first." >&2; exit 1; }
usermod -a -G clamav "$SERVICE_USER"

echo "==> Settings in $CONF"
set_env() {  # set_env KEY VALUE: replaces the line KEY=... or appends it
  local k=$1 v=$2 tmp
  tmp=$(mktemp)
  grep -v -E "^${k}=" "$CONF" >"$tmp" || true
  printf '%s=%s\n' "$k" "$v" >>"$tmp"
  cat "$tmp" >"$CONF"
  rm -f "$tmp"
}
set_env MALWARE_SCAN clamd
set_env CLAMD_SOCKET "$SOCKET"
set_env SCAN_FAILURE fail_closed
grep -q '^CLAMD_TIMEOUT_MS=' "$CONF" || set_env CLAMD_TIMEOUT_MS 120000
chown root:"$SERVICE_USER" "$CONF"
chmod 640 "$CONF"

echo "==> Starting the API after clamd"
install -d -m 755 "$DROPIN_DIR"
cat >"$DROPIN_DIR/clamav.conf" <<'EOF'
# Written by install-clamav.sh: the API waits for the virus scanner (uploads are scanned before they are stored).
[Unit]
Wants=clamav-daemon.service
After=clamav-daemon.service
EOF
systemctl daemon-reload
systemctl restart gsdn-pmis-api

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(sed -n 's/^PORT=//p' "$CONF")/api/v1/auth/session" || true)
  [[ $code == 401 || $code == 200 ]] && break
  sleep 1
done
echo "ClamAV is installed. Uploads are scanned before they are stored (SCAN_FAILURE=fail_closed)."
echo "Check: sudo systemctl status clamav-daemon clamav-freshclam --no-pager"
echo "Test: upload the EICAR test file through the app (expect 422 file_rejected, reason malware); see infra/RUNBOOK.md, section ClamAV."
