#!/usr/bin/env bash
# shellcheck disable=SC2034  # the variables set below are read by the installer helpers sourced from install-ubuntu.sh
# Tests for TLS option 4 (an existing Let's Encrypt certificate used in place) in install-ubuntu.sh.
# It takes the helper functions between the "BEGIN le-existing" and "END le-existing" markers and runs them
# against a fake /etc/letsencrypt tree made in a temporary directory. Needs only openssl. Nothing is installed,
# no nginx is touched and the script does not need root.
#   bash pmis/tools/install/test-le-existing.sh
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# The installer's own helpers, extracted (not copied) so the tests run the code that ships.
sed -n '/^# BEGIN le-existing/,/^# END le-existing/p' "$HERE/install-ubuntu.sh" > lib.sh
sed -n -e '/^say()/p' -e '/^warn()/p' -e '/^die()/p' -e '/^ask() {/,/^}/p' "$HERE/install-ubuntu.sh" > helpers.sh
# shellcheck disable=SC1091
. ./helpers.sh
# shellcheck disable=SC1091
. ./lib.sh

FAILS=0
pass() { echo "ok    $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

# expect_ok DESC CMD...: the command must succeed
expect_ok() { local d=$1; shift; if ( "$@" ) >out.txt 2>&1; then pass "$d"; else fail "$d"; sed 's/^/      /' out.txt; fi; }
# expect_fail DESC PATTERN CMD...: the command must exit non-zero and print PATTERN
expect_fail() {
  local d=$1 pat=$2; shift 2
  if ( "$@" ) >out.txt 2>&1; then fail "$d (it succeeded)"; sed 's/^/      /' out.txt
  elif grep -q -- "$pat" out.txt; then pass "$d"
  else fail "$d (message does not contain: $pat)"; sed 's/^/      /' out.txt; fi
}

# A self-signed certificate: mkcert DIR CN SAN_LIST(e.g. DNS:a,IP:1.2.3.4) [KEYFILE]
mkcert() {
  local dir=$1 cn=$2 san=$3
  mkdir -p "$dir"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/privkey.pem" -out "$dir/fullchain.pem" \
    -days 30 -subj "/CN=$cn" -addext "subjectAltName=$san" 2>/dev/null
}

# An expired certificate: signed by openssl ca with a validity in 2000-2001 (OpenSSL 3.0 has no -not_after).
mkexpired() {
  local dir=$1 cn=$2 db=$WORK/ca
  mkdir -p "$dir" "$db"; : > "$db/index.txt"; echo 1000 > "$db/serial"
  cat > "$db/ca.cnf" <<EOF
[ca]
default_ca = CA
[CA]
dir = $db
database = \$dir/index.txt
new_certs_dir = \$dir
serial = \$dir/serial
default_md = sha256
policy = pol
unique_subject = no
copy_extensions = none
[pol]
commonName = supplied
[ext]
subjectAltName = DNS:$cn
EOF
  openssl req -new -newkey rsa:2048 -nodes -keyout "$dir/privkey.pem" -out "$db/req.csr" -subj "/CN=$cn" 2>/dev/null
  openssl ca -batch -selfsign -config "$db/ca.cnf" -keyfile "$dir/privkey.pem" -in "$db/req.csr" -out "$dir/fullchain.pem" \
    -startdate 20000101000000Z -enddate 20010101000000Z -extensions ext -notext >/dev/null 2>&1
}

# The fake tree: a valid certificate, an expired one, a key that does not match, a directory with no files,
# an IP certificate, and the README that certbot leaves in live/.
LE_DIR=$WORK/letsencrypt
mkcert "$LE_DIR/live/pmis.example.ly" pmis.example.ly "DNS:pmis.example.ly,DNS:www.pmis.example.ly"
mkexpired "$LE_DIR/live/old.example" old.example
mkcert "$LE_DIR/live/mismatch.example" mismatch.example "DNS:mismatch.example"
mkcert "$WORK/other" other.example "DNS:other.example"
cp "$WORK/other/privkey.pem" "$LE_DIR/live/mismatch.example/privkey.pem"
mkdir -p "$LE_DIR/live/broken.example"
mkcert "$LE_DIR/live/ip.example" ip.example "DNS:ip.example,IP:192.0.2.10"
echo "certbot readme" > "$LE_DIR/live/README"
AUTO=0; NONINT_TLS=1

echo "== names"
got=$(le_names | sort | tr '\n' ' ')
want="broken.example ip.example mismatch.example old.example pmis.example.ly "
if [[ $got == "$want" ]]; then pass "le_names lists the directories and skips README"; else fail "le_names: got '$got'"; fi

echo "== checks"
expect_ok   "valid certificate, server name on its SAN" le_check pmis.example.ly pmis.example.ly
expect_ok   "valid certificate, second SAN name" le_check pmis.example.ly www.pmis.example.ly
expect_ok   "valid certificate, IP on its SAN" le_check ip.example 192.0.2.10
expect_fail "name the certificate does not cover" "does not cover" le_check pmis.example.ly other.example
expect_fail "expired certificate" "has expired" le_check old.example old.example
expect_fail "key that does not match" "does not belong" le_check mismatch.example mismatch.example
expect_fail "directory without files" "No fullchain.pem" le_check broken.example broken.example
expect_fail "missing certificate" "No fullchain.pem" le_check nope.example nope.example
expect_fail "path traversal in the name" "Not a certificate name" le_check ../etc ../etc
expect_fail "dot name" "Not a certificate name" le_check .. pmis.example.ly

echo "== choice"
NONINT_TLS=1; TLS_LE_NAME=pmis.example.ly
expect_ok "unattended: TLS_LE_NAME is used" le_choose
expect_fail "unattended without TLS_LE_NAME" "Set TLS_LE_NAME" bash -c 'NONINT_TLS=1; unset TLS_LE_NAME; . ./helpers.sh; . ./lib.sh; le_choose'
NONINT_TLS=0; AUTO=1; PREV_LE_NAME=pmis.example.ly; TLS_LE_NAME=''
if le_choose && [[ $TLS_LE_NAME == pmis.example.ly ]]; then pass "update run: the saved name is used without a question"; else fail "update run: saved name"; fi
AUTO=0; PREV_LE_NAME=''
# interactive: a number from the list picks that entry; a name is taken as typed
if [[ $(printf '2\n' | (le_choose >/dev/null; echo "$TLS_LE_NAME")) == "$(le_names | sed -n 2p)" ]]; then pass "interactive: number 2 picks the second certificate in the list"; else fail "interactive number"; fi
if [[ $(printf 'pmis.example.ly\n' | (le_choose >/dev/null; echo "$TLS_LE_NAME")) == pmis.example.ly ]]; then pass "interactive: a typed name is taken"; else fail "interactive name"; fi

echo "== renewal hook"
hook_body=$'#!/bin/sh\nsystemctl reload nginx'
LE_DIR=$WORK/hook1; mkdir -p "$LE_DIR"
le_renewal_hook >/dev/null 2>&1
if [[ $(cat "$LE_DIR/renewal-hooks/deploy/reload-nginx") == "$hook_body" && -x $LE_DIR/renewal-hooks/deploy/reload-nginx ]]; then
  pass "hook created, executable, reloads nginx"
else fail "hook content or mode"; fi
before=$(cat "$LE_DIR/renewal-hooks/deploy/reload-nginx" | md5sum)
le_renewal_hook >out.txt 2>&1
if [[ $(md5sum < "$LE_DIR/renewal-hooks/deploy/reload-nginx") == "$before" ]] && grep -q "already in place" out.txt; then
  pass "hook run again: unchanged (idempotent)"
else fail "hook is not idempotent"; fi

LE_DIR=$WORK/hook2; mkdir -p "$LE_DIR/renewal-hooks/deploy"
printf '#!/bin/sh\necho mine\n' > "$LE_DIR/renewal-hooks/deploy/reload-nginx"
le_renewal_hook >/dev/null 2>&1
if grep -q 'echo mine' "$LE_DIR/renewal-hooks/deploy/reload-nginx" \
   && [[ $(cat "$LE_DIR/renewal-hooks/deploy/reload-nginx-gsdn-pmis") == "$hook_body" ]]; then
  pass "other hook kept untouched; ours written beside it"
else fail "other hook was clobbered or ours missing"; fi

LE_DIR=$WORK/hook3; mkdir -p "$LE_DIR/renewal-hooks/deploy"
printf 'one\n' > "$LE_DIR/renewal-hooks/deploy/reload-nginx"
printf 'two\n' > "$LE_DIR/renewal-hooks/deploy/reload-nginx-gsdn-pmis"
expect_fail "both names taken by other content" "other content" le_renewal_hook
if [[ $(cat "$LE_DIR/renewal-hooks/deploy/reload-nginx") == one && $(cat "$LE_DIR/renewal-hooks/deploy/reload-nginx-gsdn-pmis") == two ]]; then
  pass "both foreign hooks left as they were"
else fail "foreign hooks changed"; fi

echo
if (( FAILS == 0 )); then echo "All le-existing tests passed."; else echo "$FAILS test(s) failed."; exit 1; fi
