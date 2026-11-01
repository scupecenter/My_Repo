#!/usr/bin/env bash
# GSDN PMIS: developer / cloud-session setup.
# Starts PostgreSQL 16 with the CI test password, installs npm dependencies,
# and installs the pre-commit security scan tools. Test-only values, same as
# .github/workflows/ci.yml. Idempotent and non-fatal.
# Use: bash pmis/tools/dev-setup.sh   (or paste into the cloud environment's Setup script)
set -uo pipefail
REPO="${REPO:-/home/user/My_Repo}"

# 1) PostgreSQL 16 for the API tests
pg_ctlcluster 16 main start >/dev/null 2>&1 || service postgresql start >/dev/null 2>&1 || true
su postgres -c "psql -q -c \"ALTER USER postgres PASSWORD 'ci-only-postgres-test-value';\"" >/dev/null 2>&1 || true

# 2) npm dependencies (API and web)
for app in api web ; do
  A="$REPO/pmis/apps/$app"
  [ -f "$A/package-lock.json" ] && ( cd "$A" && npm ci --no-audit --no-fund >/dev/null 2>&1 ) || true
done

# 3) Security scan tools (pre-commit gate)
pip3 install -q semgrep checkov >/dev/null 2>&1 || true
curl -sSfL -o /usr/local/bin/hadolint https://github.com/hadolint/hadolint/releases/latest/download/hadolint-Linux-x86_64 && chmod +x /usr/local/bin/hadolint || true
curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks 2>/dev/null || true
curl -sSfL https://github.com/anchore/grype/releases/download/v0.79.0/grype_0.79.0_linux_amd64.tar.gz | tar -xz -C /usr/local/bin grype 2>/dev/null || true

# Test environment for the API suite:
#   export TEST_PG_ADMIN_URL=postgresql://postgres:ci-only-postgres-test-value@127.0.0.1:5432/postgres
#   export TEST_PG_APP_PASSWORD=ci-only-pmis-app-test-value
echo "[pmis dev-setup] done"
