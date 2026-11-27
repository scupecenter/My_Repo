#!/usr/bin/env bash
# SEC-5 check: in the nginx site the installer writes, the HTTPS server and every location that sets its own add_header carry the four security
# headers (nginx drops server-level add_header in a location that has its own). Run: tools/install/test-nginx-headers.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
python3 - "$here/install-ubuntu.sh" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
ms = [x for x in re.finditer(r'cat > "\$SITE" <<EOF\n(.*?)\nEOF\n', s, re.S) if 'listen $HTTPS_PORT ssl;' in x.group(1)]
assert ms, 'site heredoc not found'
site = ms[-1].group(1)
need = ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Strict-Transport-Security']
https = site.split('listen $HTTPS_PORT ssl;')[1]
bad = []
# server level: text before the first location
head = https.split('location', 1)[0]
for h in need:
    if 'add_header ' + h not in head:
        bad.append(f'server: {h}')
for loc in re.finditer(r'location ([^{]+)\{(.*?)\n  \}|location ([^{]+)\{([^}]*)\}', https, re.S):
    name = (loc.group(1) or loc.group(3)).strip()
    body = loc.group(2) or loc.group(4) or ''
    if 'add_header' in body:
        for h in need:
            if 'add_header ' + h not in body:
                bad.append(f'location {name}: {h}')
if bad:
    print('missing security headers:', *bad, sep='\n  ')
    sys.exit(1)
print('ok: security headers present on the HTTPS server and on every location with its own add_header')
PY
