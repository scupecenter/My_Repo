#!/usr/bin/env bash
# GSDN PMIS: interactive installer and upgrader for Ubuntu 22.04 / 24.04.
#
# Installs what the repository can run today (see HANDOVER.md §2 and ADR 0012):
#   - PostgreSQL 16 with the PMIS database, the pmis_app role and every migration not applied yet
#   - the API (apps/api, NestJS) as the systemd service gsdn-pmis-api: local sign-in, users and groups
#   - the first System Admin (asked here, only while none exists)
#   - document storage: a directory on local disk (default) or, optionally, a MinIO server on this machine (installed here, with its bucket
#     and a bucket-only user), see "Document storage" below
#   - optional: ClamAV virus scan of uploads, and a nightly encrypted backup of the stored files (install-clamav.sh, install-file-backup.sh)
#   - the web app (apps/web) served by nginx over HTTPS. Sign-in and users talk to the API; the other screens still
#     use sample data (MSW) until their API is built.
#
# Every value (address, ports, database name, passwords) is asked here, on the server, and nothing secret is written to
# the repository. Answers are kept in /etc/gsdn-pmis/install.conf, so running it again (after git pull) only needs Enter.
#   sudo bash pmis/tools/install/install-ubuntu.sh          (first time, asks the questions)
#   sudo bash pmis/tools/install/update.sh                  (later updates, no questions)
set -euo pipefail

# --update: no questions; every answer comes from the previous run (used by update.sh).
AUTO=0; [[ ${1-} == --update ]] && AUTO=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PMIS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$PMIS_DIR/apps/api/prisma/migrations"
API_SRC="$PMIS_DIR/apps/api"
WEB_DIR="$PMIS_DIR/apps/web"
API_ROOT=/opt/gsdn-pmis/api
WEB_ROOT=/var/www/gsdn-pmis
CONF_DIR=/etc/gsdn-pmis
TLS_DIR=/etc/ssl/gsdn-pmis
ACME_ROOT=/var/www/letsencrypt
# Let's Encrypt's directory (certbot). Overridable only for tests on a copy of the tree; the server uses the default.
LE_DIR=${LE_DIR:-/etc/letsencrypt}
SITE=/etc/nginx/sites-available/gsdn-pmis
SERVICE_USER=gsdn-pmis
# Migrations the first installer applied without recording them (used only to adopt an older installation).
LEGACY_LAST=0009_identity_writes

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

# ask VAR "Question" [default]
ask() {
  local __var=$1 __q=$2 __def=${3-} __ans
  if (( AUTO )); then
    [[ -n $__def ]] || die "No previous answer for \"$__q\". Run install-ubuntu.sh once without --update."
    echo "$__q: $__def"; printf -v "$__var" '%s' "$__def"; return
  fi
  if [[ -n $__def ]]; then read -rp "$__q [$__def]: " __ans; else read -rp "$__q: " __ans; fi
  __ans=${__ans:-$__def}
  [[ -n $__ans ]] || die "A value is required: $__q"
  printf -v "$__var" '%s' "$__ans"
}

# ask_opt VAR "Question" [default]: may stay empty
ask_opt() {
  local __var=$1 __q=$2 __def=${3-} __ans
  (( AUTO )) && { printf -v "$__var" '%s' "$__def"; return; }
  read -rp "$__q${__def:+ [$__def]} (optional): " __ans
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_secret VAR "Question" [allow_generate]: hidden input, asked twice; empty generates a random one when allowed.
ask_secret() {
  local __var=$1 __q=$2 __gen=${3-1} __a __b
  (( AUTO )) && die "\"$__q\" needs an answer. Run install-ubuntu.sh once without --update."
  if (( __gen )); then read -rsp "$__q (leave empty to generate one): " __a; else read -rsp "$__q: " __a; fi; echo
  if [[ -z $__a ]]; then
    (( __gen )) || die "A value is required."
    __a=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
    echo "   Generated. It will be saved in $CONF_DIR/pmis.env (not readable by other users)."
  else
    read -rsp "   Repeat: " __b; echo
    [[ $__a == "$__b" ]] || die "The two entries do not match."
    (( ${#__a} >= 12 )) || die "Use at least 12 characters."
  fi
  printf -v "$__var" '%s' "$__a"
}

ask_yes() { local a; read -rp "$1 [y/N]: " a; [[ $a =~ ^[Yy] ]]; }
ask_no()  { (( AUTO )) && return 0; local a; read -rp "$1 [Y/n]: " a; [[ ! $a =~ ^[Nn] ]]; }

is_port() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
port_busy() {
  if command -v ss >/dev/null; then ss -ltnH "( sport = :$1 )" | grep -q .
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi
}

# ---------------------------------------------------------------- existing Let's Encrypt certificate (TLS option 4)
# The certificate stays where certbot keeps it and is renewed by certbot; nginx reads it in place (no copy).
# BEGIN le-existing (tools/install/test-le-existing.sh extracts this block; keep the markers)
le_names() {
  local d n
  for d in "$LE_DIR"/live/*/; do
    [[ -d $d ]] || continue
    n=$(basename "$d"); [[ $n == README ]] && continue
    printf '%s\n' "$n"
  done
}

# le_covers CERT HOST: true when the certificate matches HOST (a domain or an IP address)
le_covers() {
  local cert=$1 host=$2
  if [[ $host =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    openssl x509 -noout -checkip "$host" -in "$cert" 2>/dev/null | grep -q 'does match'
  else
    openssl x509 -noout -checkhost "$host" -in "$cert" 2>/dev/null | grep -q 'does match'
  fi
}

# le_choose: sets TLS_LE_NAME. Interactive: a numbered list, then a number or a name. Non-interactive: the TLS_LE_NAME variable.
le_choose() {
  local names=() n i def
  if (( NONINT_TLS )); then
    [[ -n ${TLS_LE_NAME:-} ]] || die "Set TLS_LE_NAME to the name of the certificate under $LE_DIR/live/."
    return 0
  fi
  mapfile -t names < <(le_names)
  if (( ! AUTO )); then
    if (( ${#names[@]} == 0 )); then
      die "No certificates under $LE_DIR/live/. Choose option 1 (new Let's Encrypt certificate) or option 2 (your own files)."
    fi
    echo "Certificates under $LE_DIR/live/:"
    i=1; for n in "${names[@]}"; do echo "  $i) $n"; i=$((i + 1)); done
  fi
  def=${PREV_LE_NAME:-}
  if [[ -z $def ]] && (( ${#names[@]} > 0 )); then def=${names[0]}; fi
  ask TLS_LE_NAME "Certificate name (a number from the list, or a name)" "$def"
  if [[ $TLS_LE_NAME =~ ^[0-9]+$ ]] && (( TLS_LE_NAME >= 1 && TLS_LE_NAME <= ${#names[@]} )); then
    TLS_LE_NAME=${names[TLS_LE_NAME - 1]}
  fi
}

# le_check NAME HOST: dies unless the certificate NAME exists, is valid now, matches its key and covers HOST.
le_check() {
  local name=$1 host=$2 cert key
  [[ $name =~ ^[A-Za-z0-9._-]+$ && $name != . && $name != .. ]] || die "Not a certificate name: $name"
  cert=$LE_DIR/live/$name/fullchain.pem; key=$LE_DIR/live/$name/privkey.pem
  [[ -r $cert && -r $key ]] || die "No fullchain.pem and privkey.pem under $LE_DIR/live/$name (the installer must run as root)."
  openssl x509 -checkend 0 -noout -in "$cert" >/dev/null 2>&1 \
    || die "The certificate $name has expired, or is not a certificate. Renew it first: certbot renew --cert-name $name"
  [[ $(openssl x509 -noout -pubkey -in "$cert" 2>/dev/null) == "$(openssl pkey -pubout -in "$key" 2>/dev/null)" ]] \
    || die "The private key $key does not belong to $cert."
  echo "   Subject: $(openssl x509 -noout -subject -in "$cert" | sed 's/^subject= *//')"
  echo "   SAN:     $(openssl x509 -noout -ext subjectAltName -in "$cert" 2>/dev/null | tail -n +2 | sed 's/^ *//' || true)"
  echo "   Expires: $(openssl x509 -noout -enddate -in "$cert" | sed 's/^notAfter=//')"
  le_covers "$cert" "$host" || die "The certificate $name does not cover $host. Choose a name that the certificate covers."
}

# le_renewal_hook: certbot runs it after each renewal so nginx reloads the new file. Never overwrites another hook.
le_renewal_hook() {
  local dir="$LE_DIR/renewal-hooks/deploy" body f
  body=$'#!/bin/sh\nsystemctl reload nginx'
  install -d "$dir"
  for f in "$dir/reload-nginx" "$dir/reload-nginx-gsdn-pmis"; do
    if [[ -e $f || -L $f ]]; then
      if [[ $(cat "$f" 2>/dev/null) == "$body" ]]; then
        chmod 755 "$f"; echo "   Renewal hook already in place: $f"; return 0
      fi
      continue
    fi
    printf '%s\n' "$body" > "$f"; chmod 755 "$f"
    echo "   Renewal hook installed: $f (nginx is reloaded after each renewal)"
    return 0
  done
  die "Both $dir/reload-nginx and $dir/reload-nginx-gsdn-pmis exist with other content. Add 'systemctl reload nginx' to one of them yourself, then run the installer again."
}
# END le-existing

# ---------------------------------------------------------------- preflight
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"
[[ -r /etc/os-release ]] && . /etc/os-release
[[ ${ID:-} == ubuntu ]] || die "This script supports Ubuntu only (found: ${PRETTY_NAME:-unknown})."
[[ -d $MIGRATIONS_DIR && -f $WEB_DIR/package.json ]] || die "Run it from inside the repository checkout ($PMIS_DIR looks wrong)."
[[ -f $API_SRC/package.json ]] || die "The API code ($API_SRC) is not in this checkout yet. Nothing was changed; run git pull later and try again."
command -v openssl >/dev/null || apt-get install -y -qq openssl

# ---------------------------------------------------------------- previous answers
# Saved answers first; for an installation made before install.conf existed, read nginx and pmis.env.
PREV_SERVER_NAME='' PREV_HTTPS_PORT='' PREV_HTTP_PORT='' PREV_CERT_PATH='' PREV_KEY_PATH='' PREV_DB_NAME='' PREV_DB_PORT=''
PREV_DB_PASSWORD='' PREV_API_PORT='' PREV_LOG_HMAC_KEY='' PREV_TOTP_ENC_KEY='' PREV_FILE_ENC_KEY=''
PREV_STORAGE_MODE='' PREV_STORAGE_DIR='' PREV_MINIO_PORT='' PREV_MINIO_DIR='' PREV_S3_ACCESS_KEY='' PREV_S3_SECRET_KEY='' PREV_MINIO_ROOT_PASSWORD=''
PREV_TLS_MODE='' PREV_LE_NAME=''
if [[ -r $CONF_DIR/install.conf ]]; then
  # shellcheck disable=SC1091
  . "$CONF_DIR/install.conf"
fi
if [[ -r $SITE ]]; then
  [[ -n $PREV_SERVER_NAME ]] || PREV_SERVER_NAME=$(awk '/server_name/ {gsub(";",""); print $2; exit}' "$SITE")
  [[ -n $PREV_HTTP_PORT ]]   || PREV_HTTP_PORT=$(awk '/listen/ && !/ssl/ {gsub(";",""); print $2; exit}' "$SITE")
  [[ -n $PREV_HTTPS_PORT ]]  || PREV_HTTPS_PORT=$(awk '/listen/ && /ssl/ {gsub(";",""); print $2; exit}' "$SITE")
  # The certificate in use is always read from the live nginx site.
  PREV_CERT_PATH=$(awk '/ssl_certificate / {gsub(";",""); print $2; exit}' "$SITE")
  PREV_KEY_PATH=$(awk '/ssl_certificate_key/ {gsub(";",""); print $2; exit}' "$SITE")
  # A site already pointing into $LE_DIR/live/<name>/ (set by hand, or by option 1) is option 4 even without install.conf.
  if [[ -z $PREV_TLS_MODE && $PREV_CERT_PATH == "$LE_DIR"/live/*/fullchain.pem ]]; then
    PREV_TLS_MODE=le-existing
    PREV_LE_NAME=${PREV_CERT_PATH#"$LE_DIR/live/"}; PREV_LE_NAME=${PREV_LE_NAME%/fullchain.pem}
  fi
fi
if [[ -r $CONF_DIR/pmis.env ]]; then
  _url=$(sed -n 's/^DATABASE_URL=//p' "$CONF_DIR/pmis.env")
  if [[ -n $_url ]]; then
    # Secrets go through stdin, never argv (visible to every local user in ps).
    read -r PREV_DB_PORT PREV_DB_NAME PREV_DB_PASSWORD < <(python3 -c '
import sys, urllib.parse as u
p = u.urlsplit(sys.stdin.read().strip()); print(p.port or 5432, p.path.lstrip("/"), u.unquote(p.password or ""))' <<<"$_url")
  fi
  PREV_LOG_HMAC_KEY=$(sed -n 's/^LOG_HMAC_KEY=//p' "$CONF_DIR/pmis.env")
  PREV_TOTP_ENC_KEY=$(sed -n 's/^TOTP_ENC_KEY=//p' "$CONF_DIR/pmis.env")
  PREV_FILE_ENC_KEY=$(sed -n 's/^FILE_ENC_KEY=//p' "$CONF_DIR/pmis.env")
  PREV_API_PORT=${PREV_API_PORT:-$(sed -n 's/^PORT=//p' "$CONF_DIR/pmis.env")}
  PREV_S3_ACCESS_KEY=$(sed -n 's/^S3_ACCESS_KEY=//p' "$CONF_DIR/pmis.env")
  PREV_S3_SECRET_KEY=$(sed -n 's/^S3_SECRET_KEY=//p' "$CONF_DIR/pmis.env")
  # an installation made before document storage existed has neither STORAGE_DIR nor S3_*: it gets local disk
  if [[ -z $PREV_STORAGE_MODE && -n $PREV_S3_ACCESS_KEY ]]; then PREV_STORAGE_MODE=minio; fi
  [[ -n $PREV_STORAGE_DIR ]] || PREV_STORAGE_DIR=$(sed -n 's/^STORAGE_DIR=//p' "$CONF_DIR/pmis.env")
fi
if [[ -r $CONF_DIR/minio.env ]]; then
  PREV_MINIO_ROOT_PASSWORD=$(sed -n 's/^MINIO_ROOT_PASSWORD=//p' "$CONF_DIR/minio.env")
fi
UPGRADE=0; [[ -n $PREV_DB_NAME ]] && UPGRADE=1

cat <<EOF

GSDN PMIS installer
Repository: $PMIS_DIR
Ubuntu:     $PRETTY_NAME
Mode:       $( (( UPGRADE )) && echo "upgrade of the existing installation (previous answers are the defaults)" || echo "new installation" )

Answer the questions below. Press Enter to accept the value in [brackets].
EOF

# ---------------------------------------------------------------- questions
say "1/6 Server address"
DEFAULT_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Enter the domain name if you have one (for example pmis.example.ly), or the server IP."
ask SERVER_NAME "Domain or IP" "${PREV_SERVER_NAME:-$DEFAULT_IP}"
if [[ $SERVER_NAME =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then IS_IP=1; else IS_IP=0; fi
ask HTTPS_PORT "HTTPS port" "${PREV_HTTPS_PORT:-443}"
ask HTTP_PORT  "HTTP port (redirects to HTTPS)" "${PREV_HTTP_PORT:-80}"
is_port "$HTTPS_PORT" && is_port "$HTTP_PORT" || die "Ports must be numbers between 1 and 65535."

say "2/6 HTTPS certificate"
echo "The web app needs HTTPS: browsers refuse its service worker on plain HTTP or with an untrusted certificate."
HAVE_CERT=0
if [[ -n $PREV_CERT_PATH && -r $PREV_CERT_PATH && -n $PREV_KEY_PATH && -r $PREV_KEY_PATH && $SERVER_NAME == "$PREV_SERVER_NAME" ]]; then
  HAVE_CERT=1
  echo "  0) Keep the current certificate ($PREV_CERT_PATH)"
fi
echo "  1) Let's Encrypt  (needs a public domain pointing to this server and port 80 reachable)"
echo "  2) My own certificate files (for example from your internal CA)"
echo "  3) Self-signed    (you must then install the certificate as trusted on every client PC)"
echo "  4) A Let's Encrypt certificate already on this server, used in place (no copy: certbot renewals reach the PMIS)"
if (( HAVE_CERT )); then DEF_TLS=0; elif [[ $PREV_TLS_MODE == le-existing ]]; then DEF_TLS=4; elif (( IS_IP )); then DEF_TLS=3; else DEF_TLS=1; fi
# Non-interactive: TLS_MODE=0..4 (or le-existing) skips this question. Option 4 also needs TLS_LE_NAME=<name>.
# Example: sudo env TLS_MODE=le-existing TLS_LE_NAME=pmis.example.ly bash pmis/tools/install/install-ubuntu.sh
NONINT_TLS=0
if [[ -n ${TLS_MODE:-} ]]; then
  NONINT_TLS=1
  [[ $TLS_MODE == le-existing ]] && TLS_MODE=4
  echo "Certificate choice from the environment: $TLS_MODE"
else
  ask TLS_MODE "Choose" "$DEF_TLS"
fi
case $TLS_MODE in
  0) (( HAVE_CERT )) || die "There is no current certificate to keep." ;;
  1) (( IS_IP )) && die "Let's Encrypt does not issue certificates for an IP address."
     [[ $HTTP_PORT == 80 ]] || die "Let's Encrypt needs the HTTP port to be 80."
     ask LE_EMAIL "Email for Let's Encrypt expiry notices" ;;
  2) ask CERT_FILE "Path to the certificate (full chain, PEM)"
     ask KEY_FILE  "Path to the private key (PEM)"
     [[ -r $CERT_FILE && -r $KEY_FILE ]] || die "Cannot read the certificate or key file." ;;
  3) ;;
  4) le_choose
     # server_name: asked here (default: the certificate name); unattended runs keep the domain from the question above when the certificate covers it
     if (( AUTO )); then :
     elif (( NONINT_TLS )); then
       if [[ $SERVER_NAME != "$TLS_LE_NAME" ]] && le_covers "$LE_DIR/live/$TLS_LE_NAME/fullchain.pem" "$SERVER_NAME"; then :; else SERVER_NAME=$TLS_LE_NAME; fi
     else
       ask SERVER_NAME "Name in the site address (server_name)" "$TLS_LE_NAME"
     fi
     if [[ $SERVER_NAME =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then IS_IP=1; else IS_IP=0; fi
     le_check "$TLS_LE_NAME" "$SERVER_NAME" ;;
  *) die "Unknown choice: $TLS_MODE" ;;
esac
# What is remembered for the next run (the name only; the files stay where certbot keeps them)
SAVED_TLS_MODE=''; SAVED_LE_NAME=''
if [[ $TLS_MODE == 4 ]]; then
  SAVED_TLS_MODE=le-existing; SAVED_LE_NAME=$TLS_LE_NAME
elif [[ $TLS_MODE == 0 && $PREV_TLS_MODE == le-existing ]]; then
  SAVED_TLS_MODE=le-existing; SAVED_LE_NAME=$PREV_LE_NAME
fi

say "3/6 Database (PostgreSQL 16, listens on localhost only)"
# Other PostgreSQL clusters on this server are left alone; PMIS gets its own 16/main cluster.
PG16_PORT=$(awk '/^port *=/ {print $3}' /etc/postgresql/16/main/postgresql.conf 2>/dev/null || true)
if command -v pg_lsclusters >/dev/null && pg_lsclusters -h 2>/dev/null | grep -q .; then
  echo "PostgreSQL clusters already on this server (only 16/main is used by the PMIS):"
  pg_lsclusters | sed 's/^/   /'
fi
if [[ -n $PG16_PORT ]]; then
  DEFAULT_DB_PORT=$PG16_PORT
else
  DEFAULT_DB_PORT=5432
  while port_busy "$DEFAULT_DB_PORT"; do DEFAULT_DB_PORT=$((DEFAULT_DB_PORT + 1)); done
fi
ask DB_NAME "Database name" "${PREV_DB_NAME:-pmis}"
ask DB_PORT "PostgreSQL 16 port" "${PREV_DB_PORT:-$DEFAULT_DB_PORT}"
is_port "$DB_PORT" || die "Invalid port."
if [[ $DB_PORT != "${PG16_PORT:-}" ]] && port_busy "$DB_PORT"; then
  die "Port $DB_PORT is already used by another service. Choose a free port."
fi
[[ $DB_NAME =~ ^[a-z_][a-z0-9_]*$ ]] || die "Use lowercase letters, digits and _ only."
echo "The application role is pmis_app (fixed: the migrations grant rights to this name)."
if [[ -n $PREV_DB_PASSWORD ]] && ask_no "Keep the current password of pmis_app?"; then
  DB_APP_PASSWORD=$PREV_DB_PASSWORD
else
  ask_secret DB_APP_PASSWORD "Password for database role pmis_app"
fi
echo "The PostgreSQL superuser 'postgres' keeps peer login only (sudo -u postgres psql), no password over the network."

say "4/6 API service"
DEFAULT_API_PORT=${PREV_API_PORT:-3000}
if [[ -z $PREV_API_PORT ]]; then while port_busy "$DEFAULT_API_PORT"; do DEFAULT_API_PORT=$((DEFAULT_API_PORT + 1)); done; fi
echo "The API listens on 127.0.0.1 only; nginx forwards /api/ to it."
ask API_PORT "API port" "$DEFAULT_API_PORT"
is_port "$API_PORT" || die "Invalid port."
if [[ $API_PORT != "${PREV_API_PORT:-}" ]] && port_busy "$API_PORT"; then die "Port $API_PORT is already used. Choose a free port."; fi

say "Document storage (uploaded documents and photos)"
echo "Files are kept outside the database, under random names, never in a public place; every download goes through the API and is audited."
echo "  1) A directory on this server's disk (simple; fine for small installations)"
echo "  2) MinIO, an S3-compatible object store installed on this server (listens on 127.0.0.1 only; needs to download the MinIO program"
echo "     from dl.min.io, or a copy you place at /usr/local/bin/minio and /usr/local/bin/mc first)"
case ${PREV_STORAGE_MODE:-} in minio) DEF_STORAGE=2 ;; *) DEF_STORAGE=1 ;; esac
ask STORAGE_CHOICE "Choose" "$DEF_STORAGE"
case $STORAGE_CHOICE in
  1) STORAGE_MODE=local
     ask STORAGE_DIR "Directory for the documents" "${PREV_STORAGE_DIR:-/var/lib/gsdn-pmis/files}"
     [[ $STORAGE_DIR == /* ]] || die "Use an absolute path."
     [[ $STORAGE_DIR =~ ^[A-Za-z0-9_./-]+$ ]] || die "Use letters, digits and _ . / - only in the path." ;;
  2) STORAGE_MODE=minio
     STORAGE_DIR=${PREV_STORAGE_DIR:-/var/lib/gsdn-pmis/files}   # kept, so documents saved earlier on disk can be copied into the bucket
     ask MINIO_PORT "MinIO port (127.0.0.1)" "${PREV_MINIO_PORT:-9000}"
     is_port "$MINIO_PORT" || die "Invalid port."
     if [[ $MINIO_PORT != "${PREV_MINIO_PORT:-}" ]] && port_busy "$MINIO_PORT"; then die "Port $MINIO_PORT is already used. Choose a free port."; fi
     [[ $((MINIO_PORT + 1)) != "$API_PORT" ]] || die "MinIO also uses port $((MINIO_PORT + 1)) for its console: choose another port."
     ask MINIO_DIR "Directory for the MinIO data" "${PREV_MINIO_DIR:-/var/lib/gsdn-pmis/minio}"
     [[ $MINIO_DIR == /* && $MINIO_DIR =~ ^[A-Za-z0-9_./-]+$ ]] || die "Use an absolute path with letters, digits and _ . / - only." ;;
  *) die "Unknown choice: $STORAGE_CHOICE" ;;
esac

say "5/6 First System Admin"
psql_su() { sudo -u postgres env PGOPTIONS="-c client_min_messages=warning" psql -p "$DB_PORT" -v ON_ERROR_STOP=1 -qAt "$@"; }
# SQL string literal for a value sent on stdin (standard_conforming_strings is on: only ' needs doubling).
sql_lit() { local v=${1//\'/\'\'}; printf "'%s'" "$v"; }
ADMINS=0
if [[ -n $PG16_PORT && $PG16_PORT == "$DB_PORT" ]] && systemctl is-active -q postgresql@16-main 2>/dev/null; then
  ADMINS=$(psql_su -d "$DB_NAME" -c "SELECT count(*) FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active" 2>/dev/null || echo 0)
fi
NEED_ADMIN=0
if (( ADMINS > 0 )); then
  echo "A System Admin already exists ($ADMINS). Create more users from Users & Roles in the app."
else
  NEED_ADMIN=1
  echo "This account signs in to the PMIS first and creates everybody else. Use real details of the admin (not synthetic)."
  ask ADMIN_NAME  "Full name"
  ask ADMIN_EMAIL "Email"
  [[ $ADMIN_EMAIL == *@*.* ]] || die "That does not look like an email."
  ask_opt ADMIN_EMP "Employee ID (4 digits)"
  [[ -z $ADMIN_EMP || $ADMIN_EMP =~ ^[0-9]{4}$ ]] || die "The employee ID is 4 digits."
  ask_opt ADMIN_PHONE "Phone in international format (+2189...)"
  [[ -z $ADMIN_PHONE || $ADMIN_PHONE =~ ^\+[1-9][0-9]{7,14}$ ]] || die "Use the international format, for example +218911234567."
  echo "Password policy: 12 to 128 characters, not containing the email, ID or phone, not a common password."
  ask_secret ADMIN_PASSWORD "Password for this admin" 0
fi

say "6/6 Firewall"
USE_UFW=0
echo "Answer no if other apps on this server use ports besides SSH, HTTP and HTTPS: ufw would block them."
if (( ! AUTO )) && ask_yes "Enable the ufw firewall (allow only SSH, HTTP and HTTPS)?"; then
  USE_UFW=1
  ask SSH_PORT "Your SSH port (so you do not lock yourself out)" 22
  is_port "$SSH_PORT" || die "Invalid port."
fi

if (( HTTPS_PORT == 443 )); then APP_URL="https://$SERVER_NAME"; else APP_URL="https://$SERVER_NAME:$HTTPS_PORT"; fi

cat <<EOF

Summary
  Address:        $SERVER_NAME
  App URL:        $APP_URL
  HTTP port:      $HTTP_PORT (redirect)
  Certificate:    $( case $TLS_MODE in 0) echo "keep $PREV_CERT_PATH";; 1) echo "Let's Encrypt ($LE_EMAIL)";; 2) echo "$CERT_FILE";; 3) echo "self-signed";; 4) echo "existing Let's Encrypt $TLS_LE_NAME, in place ($LE_DIR/live/$TLS_LE_NAME)";; esac )
  Database:       $DB_NAME on 127.0.0.1:$DB_PORT, role pmis_app
  API:            127.0.0.1:$API_PORT (service gsdn-pmis-api)
  Documents:      $( [[ $STORAGE_MODE == minio ]] && echo "MinIO on 127.0.0.1:$MINIO_PORT, data in $MINIO_DIR, bucket pmis" || echo "local disk, $STORAGE_DIR" )
  First admin:    $( (( NEED_ADMIN )) && echo "$ADMIN_NAME <$ADMIN_EMAIL>" || echo "already exists" )
  Firewall:       $( (( USE_UFW )) && echo "ufw on, SSH port $SSH_PORT" || echo "not changed" )
EOF
(( AUTO )) || ask_yes "Start the installation?" || die "Cancelled. Nothing was changed."

# ---------------------------------------------------------------- packages
say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release git python3 nginx openssl

if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
  say "Installing Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "Node $(node -v), npm $(npm -v)"

if [[ ! -x /usr/lib/postgresql/16/bin/postgres ]]; then
  say "Installing PostgreSQL 16 (PGDG repository)"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-16
fi
# The package creates 16/main on the next free port only when no cluster exists yet.
[[ -d /etc/postgresql/16/main ]] || pg_createcluster 16 main -p "$DB_PORT"

# ---------------------------------------------------------------- PostgreSQL
say "Configuring PostgreSQL"
PG_CONF=/etc/postgresql/16/main/postgresql.conf
[[ -f $PG_CONF ]] || die "PostgreSQL 16 cluster 'main' not found."
sed -i -E "s/^#?port = .*/port = $DB_PORT/" "$PG_CONF"
sed -i -E "s/^#?listen_addresses = .*/listen_addresses = 'localhost'/" "$PG_CONF"
systemctl enable -q postgresql
systemctl restart postgresql@16-main

if [[ $(psql_su -c "SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app'") == 1 ]]; then
  printf 'ALTER ROLE pmis_app WITH LOGIN PASSWORD %s;\n' "$(sql_lit "$DB_APP_PASSWORD")" | psql_su >/dev/null
else
  printf 'CREATE ROLE pmis_app LOGIN PASSWORD %s;\n' "$(sql_lit "$DB_APP_PASSWORD")" | psql_su >/dev/null
  echo "Role pmis_app created."
fi

if [[ $(psql_su -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'") != 1 ]]; then
  sudo -u postgres createdb -p "$DB_PORT" "$DB_NAME"
  echo "Database $DB_NAME created."
fi

say "Applying migrations"
# Applied migrations are recorded in pmis_admin.migrations (outside the public schema, so the app role cannot see it).
psql_su -d "$DB_NAME" -c "CREATE SCHEMA IF NOT EXISTS pmis_admin" \
  -c "CREATE TABLE IF NOT EXISTS pmis_admin.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
RECORDED=$(psql_su -d "$DB_NAME" -c "SELECT count(*) FROM pmis_admin.migrations")
HAS_USERS=$(psql_su -d "$DB_NAME" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'")
if (( RECORDED == 0 && HAS_USERS == 1 )); then
  echo "   Adopting the existing database: migrations up to $LEGACY_LAST were applied by the first installer."
  for d in "$MIGRATIONS_DIR"/0*/; do
    n=$(basename "$d"); [[ $n > $LEGACY_LAST ]] && break
    psql_su -d "$DB_NAME" -c "INSERT INTO pmis_admin.migrations (name) VALUES ('$n') ON CONFLICT DO NOTHING"
  done
fi
APPLIED=0
APPLIED_NAMES=()
for d in "$MIGRATIONS_DIR"/0*/; do
  n=$(basename "$d")
  [[ $(psql_su -d "$DB_NAME" -c "SELECT 1 FROM pmis_admin.migrations WHERE name = '$n'") == 1 ]] && continue
  echo "   $n"
  # Each migration and its record commit together, or neither does.
  { echo "BEGIN;"; cat "$d/migration.sql"; echo; echo "INSERT INTO pmis_admin.migrations (name) VALUES ('$n');"; echo "COMMIT;"; } \
    | psql_su -d "$DB_NAME" >/dev/null
  APPLIED=$((APPLIED + 1))
  APPLIED_NAMES+=("$n")
done
(( APPLIED )) || echo "   Nothing new."
psql_su -d "$DB_NAME" < "$PMIS_DIR/db/sql/app_grants.sql" >/dev/null
echo "   Application role rights refreshed (db/sql/app_grants.sql)."
# Deployment log (migration 0045, GET /admin/deployments): version, git commit, the migrations of this run, who and where. update.sh runs this script too.
if [[ $(psql_su -d "$DB_NAME" -c "SELECT 1 FROM pg_proc WHERE proname = 'log_deployment'") == 1 ]]; then
  DEPLOY_VERSION=$(sed -n 's/^  version: *//p' "$PMIS_DIR/contracts/openapi.yaml" | head -1)
  DEPLOY_SHA=$(git -C "$PMIS_DIR" rev-parse HEAD 2>/dev/null || true)
  [[ $DEPLOY_SHA =~ ^[0-9a-f]{7,40}$ ]] || DEPLOY_SHA=""
  DEPLOY_MIGRATIONS="{$(IFS=,; echo "${APPLIED_NAMES[*]}")}"
  printf 'SELECT log_deployment(%s, nullif(%s, %s), %s::text[], %s, %s);\n' "$(sql_lit "${DEPLOY_VERSION:-unknown}")" "$(sql_lit "$DEPLOY_SHA")" "''" \
    "$(sql_lit "$DEPLOY_MIGRATIONS")" "$(sql_lit "${SUDO_USER:-$(id -un)}")" "$(sql_lit "$(hostname)")" | psql_su -d "$DB_NAME" >/dev/null \
    && echo "   Deployment recorded (version ${DEPLOY_VERSION:-unknown})."
fi

# ---------------------------------------------------------------- API
say "Building the API"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir /opt/gsdn-pmis --shell /usr/sbin/nologin "$SERVICE_USER"
cd "$API_SRC"
npm ci --no-audit --no-fund
npx prisma generate >/dev/null
npm run build
install -d /opt/gsdn-pmis
rm -rf "$API_ROOT.new"
install -d "$API_ROOT.new"
cp -a dist node_modules package.json prisma "$API_ROOT.new/"
rm -rf "$API_ROOT.old"; [[ -d $API_ROOT ]] && mv "$API_ROOT" "$API_ROOT.old"
mv "$API_ROOT.new" "$API_ROOT"
chown -R root:root "$API_ROOT"
cd - >/dev/null

install -d -m 750 -o root -g "$SERVICE_USER" "$CONF_DIR"

# ---------------------------------------------------------------- document storage
S3_LINES=''
if [[ $STORAGE_MODE == minio ]]; then
  say "Setting up MinIO"
  MINIO_ARCH=$(uname -m)
  case $MINIO_ARCH in x86_64) MINIO_ARCH=amd64 ;; aarch64) MINIO_ARCH=arm64 ;; *) die "MinIO is not set up for $MINIO_ARCH: use local disk storage." ;; esac
  for tool in minio mc; do
    if ! command -v "$tool" >/dev/null && [[ ! -x /usr/local/bin/$tool ]]; then
      if [[ $tool == minio ]]; then url="https://dl.min.io/server/minio/release/linux-$MINIO_ARCH/minio"; else url="https://dl.min.io/client/mc/release/linux-$MINIO_ARCH/mc"; fi
      echo "   Downloading $tool from dl.min.io"
      curl -fsSL -o "/usr/local/bin/$tool.part" "$url" || { rm -f "/usr/local/bin/$tool.part"; die "Could not download $tool. Place the program at /usr/local/bin/$tool yourself (chmod 755) and run the installer again, or choose local disk storage."; }
      chmod 755 "/usr/local/bin/$tool.part"; mv "/usr/local/bin/$tool.part" "/usr/local/bin/$tool"
    fi
  done
  MINIO_BIN=$(command -v minio); MC_BIN=$(command -v mc)
  id -u gsdn-minio >/dev/null 2>&1 || useradd --system --home-dir "$MINIO_DIR" --shell /usr/sbin/nologin gsdn-minio
  install -d -m 700 -o gsdn-minio -g gsdn-minio "$MINIO_DIR"
  MINIO_ROOT_PASSWORD=${PREV_MINIO_ROOT_PASSWORD:-$(openssl rand -hex 24)}
  umask 077
  cat > "$CONF_DIR/minio.env" <<EOF
# MinIO settings written by install-ubuntu.sh on $(date -Is). Keep this file private (root and gsdn-minio only).
MINIO_ROOT_USER=pmis-root
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
MINIO_VOLUMES=$MINIO_DIR
MINIO_OPTS=--address 127.0.0.1:$MINIO_PORT --console-address 127.0.0.1:$((MINIO_PORT + 1))
EOF
  umask 022
  chown root:gsdn-minio "$CONF_DIR/minio.env"; chmod 640 "$CONF_DIR/minio.env"
  cat > /etc/systemd/system/gsdn-pmis-minio.service <<EOF
[Unit]
Description=GSDN PMIS MinIO object storage
After=network.target

[Service]
User=gsdn-minio
Group=gsdn-minio
EnvironmentFile=$CONF_DIR/minio.env
ExecStart=$MINIO_BIN server \$MINIO_OPTS \$MINIO_VOLUMES
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$MINIO_DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable -q gsdn-pmis-minio
  systemctl restart gsdn-pmis-minio
  for i in $(seq 1 30); do curl -fs "http://127.0.0.1:$MINIO_PORT/minio/health/live" >/dev/null && break; sleep 1; done
  curl -fs "http://127.0.0.1:$MINIO_PORT/minio/health/live" >/dev/null || { journalctl -u gsdn-pmis-minio -n 20 --no-pager; die "MinIO did not start (see the log above)."; }
  # the bucket is private; the API's user can use this one bucket only (it cannot administer MinIO or read other buckets)
  MC_DIR=$(mktemp -d); export MC_CONFIG_DIR=$MC_DIR
  "$MC_BIN" alias set pmislocal "http://127.0.0.1:$MINIO_PORT" pmis-root "$MINIO_ROOT_PASSWORD" >/dev/null
  "$MC_BIN" mb --ignore-existing pmislocal/pmis >/dev/null
  S3_ACCESS_KEY=${PREV_S3_ACCESS_KEY:-pmis-app}
  S3_SECRET_KEY=${PREV_S3_SECRET_KEY:-$(openssl rand -hex 24)}
  cat > "$MC_DIR/policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],"Resource":["arn:aws:s3:::pmis","arn:aws:s3:::pmis/*"]}]}
EOF
  "$MC_BIN" admin policy create pmislocal pmis-bucket-rw "$MC_DIR/policy.json" >/dev/null 2>&1 || true
  if ! "$MC_BIN" admin user info pmislocal "$S3_ACCESS_KEY" >/dev/null 2>&1; then
    "$MC_BIN" admin user add pmislocal "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
  fi
  "$MC_BIN" admin policy attach pmislocal pmis-bucket-rw --user "$S3_ACCESS_KEY" >/dev/null 2>&1 || true
  # documents saved on local disk before MinIO was chosen keep their keys: copy them into the bucket (a re-run copies only what is new)
  if [[ -d $STORAGE_DIR && -n $(ls -A "$STORAGE_DIR" 2>/dev/null) ]]; then
    echo "   Copying the documents saved on local disk ($STORAGE_DIR) into the bucket"
    "$MC_BIN" mirror --quiet "$STORAGE_DIR" pmislocal/pmis >/dev/null
  fi
  unset MC_CONFIG_DIR; rm -rf "$MC_DIR"
  S3_LINES="S3_ENDPOINT=http://127.0.0.1:$MINIO_PORT
S3_BUCKET=pmis
S3_ACCESS_KEY=$S3_ACCESS_KEY
S3_SECRET_KEY=$S3_SECRET_KEY
S3_REGION=us-east-1"
  API_AFTER=" gsdn-pmis-minio.service"
  echo "MinIO is up on 127.0.0.1:$MINIO_PORT; bucket pmis (private)."
else
  API_AFTER=''
  install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STORAGE_DIR"
  S3_LINES="STORAGE_DIR=$STORAGE_DIR"
fi

DB_URL_PW=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().rstrip("\n"), safe=""))' <<<"$DB_APP_PASSWORD")
LOG_HMAC_KEY=${PREV_LOG_HMAC_KEY:-$(openssl rand -hex 32)}
# Two-factor secrets are encrypted with this key (32 bytes). An update keeps the existing one and creates it for an installation that lacks it. Never regenerate a key that is in use: every enrolled user would have to enrol again.
TOTP_ENC_KEY=${PREV_TOTP_ENC_KEY:-$(openssl rand -hex 32)}
# Stored files are encrypted with this key (32 bytes, ADR 0008 amendment). Kept on update; never regenerate a key in use (the stored files
# could not be read). Settings of the optional steps (virus scan, key id, old keys) are kept from the previous file as they are.
FILE_ENC_KEY=${PREV_FILE_ENC_KEY:-$(openssl rand -hex 32)}
KEEP_LINES=$( [[ -r $CONF_DIR/pmis.env ]] && grep -E '^(FILE_ENC_KEY_ID|FILE_ENC_OLD_KEYS|MALWARE_SCAN|CLAMD_SOCKET|CLAMD_HOST|CLAMD_PORT|CLAMD_TIMEOUT_MS|SCAN_FAILURE)=' "$CONF_DIR/pmis.env" || true )
grep -q '^FILE_ENC_KEY_ID=' <<<"$KEEP_LINES" || KEEP_LINES="${KEEP_LINES:+$KEEP_LINES
}FILE_ENC_KEY_ID=k1"
umask 027
cat > "$CONF_DIR/pmis.env" <<EOF
# GSDN PMIS settings written by install-ubuntu.sh on $(date -Is). Keep this file private.
NODE_ENV=production
APP_URL=$APP_URL
HOST=127.0.0.1
PORT=$API_PORT
COOKIE_SECURE=true
DATABASE_URL=postgresql://pmis_app:$DB_URL_PW@127.0.0.1:$DB_PORT/$DB_NAME
LOG_HMAC_KEY=$LOG_HMAC_KEY
TOTP_ENC_KEY=$TOTP_ENC_KEY
FILE_ENC_KEY=$FILE_ENC_KEY
$KEEP_LINES
$S3_LINES
EOF
cat > "$CONF_DIR/install.conf" <<EOF
# Answers of the last run of install-ubuntu.sh (no secrets). They are the defaults of the next run.
PREV_SERVER_NAME='$SERVER_NAME'
PREV_HTTPS_PORT='$HTTPS_PORT'
PREV_HTTP_PORT='$HTTP_PORT'
PREV_API_PORT='$API_PORT'
PREV_STORAGE_MODE='$STORAGE_MODE'
PREV_STORAGE_DIR='$STORAGE_DIR'
PREV_MINIO_PORT='${MINIO_PORT:-}'
PREV_MINIO_DIR='${MINIO_DIR:-}'
PREV_TLS_MODE='$SAVED_TLS_MODE'
PREV_LE_NAME='$SAVED_LE_NAME'
EOF
umask 022
chown root:"$SERVICE_USER" "$CONF_DIR/pmis.env"; chmod 640 "$CONF_DIR/pmis.env"; chmod 600 "$CONF_DIR/install.conf"

cat > /etc/systemd/system/gsdn-pmis-api.service <<EOF
[Unit]
Description=GSDN PMIS API
After=network.target postgresql@16-main.service$API_AFTER
Requires=postgresql@16-main.service

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$API_ROOT
EnvironmentFile=$CONF_DIR/pmis.env
ExecStart=/usr/bin/node $API_ROOT/dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=-$STORAGE_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q gsdn-pmis-api
systemctl restart gsdn-pmis-api
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/api/v1/auth/session" || true)
  [[ $code == 401 || $code == 200 ]] && break
  sleep 1
done
[[ ${code:-} == 401 || ${code:-} == 200 ]] || { journalctl -u gsdn-pmis-api -n 30 --no-pager; die "The API did not start (see the log above)."; }
echo "API is up on 127.0.0.1:$API_PORT."

if (( NEED_ADMIN )); then
  say "Creating the first System Admin"
  ADMIN_HASH=$(printf '%s' "$ADMIN_PASSWORD" | node "$API_ROOT/dist/cli.js" hash-password) || die "The password was refused (see the message above). Run the installer again."
  printf 'SELECT idm_bootstrap_admin(%s, %s, nullif(%s, %s), nullif(%s, %s), %s);\n' \
    "$(sql_lit "$ADMIN_EMAIL")" "$(sql_lit "$ADMIN_NAME")" "$(sql_lit "$ADMIN_EMP")" "''" "$(sql_lit "$ADMIN_PHONE")" "''" "$(sql_lit "$ADMIN_HASH")" \
    | psql_su -d "$DB_NAME" >/dev/null
  unset ADMIN_PASSWORD ADMIN_HASH
  echo "Created. Sign in with $ADMIN_EMAIL${ADMIN_EMP:+ or $ADMIN_EMP} and the password you typed."
  echo "Two-factor (TOTP) is off for this account. Nobody turns it on or off for themselves: create a second System Admin, who can turn it on for you in Users & Roles."
  echo "If an admin loses the authenticator and no other admin exists, reset it on the server: sudo bash $PMIS_DIR/tools/install/reset-two-factor.sh <email> (add --disable to turn it off). A reset prints a one-time enrolment code for the user."
fi

# ---------------------------------------------------------------- optional: virus scan and backup of the stored files (owner answer Q134)
# Each step asks once; an update keeps the answer (the settings it wrote stay in pmis.env and backup.env).
if grep -q '^MALWARE_SCAN=clamd' "$CONF_DIR/pmis.env"; then CLAM_ON=1; elif (( AUTO )); then CLAM_ON=0; elif ask_yes "Install the ClamAV virus scan for uploads (needs about 1 GB of disk and an internet connection for the signatures)?"; then CLAM_ON=1; else CLAM_ON=0; fi
if (( CLAM_ON )); then say "Setting up the ClamAV virus scan"; bash "$PMIS_DIR/tools/install/install-clamav.sh"; fi
if [[ -r $CONF_DIR/backup.env ]]; then BACKUP_ON=1; elif (( AUTO )); then BACKUP_ON=0; elif ask_yes "Back up the stored files every night with restic (encrypted, 14 daily, 8 weekly, 12 monthly)?"; then BACKUP_ON=1; else BACKUP_ON=0; fi
if (( BACKUP_ON )); then say "Setting up the nightly backup of the stored files"; bash "$PMIS_DIR/tools/install/install-file-backup.sh"; fi
if [[ -r /etc/pgbackrest/db-backup.env ]]; then DBBACKUP_ON=1; elif (( AUTO )); then DBBACKUP_ON=0; elif ask_yes "Back up the database with pgBackRest (point-in-time restore, WAL every 5 minutes, encrypted, a copy in another building)?"; then DBBACKUP_ON=1; else DBBACKUP_ON=0; fi
if (( DBBACKUP_ON )); then say "Setting up the database backup (pgBackRest)"; bash "$PMIS_DIR/tools/install/install-db-backup.sh"; fi

# ---------------------------------------------------------------- web app
say "Building the web app"
cd "$WEB_DIR"
npm ci --no-audit --no-fund
# Sign-in and users go to the real API; the other screens keep sample data until their API exists (ADR 0012).
VITE_USE_MOCKS=true VITE_REAL_API=auth-users VITE_API_BASE_URL=/api/v1 npm run build
install -d "$WEB_ROOT"
rm -rf "${WEB_ROOT:?}"/*
cp -a dist/. "$WEB_ROOT/"
cd - >/dev/null

# ---------------------------------------------------------------- certificate
say "Preparing the HTTPS certificate"
install -d "$TLS_DIR" "$ACME_ROOT"
case $TLS_MODE in
  0) CERT_PATH=$PREV_CERT_PATH; KEY_PATH=$PREV_KEY_PATH ;;
  1) # Temporary HTTP server for the ACME challenge, then the real certificate.
     cat > "$SITE" <<EOF
server {
  listen $HTTP_PORT;
  server_name $SERVER_NAME;
  location /.well-known/acme-challenge/ { root $ACME_ROOT; }
}
EOF
     ln -sf "$SITE" /etc/nginx/sites-enabled/gsdn-pmis
     rm -f /etc/nginx/sites-enabled/default
     nginx -t && systemctl reload nginx
     command -v certbot >/dev/null || apt-get install -y -qq certbot
     certbot certonly --webroot -w "$ACME_ROOT" -d "$SERVER_NAME" -m "$LE_EMAIL" --agree-tos -n
     CERT_PATH=/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem
     KEY_PATH=/etc/letsencrypt/live/$SERVER_NAME/privkey.pem
     install -d /etc/letsencrypt/renewal-hooks/deploy
     printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
     chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx ;;
  2) install -m 644 "$CERT_FILE" "$TLS_DIR/fullchain.pem"
     install -m 600 "$KEY_FILE"  "$TLS_DIR/privkey.pem"
     CERT_PATH=$TLS_DIR/fullchain.pem; KEY_PATH=$TLS_DIR/privkey.pem ;;
  3) if (( IS_IP )); then SAN="IP:$SERVER_NAME"; else SAN="DNS:$SERVER_NAME"; fi
     openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
       -keyout "$TLS_DIR/privkey.pem" -out "$TLS_DIR/fullchain.pem" \
       -subj "/CN=$SERVER_NAME" -addext "subjectAltName=$SAN" 2>/dev/null
     chmod 600 "$TLS_DIR/privkey.pem"
     CERT_PATH=$TLS_DIR/fullchain.pem; KEY_PATH=$TLS_DIR/privkey.pem ;;
  4) CERT_PATH=$LE_DIR/live/$TLS_LE_NAME/fullchain.pem; KEY_PATH=$LE_DIR/live/$TLS_LE_NAME/privkey.pem
     le_renewal_hook ;;
esac

# ---------------------------------------------------------------- nginx
say "Configuring nginx"
if (( HTTPS_PORT == 443 )); then REDIRECT_HOST='$host'; else REDIRECT_HOST="\$host:$HTTPS_PORT"; fi
# the site as it is now, put back if nginx rejects the new one (nothing is reloaded in that case)
SITE_BEFORE=$(mktemp)
if [[ -f $SITE ]]; then cp -f "$SITE" "$SITE_BEFORE"; else rm -f "$SITE_BEFORE"; fi
cat > "$SITE" <<EOF
server {
  listen $HTTP_PORT;
  server_name $SERVER_NAME;
  location /.well-known/acme-challenge/ { root $ACME_ROOT; }
  location / { return 301 https://$REDIRECT_HOST\$request_uri; }
}

server {
  listen $HTTPS_PORT ssl;
  http2 on;
  server_name $SERVER_NAME;

  ssl_certificate     $CERT_PATH;
  ssl_certificate_key $KEY_PATH;
  ssl_protocols TLSv1.2 TLSv1.3;

  root $WEB_ROOT;
  index index.html;

  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Referrer-Policy same-origin always;
  add_header Strict-Transport-Security "max-age=31536000" always;

  location /api/ {
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 120s;
    client_max_body_size 25m;
  }
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files \$uri =404; }
  location = /mockServiceWorker.js { add_header Cache-Control "no-cache"; try_files \$uri =404; }
  location = /index.html { add_header Cache-Control "no-cache"; }
  location / { try_files \$uri /index.html; }
}
EOF
ln -sf "$SITE" /etc/nginx/sites-enabled/gsdn-pmis
rm -f /etc/nginx/sites-enabled/default
# nginx before 1.25 does not know "http2 on;": fall back to the old syntax.
if ! nginx -t 2>/dev/null; then
  sed -i -e '/^  http2 on;$/d' -e "s/listen $HTTPS_PORT ssl;/listen $HTTPS_PORT ssl http2;/" "$SITE"
fi
if ! nginx -t; then
  if [[ -s $SITE_BEFORE ]]; then cp -f "$SITE_BEFORE" "$SITE"; warn "The previous nginx site was put back ($SITE); nginx was not reloaded."
  else rm -f "$SITE"; fi
  rm -f "$SITE_BEFORE"
  die "nginx rejected the new configuration (see the messages above). Fix it, then run the installer again."
fi
rm -f "$SITE_BEFORE"
systemctl enable -q nginx
systemctl reload nginx || systemctl restart nginx

# ---------------------------------------------------------------- firewall
if (( USE_UFW )); then
  say "Configuring ufw"
  apt-get install -y -qq ufw
  ufw allow "$SSH_PORT/tcp"
  ufw allow "$HTTP_PORT/tcp"
  ufw allow "$HTTPS_PORT/tcp"
  ufw --force enable
fi

# ---------------------------------------------------------------- done
say "Done"
cat <<EOF
Open:            $APP_URL
Sign in:         your local account (employee ID, email or phone, and password)
API service:     systemctl status gsdn-pmis-api   |   journalctl -u gsdn-pmis-api -f
Database:        sudo -u postgres psql -p $DB_PORT $DB_NAME
Documents:       $( [[ $STORAGE_MODE == minio ]] && echo "MinIO on 127.0.0.1:$MINIO_PORT (systemctl status gsdn-pmis-minio), bucket pmis" || echo "local disk, $STORAGE_DIR" )
Settings:        $CONF_DIR/pmis.env (secrets; readable by root and the API service only)
Upgrade later:   git pull, then run this script again and press Enter at each question
EOF
if [[ $TLS_MODE == 3 ]]; then
  warn "Self-signed certificate: copy $TLS_DIR/fullchain.pem to each client PC and install it as a"
  warn "trusted root certificate, or the browser will block the app's service worker."
fi
