#!/usr/bin/env bash
# Quick pre-commit check (owner decision 2026-11-13): secrets in the STAGED changes only.
# The full scan (secrets, SAST, dependencies, IaC) runs on GitHub in .github/workflows/security.yml.
# Usage: quick.sh <repo-or-worktree-path>. Prints PASS or FAIL; exit code 1 on findings.
set -u
P="${1:-.}"
CFG="$P/.gitleaks.toml"
[ -f "$CFG" ] || CFG="$(dirname "$0")/../../../.gitleaks.toml"
cd "$P" || exit 2
if gitleaks protect --staged --config "$CFG" --redact --exit-code 1 >/tmp/quick-scan.log 2>&1; then
  echo "PASS: no secrets in staged changes"
else
  echo "FAIL: possible secret in staged changes"; grep -E "Finding|File|Line|RuleID" /tmp/quick-scan.log | head -20
  exit 1
fi
