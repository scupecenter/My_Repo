#!/usr/bin/env bash
# GSDN PMIS: interactive installer for Ubuntu 22.04 / 24.04.
#
# Installs what the repository can run today (see HANDOVER.md §2):
#   - PostgreSQL 16 with the PMIS database, the pmis_app role and migrations 0001-0009
#   - the web app (apps/web) built in mock mode (MSW), served by nginx over HTTPS
# The API (apps/api/src) is not written yet, so the web app does not talk to the database.
#
# Every value (address, ports, database name, passwords) is asked here, on the server.
# Nothing secret is written to the repository. Run from the repository checkout:
#   sudo bash pmis/tools/install/install-ubuntu.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PMIS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$PMIS_DIR/apps/api/prisma/migrations"
WEB_DIR="$PMIS_DIR/apps/web"
WEB_ROOT=/var/www/gsdn-pmis
CONF_DIR=/etc/gsdn-pmis
TLS_DIR=/etc/ssl/gsdn-pmis
ACME_ROOT=/var/www/letsencrypt

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

# ask VAR "Question" [default]
ask() {
  local __var=$1 __q=$2 __def=${3-} __ans
  if [[ -n $__def ]]; then read -rp "$__q [$__def]: " __ans; else read -rp "$__q: " __ans; fi
  __ans=${__ans:-$__def}
  [[ -n $__ans ]] || die "A value is required: $__q"
  printf -v "$__var" '%s' "$__ans"
}

# ask_secret VAR "Question": hidden input, asked twice; empty generates a random one.
ask_secret() {
  local __var=$1 __q=$2 __a __b
  read -rsp "$__q (leave empty to generate one): " __a; echo
  if [[ -z $__a ]]; then
    __a=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
    echo "   Generated. It will be saved in $CONF_DIR/pmis.env (readable by root only)."
  else
    read -rsp "   Repeat: " __b; echo
    [[ $__a == "$__b" ]] || die "The two entries do not match."
    (( ${#__a} >= 12 )) || die "Use at least 12 characters."
  fi
  printf -v "$__var" '%s' "$__a"
}

ask_yes() { local a; read -rp "$1 [y/N]: " a; [[ $a =~ ^[Yy] ]]; }

is_port() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }

# ---------------------------------------------------------------- preflight
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"
[[ -r /etc/os-release ]] && . /etc/os-release
[[ ${ID:-} == ubuntu ]] || die "This script supports Ubuntu only (found: ${PRETTY_NAME:-unknown})."
[[ -d $MIGRATIONS_DIR && -f $WEB_DIR/package.json ]] || die "Run it from inside the repository checkout ($PMIS_DIR looks wrong)."
command -v openssl >/dev/null || apt-get install -y -qq openssl

cat <<EOF

GSDN PMIS installer
Repository: $PMIS_DIR
Ubuntu:     $PRETTY_NAME

Answer the questions below. Press Enter to accept the value in [brackets].
EOF

# ---------------------------------------------------------------- questions
say "1/4 Server address"
DEFAULT_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Enter the domain name if you have one (for example pmis.example.ly), or the server IP."
ask SERVER_NAME "Domain or IP" "$DEFAULT_IP"
if [[ $SERVER_NAME =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then IS_IP=1; else IS_IP=0; fi

ask HTTPS_PORT "HTTPS port" 443
ask HTTP_PORT  "HTTP port (redirects to HTTPS)" 80
is_port "$HTTPS_PORT" && is_port "$HTTP_PORT" || die "Ports must be numbers between 1 and 65535."

say "2/4 HTTPS certificate"
echo "The web app needs HTTPS: browsers refuse its mock service worker on plain HTTP or with an untrusted certificate."
echo "  1) Let's Encrypt  (needs a public domain pointing to this server and port 80 reachable)"
echo "  2) My own certificate files (for example from your internal CA)"
echo "  3) Self-signed    (you must then install the certificate as trusted on every client PC)"
if (( IS_IP )); then ask TLS_MODE "Choose 2 or 3" 3; else ask TLS_MODE "Choose 1, 2 or 3" 1; fi
case $TLS_MODE in
  1) (( IS_IP )) && die "Let's Encrypt does not issue certificates for an IP address."
     [[ $HTTP_PORT == 80 ]] || die "Let's Encrypt needs the HTTP port to be 80."
     ask LE_EMAIL "Email for Let's Encrypt expiry notices" ;;
  2) ask CERT_FILE "Path to the certificate (full chain, PEM)"
     ask KEY_FILE  "Path to the private key (PEM)"
     [[ -r $CERT_FILE && -r $KEY_FILE ]] || die "Cannot read the certificate or key file." ;;
  3) ;;
  *) die "Unknown choice: $TLS_MODE" ;;
esac

say "3/4 Database (PostgreSQL 16, listens on localhost only)"
ask DB_NAME "Database name" pmis
ask DB_PORT "PostgreSQL port" 5432
is_port "$DB_PORT" || die "Invalid port."
[[ $DB_NAME =~ ^[a-z_][a-z0-9_]*$ ]] || die "Use lowercase letters, digits and _ only."
echo "The application role is pmis_app (fixed: the migrations grant rights to this name)."
ask_secret DB_APP_PASSWORD "Password for database role pmis_app"
echo "The PostgreSQL superuser 'postgres' keeps peer login only (sudo -u postgres psql), no password over the network."

say "4/4 Firewall"
USE_UFW=0
if ask_yes "Enable the ufw firewall (allow only SSH, HTTP and HTTPS)?"; then
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
  Certificate:    $( case $TLS_MODE in 1) echo "Let's Encrypt ($LE_EMAIL)";; 2) echo "$CERT_FILE";; 3) echo "self-signed";; esac )
  Database:       $DB_NAME on 127.0.0.1:$DB_PORT, role pmis_app
  Firewall:       $( (( USE_UFW )) && echo "ufw on, SSH port $SSH_PORT" || echo "not changed" )
EOF
ask_yes "Start the installation?" || die "Cancelled. Nothing was changed."

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
  apt-get install -y -qq postgresql-16 postgresql-contrib-16
fi

# ---------------------------------------------------------------- PostgreSQL
say "Configuring PostgreSQL"
PG_CONF=/etc/postgresql/16/main/postgresql.conf
[[ -f $PG_CONF ]] || die "PostgreSQL 16 cluster 'main' not found."
sed -i -E "s/^#?port = .*/port = $DB_PORT/" "$PG_CONF"
sed -i -E "s/^#?listen_addresses = .*/listen_addresses = 'localhost'/" "$PG_CONF"
systemctl enable -q postgresql
systemctl restart postgresql@16-main

psql_su() { sudo -u postgres env PGOPTIONS="-c client_min_messages=warning" psql -p "$DB_PORT" -v ON_ERROR_STOP=1 -qAt "$@"; }

if [[ $(psql_su -c "SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app'") == 1 ]]; then
  psql_su -v pw="$DB_APP_PASSWORD" <<'SQL'
ALTER ROLE pmis_app WITH LOGIN PASSWORD :'pw';
SQL
  echo "Role pmis_app existed: password updated."
else
  psql_su -v pw="$DB_APP_PASSWORD" <<'SQL'
CREATE ROLE pmis_app LOGIN PASSWORD :'pw';
SQL
  echo "Role pmis_app created."
fi

if [[ $(psql_su -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'") != 1 ]]; then
  sudo -u postgres createdb -p "$DB_PORT" "$DB_NAME"
  echo "Database $DB_NAME created."
fi

TABLES=$(psql_su -d "$DB_NAME" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
if (( TABLES > 0 )); then
  warn "Database $DB_NAME already has $TABLES tables: migrations skipped (they are not re-runnable)."
else
  say "Running migrations"
  for d in "$MIGRATIONS_DIR"/0*/; do
    echo "   $(basename "$d")"
    psql_su -d "$DB_NAME" < "$d/migration.sql" >/dev/null
  done
fi

install -d -m 700 "$CONF_DIR"
DB_URL_PW=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$DB_APP_PASSWORD")
umask 077
cat > "$CONF_DIR/pmis.env" <<EOF
# GSDN PMIS settings written by install-ubuntu.sh on $(date -Is). Keep this file private.
APP_URL=$APP_URL
DATABASE_URL=postgresql://pmis_app:$DB_URL_PW@127.0.0.1:$DB_PORT/$DB_NAME
EOF
umask 022
chmod 600 "$CONF_DIR/pmis.env"

# ---------------------------------------------------------------- web app
say "Building the web app (mock mode)"
cd "$WEB_DIR"
npm ci --no-audit --no-fund
VITE_USE_MOCKS=true VITE_API_BASE_URL=/api/v1 npm run build
install -d "$WEB_ROOT"
rm -rf "${WEB_ROOT:?}"/*
cp -a dist/. "$WEB_ROOT/"
cd - >/dev/null

# ---------------------------------------------------------------- certificate
say "Preparing the HTTPS certificate"
install -d "$TLS_DIR" "$ACME_ROOT"
case $TLS_MODE in
  1) # Temporary HTTP server for the ACME challenge, then the real certificate.
     cat > /etc/nginx/sites-available/gsdn-pmis <<EOF
server {
  listen $HTTP_PORT;
  server_name $SERVER_NAME;
  location /.well-known/acme-challenge/ { root $ACME_ROOT; }
}
EOF
     ln -sf /etc/nginx/sites-available/gsdn-pmis /etc/nginx/sites-enabled/gsdn-pmis
     rm -f /etc/nginx/sites-enabled/default
     nginx -t && systemctl reload nginx
     apt-get install -y -qq certbot
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
cat > /etc/nginx/sites-available/gsdn-pmis <<EOF
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

  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files \$uri =404; }
  location = /mockServiceWorker.js { add_header Cache-Control "no-cache"; try_files \$uri =404; }
  location = /index.html { add_header Cache-Control "no-cache"; }
  location / { try_files \$uri /index.html; }
}
EOF
ln -sf /etc/nginx/sites-available/gsdn-pmis /etc/nginx/sites-enabled/gsdn-pmis
rm -f /etc/nginx/sites-enabled/default
# nginx before 1.25 does not know "http2 on;": fall back to the old syntax.
if ! nginx -t 2>/dev/null; then
  sed -i -e '/^  http2 on;$/d' -e "s/listen $HTTPS_PORT ssl;/listen $HTTPS_PORT ssl http2;/" /etc/nginx/sites-available/gsdn-pmis
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
Demo sign-in:    employee ID 1001 (mock data; real M365 sign-in comes with the API in P1)
Database:        sudo -u postgres psql -p $DB_PORT $DB_NAME
App settings:    $CONF_DIR/pmis.env (DATABASE_URL for the future API)
nginx site:      /etc/nginx/sites-available/gsdn-pmis
EOF
if [[ $TLS_MODE == 3 ]]; then
  warn "Self-signed certificate: copy $TLS_DIR/fullchain.pem to each client PC and install it as a"
  warn "trusted root certificate, or the browser will block the app's service worker."
fi
