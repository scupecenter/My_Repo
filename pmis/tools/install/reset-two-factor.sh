#!/usr/bin/env bash
# GSDN PMIS: reset (or switch off) a user's two-factor on the server, for the case where the only System Admin lost the authenticator
# and no other admin can do it in Users & Roles (ADR 0014). Run as root on the server:
#   sudo bash pmis/tools/install/reset-two-factor.sh admin@example.com            reset: the user enrols again with a new one-time code
#   sudo bash pmis/tools/install/reset-two-factor.sh admin@example.com --disable   switch two-factor off for the user
#
# A reset also issues a one-time enrolment code (owner decision 2026-11-02): a password alone can never enrol a phone. The code is made here
# with the API's own key (TOTP_ENC_KEY from pmis.env), only its keyed hash goes to the database, and the code is printed once, below.
# Hand it to the user in person or by phone. It expires after the setting two_factor.enrol_code_hours (default 72 hours).
# Environment overrides for a non-standard installation: CONF_DIR (default /etc/gsdn-pmis), API_ROOT (default /opt/gsdn-pmis/api),
# PSQL_CMD (default: sudo -u postgres psql), used by the tests.
set -euo pipefail

CONF_DIR=${CONF_DIR:-/etc/gsdn-pmis}
API_ROOT=${API_ROOT:-/opt/gsdn-pmis/api}
die() { echo "ERROR: $*" >&2; exit 1; }

EMAIL=${1-}; MODE=${2-}
[[ -n $EMAIL && $EMAIL == *@* ]] || die "usage: sudo bash $0 <email> [--disable]"
[[ -z $MODE || $MODE == --disable ]] || die "unknown option $MODE (only --disable)"
[[ -n ${PSQL_CMD-} || $EUID -eq 0 ]] || die "Run as root: sudo bash $0 $EMAIL ${MODE}"
[[ -r $CONF_DIR/pmis.env ]] || die "No installation found ($CONF_DIR/pmis.env is missing)."

URL=$(sed -n 's/^DATABASE_URL=//p' "$CONF_DIR/pmis.env")
read -r DB_PORT DB_NAME < <(python3 -c '
import sys, urllib.parse as u
p = u.urlsplit(sys.stdin.read().strip()); print(p.port or 5432, p.path.lstrip("/"))' <<<"$URL")
KEY=$(sed -n 's/^TOTP_ENC_KEY=//p' "$CONF_DIR/pmis.env")
[[ -n $KEY ]] || die "TOTP_ENC_KEY is missing in $CONF_DIR/pmis.env."

psql_su() {
  if [[ -n ${PSQL_CMD-} ]]; then $PSQL_CMD -v ON_ERROR_STOP=1 -qAt "$@"
  else sudo -u postgres env PGOPTIONS="-c client_min_messages=warning" psql -p "$DB_PORT" -v ON_ERROR_STOP=1 -qAt "$@"; fi
}
sql_lit() { printf "'%s'" "${1//\'/\'\'}"; }

UID_=$(printf 'SELECT id FROM users WHERE email = lower(btrim(%s)) AND NOT is_break_glass;\n' "$(sql_lit "$EMAIL")" | psql_su -d "$DB_NAME")
[[ $UID_ =~ ^[0-9a-f-]{36}$ ]] || die "No user with the email $EMAIL."

if [[ $MODE == --disable ]]; then
  printf 'SELECT idm_installer_reset_two_factor(%s, true);\n' "$(sql_lit "$EMAIL")" | psql_su -d "$DB_NAME" >/dev/null
  echo "Two-factor is off for $EMAIL (nothing changes if it was already off). If it was on, their sessions ended; they sign in with the password."
  exit 0
fi

# The code is made with the API's key; the database receives the hash only.
PAIR=$(TOTP_ENC_KEY=$KEY node "$API_ROOT/dist/cli.js" enrol-code "$UID_") || die "Could not make an enrolment code."
CODE=${PAIR%% *}; HASH=${PAIR##* }
[[ $CODE =~ ^[A-Z2-9]{4}-[A-Z2-9]{4}$ && $HASH =~ ^[0-9a-f]{64}$ ]] || die "The code generator answered something unexpected."
UNTIL=$(printf 'SELECT idm_installer_reset_two_factor(%s, false, %s);\n' "$(sql_lit "$EMAIL")" "$(sql_lit "$HASH")" | psql_su -d "$DB_NAME")
if [[ -z $UNTIL ]]; then
  echo "Two-factor is not on for $EMAIL: nothing to reset."
  exit 0
fi
echo "Two-factor is reset for $EMAIL. Their sessions ended and they enrol again at the next sign-in."
echo
echo "    Enrolment code:  $CODE"
echo "    Valid until:     $UNTIL"
echo
echo "Hand the code to the user in person or by phone. It is shown only now and works once. If it is lost, an admin issues a new one in Users & Roles."
