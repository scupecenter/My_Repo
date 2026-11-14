#!/usr/bin/env bash
# Usage: scan.sh <worktree-path>. Runs the Opsera pre-commit scan set; reports go to /tmp/opsera/<name>/
P="$1"; N=$(basename "$P"); O=/tmp/opsera/$N; mkdir -p "$O"; cd "$O"
EX="--exclude node_modules --exclude dist --exclude .git"
gitleaks detect --source "$P" --no-git --report-format json -r gitleaks-report.json 2>gitleaks-stderr.txt; echo "GITLEAKS_EXIT:$?"
GRYPE_DB_VALIDATE_AGE=false grype "dir:$P" --exclude './**/node_modules/**' -o json > grype-report.json 2>grype-stderr.txt; echo "GRYPE_EXIT:$?"
CH=$(cd "$P" && { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | grep -E '\.(ts|tsx|js|sql|yaml|yml)$' | sed "s|^|$P/|")
semgrep scan --config p/default --disable-version-check --json --quiet $EX "$P/pmis/apps" > semgrep-report.json 2>semgrep-stderr.txt; echo "SEMGREP_EXIT:$?"
checkov -d "$P" --skip-path node_modules --output json --quiet > checkov-report.json 2>checkov-stderr.txt; echo "CHECKOV_EXIT:$?"
find "$P" -name "Dockerfile*" -not -path '*/node_modules/*' -exec hadolint --format json {} \; > hadolint-report.json 2>hadolint-stderr.txt; echo "HADOLINT_EXIT:$?"
python3 - "$P" "$CH" <<'PY'
import json,sys,os
P=sys.argv[1]; changed=set(x for x in sys.argv[2].split() if x)
def sev(s): s=(s or '').lower(); return {'error':'high','warning':'medium','info':'low'}.get(s,s)
c={'critical':0,'high':0,'medium':0,'low':0}; new=0; ex=0; hi=[]
def add(s,f,t):
    global new,ex
    s=sev(s); s=s if s in c else 'low'; c[s]+=1
    isnew=any(f and f.endswith(x.replace(P+'/','')) for x in changed)
    new+=isnew; ex+= not isnew
    if s in('critical','high'): hi.append((s,'NEW' if isnew else 'existing',f,t))
try:
  for g in json.load(open('gitleaks-report.json')): add('high',g.get('File'),'secret:'+g.get('RuleID',''))
except Exception as e: print('gitleaks parse',e)
try:
  for r in json.load(open('semgrep-report.json')).get('results',[]): add(r['extra'].get('severity'),r.get('path'),r.get('check_id'))
except Exception as e: print('semgrep parse',e)
try:
  for m in json.load(open('grype-report.json')).get('matches',[]):
    add(m['vulnerability'].get('severity'),(m['artifact'].get('locations') or [{}])[0].get('path'),m['vulnerability']['id']+' '+m['artifact']['name'])
except Exception as e: print('grype parse',e)
try:
  d=json.load(open('checkov-report.json')); d=d if isinstance(d,list) else [d]
  for b in d:
    for f in b.get('results',{}).get('failed_checks',[]): add(f.get('severity') or 'medium',f.get('file_path'),f.get('check_id'))
except Exception as e: print('checkov parse',e)
print(json.dumps({**c,'total':sum(c.values()),'new_findings':new,'existing_findings':ex}))
for h in hi[:40]: print(*h)
PY
