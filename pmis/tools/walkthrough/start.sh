#!/bin/bash
# One call: scratch DB + seed + API (built, detached) + web (Vite proxy to the API, mocks off). Safe to re-run. Stop with stop.sh. About 90 s the first time.
set -e
PMIS=${PMIS:-$(cd "$(dirname "$0")/../.." && pwd)}; W=${WALK_DIR:-$HOME/walk}; mkdir -p "$W" /tmp/walk-files
# Test-only keys are generated per machine (nothing secret-looking is committed).
if [ ! -f "$W/api.env" ]; then
  k() { openssl rand -hex 32; }
  cat > "$W/api.env" <<ENV
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
COOKIE_SECURE=false
DATABASE_URL=postgresql://pmis_app:walk-pass@127.0.0.1:5433/pmis_walk?connection_limit=10
LOG_HMAC_KEY=$(k)
TOTP_ENC_KEY=$(k)
PMIS_CONTEXT_KEY=$(k)
JOBS_ENABLED=false
STORAGE_DIR=/tmp/walk-files
FILE_ENC_KEY=$(k)
FILE_ENC_KEY_ID=k1
MALWARE_SCAN=off
ENV
fi
"$PMIS/tools/walkthrough/builddb.sh" pmis_walk
WALK_ENV="$W/api.env" node "$PMIS/tools/walkthrough/seed.cjs"
cd "$PMIS/apps/api"; [ -d node_modules ] || npm ci --no-audit --no-fund
npm run build >"$W/build.log" 2>&1
pkill -f "node --env-file=$W/api.env dist/main.js" 2>/dev/null || true
setsid nohup node --env-file="$W/api.env" dist/main.js >"$W/api.log" 2>&1 </dev/null &
cd "$PMIS/apps/web"; [ -d node_modules ] || npm ci --no-audit --no-fund
pkill -f "vite --port 5174" 2>/dev/null || true
VITE_USE_MOCKS=false VITE_PROXY_TARGET=http://127.0.0.1:3000 setsid nohup npx vite --port 5174 --strictPort >"$W/web.log" 2>&1 </dev/null &
for i in $(seq 1 30); do curl -sf localhost:3000/api/v1/health >/dev/null && curl -sf -o /dev/null localhost:5174/login && { echo "READY api:3000 web:5174"; exit 0; }; sleep 2; done
echo "NOT READY, see $W/api.log and $W/web.log"; exit 1
