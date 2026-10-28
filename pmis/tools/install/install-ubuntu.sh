#!/usr/bin/env bash
# GSDN PMIS: interactive installer and upgrader for Ubuntu 22.04 / 24.04.
#
# Installs what the repository can run today (see HANDOVER.md §2 and ADR 0012):
#   - PostgreSQL 16 with the PMIS database, the pmis_app role and every migration not applied yet
#   - the API (apps/api, NestJS) as the systemd service gsdn-pmis-api: local sign-in, users and groups
#   - the first System Admin (asked here, only while none exists)
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
PREV_DB_PASSWORD='' PREV_API_PORT='' PREV_LOG_HMAC_KEY=''
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
  PREV_API_PORT=${PREV_API_PORT:-$(sed -n 's/^PORT=//p' "$CONF_DIR/pmis.env")}
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
if (( HAVE_CERT )); then DEF_TLS=0; elif (( IS_IP )); then DEF_TLS=3; else DEF_TLS=1; fi
ask TLS_MODE "Choose" "$DEF_TLS"
case $TLS_MODE in
  0) (( HAVE_CERT )) || die "There is no current certificate to keep." ;;
  1) (( IS_IP )) && die "Let's Encrypt does not issue certificates for an IP address."
     [[ $HTTP_PORT == 80 ]] || die "Let's Encrypt needs the HTTP port to be 80."
     ask LE_EMAIL "Email for Let's Encrypt expiry notices" ;;
  2) ask CERT_FILE "Path to the certificate (full chain, PEM)"
     ask KEY_FILE  "Path to the private key (PEM)"
     [[ -r $CERT_FILE && -r $KEY_FILE ]] || die "Cannot read the certificate or key file." ;;
  3) ;;
  *) die "Unknown choice: $TLS_MODE" ;;
esac

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
  Certificate:    $( case $TLS_MODE in 0) echo "keep $PREV_CERT_PATH";; 1) echo "Let's Encrypt ($LE_EMAIL)";; 2) echo "$CERT_FILE";; 3) echo "self-signed";; esac )
  Database:       $DB_NAME on 127.0.0.1:$DB_PORT, role pmis_app
  API:            127.0.0.1:$API_PORT (service gsdn-pmis-api)
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
for d in "$MIGRATIONS_DIR"/0*/; do
  n=$(basename "$d")
  [[ $(psql_su -d "$DB_NAME" -c "SELECT 1 FROM pmis_admin.migrations WHERE name = '$n'") == 1 ]] && continue
  echo "   $n"
  # Each migration and its record commit together, or neither does.
  { echo "BEGIN;"; cat "$d/migration.sql"; echo; echo "INSERT INTO pmis_admin.migrations (name) VALUES ('$n');"; echo "COMMIT;"; } \
    | psql_su -d "$DB_NAME" >/dev/null
  APPLIED=$((APPLIED + 1))
done
(( APPLIED )) || echo "   Nothing new."
psql_su -d "$DB_NAME" < "$PMIS_DIR/db/sql/app_grants.sql" >/dev/null
echo "   Application role rights refreshed (db/sql/app_grants.sql)."

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
DB_URL_PW=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().rstrip("\n"), safe=""))' <<<"$DB_APP_PASSWORD")
LOG_HMAC_KEY=${PREV_LOG_HMAC_KEY:-$(openssl rand -hex 32)}
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
EOF
cat > "$CONF_DIR/install.conf" <<EOF
# Answers of the last run of install-ubuntu.sh (no secrets). They are the defaults of the next run.
PREV_SERVER_NAME='$SERVER_NAME'
PREV_HTTPS_PORT='$HTTPS_PORT'
PREV_HTTP_PORT='$HTTP_PORT'
PREV_API_PORT='$API_PORT'
EOF
umask 022
chown root:"$SERVICE_USER" "$CONF_DIR/pmis.env"; chmod 640 "$CONF_DIR/pmis.env"; chmod 600 "$CONF_DIR/install.conf"

cat > /etc/systemd/system/gsdn-pmis-api.service <<EOF
[Unit]
Description=GSDN PMIS API
After=network.target postgresql@16-main.service
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
fi

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
esac

# ---------------------------------------------------------------- nginx
say "Configuring nginx"
if (( HTTPS_PORT == 443 )); then REDIRECT_HOST='$host'; else REDIRECT_HOST="\$host:$HTTPS_PORT"; fi
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
nginx -t
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
Settings:        $CONF_DIR/pmis.env (secrets; readable by root and the API service only)
Upgrade later:   git pull, then run this script again and press Enter at each question
EOF
if [[ $TLS_MODE == 3 ]]; then
  warn "Self-signed certificate: copy $TLS_DIR/fullchain.pem to each client PC and install it as a"
  warn "trusted root certificate, or the browser will block the app's service worker."
fi
