#!/usr/bin/env bash
# GSDN Workspace: the quarantine move of reset-project-data.sh, in its own file so the test can run it without root. Sourced, never run on its own.
#
#   quarantine_files STORE QUARANTINE KEYS_FILE MANIFEST
#
# Moves each storage key listed in KEYS_FILE (one per line) from STORE to the same relative path under QUARANTINE. Nothing is ever deleted: a key
# that is refused or missing is left where it is and written to MANIFEST as REFUSED or MISSING with the reason; a moved key as MOVED.
# A key is refused when it is empty, absolute, has an empty, "." or ".." component or does not match the API's key format; when any path
# component under STORE is a symbolic link; when the target is not a regular file; or when its resolved path is not inside the resolved STORE.
# mkdir and mv run as the user QUAR_AS (the owner of STORE, set by the caller) through runuser, never as root, so even a race on the checks
# gains no more than that user already has. With QUAR_AS empty (the test) they run as the current user.
# Prints one line: "<moved> <missing> <refused>".

QUAR_KEY_RE='^[a-z0-9]+(/[a-z0-9-]+)+$'   # the storage key format of the API (apps/api/src/documents/storage.service.ts)

quar_as() {
  if [[ -n ${QUAR_AS-} ]]; then runuser -u "$QUAR_AS" -- "$@"; else "$@"; fi
}

# quar_check STORE_REAL STORE KEY: prints the reason a key is refused (empty output = acceptable); exit 3 = missing.
quar_check() {
  local store_real=$1 store=$2 key=$3 p c real
  local -a parts
  [[ -n $key ]] || { echo 'empty key'; return 0; }
  [[ $key != /* ]] || { echo 'absolute path'; return 0; }
  [[ $key != *//* && $key != */ ]] || { echo 'empty path component'; return 0; }
  IFS='/' read -r -a parts <<<"$key"
  for c in "${parts[@]}"; do
    [[ -n $c && $c != . && $c != .. ]] || { echo 'empty, . or .. path component'; return 0; }
  done
  [[ $key =~ $QUAR_KEY_RE ]] || { echo 'not a storage key'; return 0; }
  p=$store
  for c in "${parts[@]}"; do
    p=$p/$c
    if [[ -L $p ]]; then echo "symbolic link at ${p#"$store"/}"; return 0; fi
    [[ -e $p ]] || return 3
  done
  [[ -f $p && ! -L $p ]] || { echo 'not a regular file'; return 0; }
  real=$(realpath -e -- "$p") || { echo 'cannot resolve'; return 0; }
  [[ $real == "$store_real"/* ]] || { echo 'resolves outside the store'; return 0; }
  return 0
}

quarantine_files() {
  local store=$1 qdir=$2 list=$3 manifest=$4 store_real key why rc moved=0 missing=0 refused=0
  store_real=$(realpath -e -- "$store") || { echo "quarantine: cannot resolve $store" >&2; return 1; }
  while IFS= read -r key || [[ -n $key ]]; do
    rc=0; why=$(quar_check "$store_real" "$store" "$key") || rc=$?
    if [[ $rc == 3 ]]; then missing=$((missing + 1)); printf 'MISSING %s\n' "$key" >> "$manifest"; continue; fi
    if [[ -n $why ]]; then refused=$((refused + 1)); printf 'REFUSED %s (%s): left in place\n' "$key" "$why" >> "$manifest"; continue; fi
    if quar_as mkdir -p -- "$qdir/$(dirname -- "$key")" && quar_as mv -n -T -- "$store/$key" "$qdir/$key" \
       && [[ -f $qdir/$key && ! -e $store/$key ]]; then
      moved=$((moved + 1)); printf 'MOVED %s\n' "$key" >> "$manifest"
    else
      refused=$((refused + 1)); printf 'REFUSED %s (the move failed): left in place\n' "$key" >> "$manifest"
    fi
  done < "$list"
  echo "$moved $missing $refused"
}
