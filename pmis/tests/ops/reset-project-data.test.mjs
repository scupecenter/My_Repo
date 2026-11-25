#!/usr/bin/env node
// GSDN Workspace: test of the project data reset (infra/scripts/reset-project-data.sql and .sh, contract docs/ops/data-reset.md).
//
// Builds a scratch database from every migration and the grants (as apps/api/test/global-setup.ts does), bootstraps the first System Admin,
// loads synthetic users, configuration, sites, tasks, registers, documents, import batches, notifications and log rows (reset-seed.sql),
// then checks:
//   1. the shell script's dry run (default mode) prints the plan and changes nothing; --execute without a terminal and without
//      --yes-i-have-a-backup is refused;
//   2. a reset that meets a kept row pointing at project data rolls back completely (nothing changed);
//   3. a chosen scope (migration 0152), each on a copy of the database: a part alone deletes exactly its rows and leaves every other table as it was;
//      a part others depend on takes them along (the database computes the closure); the identity parts deactivate every account but the System
//      Admins, remove assignments, delegations and groups (a group the matrix names is emptied, the System Admins group keeps its members), empty the
//      staff registry and the absences, and a second run finds nothing left; an unknown part is refused;
//   4. the reset: every DELETE table is empty, every KEEP table is unchanged row for row (users, passwords, two-factor, configuration),
//      the MIXED tables keep exactly their kept rows, the Audit Log and the security log keep every old row unchanged and gain only the reset
//      row and the session-end rows, both hash chains verify with log_verify_chain, users still resolve for sign-in, all sessions are ended,
//      and the quarantine list names exactly the stored objects of the deleted rows.
// Zero dependencies: it drives the psql client.
//
// Usage:  node tests/ops/reset-project-data.test.mjs [--keep-db]
// Env:    TEST_PG_ADMIN_URL     superuser URL (default postgresql://postgres:ci-test-pw@127.0.0.1:5432/postgres; container-only credentials)
//         TEST_PG_APP_PASSWORD  password of the role pmis_app (created with it when missing; default ci-app-pw)
//         TEST_DB_NAME          scratch database (default pmis_api_rst; dropped at the end unless --keep-db)
// Exit:   0 = every check passed, 1 = a check failed, 2 = setup failed.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pmis = resolve(here, '..', '..');
const migrationsDir = join(pmis, 'apps', 'api', 'prisma', 'migrations');
const sqlFile = join(pmis, 'infra', 'scripts', 'reset-project-data.sql');
const shFile = join(pmis, 'infra', 'scripts', 'reset-project-data.sh');
const quarFile = join(pmis, 'infra', 'scripts', 'reset-project-data-quarantine.sh');
const signScript = join(pmis, 'tests', 'db-security', 'sign-context.mjs');

const adminUrl = process.env.TEST_PG_ADMIN_URL ?? 'postgresql://postgres:ci-test-pw@127.0.0.1:5432/postgres';
const appPassword = process.env.TEST_PG_APP_PASSWORD ?? 'ci-app-pw';
const dbName = process.env.TEST_DB_NAME ?? 'pmis_api_rst';
const keepDb = process.argv.includes('--keep-db');
const CONTEXT_KEY = '7e5e7da7a0c0ffee'.repeat(4); // test-only session-context key
if (!/^[a-z][a-z0-9_]{2,40}$/.test(dbName)) { console.error('TEST_DB_NAME must be a simple lower-case identifier'); process.exit(2); }

const urlFor = (db, user, password) => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = password; }
  return u.toString();
};
const superUrl = urlFor(dbName);
const appUrl = urlFor(dbName, 'pmis_app', appPassword);

function psql(url, { input, file, vars = {}, check = true } = {}) {
  const a = ['-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-d', url];
  for (const [k, v] of Object.entries(vars)) a.push('-v', `${k}=${v}`);
  if (file) a.push('-f', file);
  const r = spawnSync('psql', a, { input: file ? undefined : input ?? '', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 600_000,
    env: { ...process.env, PMIS_SECSUITE_CONTEXT_KEY: CONTEXT_KEY, PGOPTIONS: '-c client_min_messages=warning' } });
  if (r.error) throw new Error(`cannot run psql: ${r.error.message}`);
  if (check && r.status !== 0) throw new Error(`psql failed (${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(0, 5).join(' / ')}`);
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const q = (sql, url = superUrl) => psql(url, { input: sql }).out.trim();

let failures = 0, passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`PASS  ${name}`); } else { failures++; console.log(`FAIL  ${name}${detail ? `: ${detail}` : ''}`); }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
function build() {
  const admin = urlFor('postgres');
  q(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`, admin);
  q(`CREATE DATABASE ${dbName};`, admin);
  if (q(`SELECT count(*) FROM pg_roles WHERE rolname = 'pmis_app';`, admin) === '0') {
    q(`CREATE ROLE pmis_app LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}';`, admin);
  }
  const dirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^0/.test(d.name)).map((d) => d.name).sort();
  for (const d of dirs) {
    const r = psql(superUrl, { file: join(migrationsDir, d, 'migration.sql'), check: false });
    if (r.status !== 0) throw new Error(`migration ${d} failed: ${r.err.trim().split('\n')[0]}`);
  }
  psql(superUrl, { file: join(pmis, 'db', 'sql', 'app_grants.sql') });
  q(`INSERT INTO regions (id, code, name_en) VALUES (1,'TRIPOLI','Tripoli'),(2,'MIDDLE','Middle'),(3,'WM','WM'),(4,'ZAWIA','Zawia'),
     (5,'BENGHAZI','Benghazi'),(6,'GM','GM'),(7,'SEBHA','Sebha') ON CONFLICT (id) DO NOTHING;
     SELECT app_ctx_key_install('${CONTEXT_KEY}');
     SELECT idm_bootstrap_admin('reset.admin@example.test', 'Reset Admin (synthetic)', '9101', '+218910000101',
       '$argon2id$v=19$m=4096,t=2,p=1$c3ludGhldGlj$YWRtaW5oYXNoc3ludGhldGljYWRtaW4');`);
  psql(superUrl, { file: join(here, 'reset-seed.sql') });
}

// One line per base table of the public schema: name|rows|md5 of every row (sorted), plus row digests for the append-only logs.
const SNAPSHOT_SQL = `
CREATE FUNCTION pg_temp.snap() RETURNS TABLE(t text, n bigint, h text) LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1 LOOP
    t := r.relname;
    EXECUTE format('SELECT count(*), md5(coalesce(string_agg(x::text, E''\\n'' ORDER BY x::text), '''')) FROM public.%I x', r.relname) INTO n, h;
    RETURN NEXT;
  END LOOP;
END $f$;
SELECT t, n, h FROM pg_temp.snap();`;
function snapshot(url = superUrl) {
  const m = new Map();
  for (const line of q(SNAPSHOT_SQL, url).split('\n').filter(Boolean)) {
    const [t, n, h] = line.split('|');
    m.set(t, { n: Number(n), h });
  }
  return m;
}
const digest = (sql) => q(`SELECT md5(coalesce(string_agg(x, E'\\n' ORDER BY x), '')) FROM (${sql}) s(x);`);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------------
// The quarantine move (no database): a good key moves; a symlinked file, a symlinked directory on the path, "..", an absolute key, an empty
// component and a directory are refused and left in place; nothing outside the store moves.
function quarantineChecks() {
  const root = mkdtempSync(join(tmpdir(), 'pmis-reset-quar-'));
  try {
    const store = join(root, 'files'), outside = join(root, 'outside'), qdir = join(root, 'files-pre-reset-test');
    for (const d of [join(store, 'docs', '2026', '11'), join(store, 'docs', 'dir-key'), outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(store, 'docs', '2026', '11', 'good-file'), 'good');
    writeFileSync(join(outside, 'secret'), 'secret');
    writeFileSync(join(outside, 'victim'), 'victim');
    symlinkSync(join(outside, 'secret'), join(store, 'docs', '2026', '11', 'link-file'));   // a symlinked file
    symlinkSync(outside, join(store, 'docs', 'evil'));                                     // a symlinked directory on the path
    mkdirSync(qdir);
    const keys = ['docs/2026/11/good-file', 'docs/2026/11/link-file', 'docs/evil/victim', 'docs/../outside/victim', '/etc/hostname',
      'docs//2026/11/good-file', 'docs/dir-key', 'docs/2026/11/not-there', ''];
    writeFileSync(join(root, 'keys.txt'), keys.join('\n') + '\n');
    const manifest = join(root, 'manifest');
    writeFileSync(manifest, '');
    const r = spawnSync('bash', ['-c', `set -euo pipefail; . "$1"; QUAR_AS= quarantine_files "$2" "$3" "$4" "$5"`, '_', quarFile, store, qdir, join(root, 'keys.txt'), manifest],
      { encoding: 'utf8' });
    check('quarantine: the move runs', r.status === 0, r.stderr.trim());
    check('quarantine: counts are 1 moved, 1 missing, 7 refused', r.stdout.trim() === '1 1 7', r.stdout.trim());
    const m = readFileSync(manifest, 'utf8');
    check('quarantine: the regular file is moved into the quarantine', existsSync(join(qdir, 'docs', '2026', '11', 'good-file')) && !existsSync(join(store, 'docs', '2026', '11', 'good-file')));
    check('quarantine: a symlinked file is refused and left in place', /REFUSED docs\/2026\/11\/link-file \(symbolic link/.test(m) && lstatSync(join(store, 'docs', '2026', '11', 'link-file')).isSymbolicLink());
    check('quarantine: a symlinked directory on the path is refused', /REFUSED docs\/evil\/victim \(symbolic link at docs\/evil\)/.test(m));
    check('quarantine: "..", absolute, empty-component, empty and directory keys are refused',
      ['docs/../outside/victim', '/etc/hostname', 'docs//2026/11/good-file', 'docs/dir-key'].every((k) => m.includes(`REFUSED ${k} (`)) && /^REFUSED  \(empty key\)/m.test(m), m);
    check('quarantine: a missing key is listed as missing', /^MISSING docs\/2026\/11\/not-there$/m.test(m));
    check('quarantine: nothing outside the store moved', readFileSync(join(outside, 'secret'), 'utf8') === 'secret' && readFileSync(join(outside, 'victim'), 'utf8') === 'victim'
      && readdirSync(qdir, { recursive: true }).filter((f) => !lstatSync(join(qdir, String(f))).isDirectory()).join(',') === join('docs', '2026', '11', 'good-file'));
    check('quarantine: the store keeps its directory key', lstatSync(join(store, 'docs', 'dir-key')).isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A chosen scope (migration 0152), run on a copy of the seeded database (CREATE DATABASE ... TEMPLATE): the base stays as seeded for the full reset.
const LOG_MOVES = new Set(['audit_log', 'audit_log_chain', 'audit_field_changes', 'security_log', 'security_log_chain', 'log_chain_heads', 'user_sessions']);
function onCopy(parts, fn) {
  const copy = `${dbName}_c`;
  const admin = urlFor('postgres');
  q(`DROP DATABASE IF EXISTS ${copy} WITH (FORCE);`, admin);
  q(`CREATE DATABASE ${copy} TEMPLATE ${dbName};`, admin);
  const url = urlFor(copy);
  try {
    const before = snapshot(url);
    const run = psql(url, { file: sqlFile, vars: { execute: 'true', reason: `Synthetic scoped reset: ${parts}`, parts }, check: false });
    const lines = run.out.split('\n');
    const scope = (lines.find((l) => l.startsWith('SCOPE|')) ?? '').split('|');
    const after = run.status === 0 ? snapshot(url) : before;
    const changed = [...before.keys()].filter((t) => before.get(t).h !== after.get(t)?.h);
    fn({ url, run, scope: scope[1] ?? '', added: scope[2] ?? '', before, after, changed, qq: (sql) => q(sql, url) });
  } finally {
    q(`DROP DATABASE IF EXISTS ${copy} WITH (FORCE);`, admin);
  }
}
const only = (changed, allowed) => changed.filter((t) => !LOG_MOVES.has(t) && !allowed.includes(t));

function scopedChecks() {
  onCopy('issues', ({ run, scope, added, changed, after, before }) => {
    check('scope: one register alone (issues) commits', run.status === 0, run.err.trim().split('\n')[0]);
    check('scope: issues takes nothing along', scope === 'issues' && added === '', `${scope} / ${added}`);
    check('scope: only the issues table and the logs changed', only(changed, ['issues']).length === 0 && after.get('issues').n === 0, only(changed, ['issues']).join(', '));
    check('scope: the sites, tasks and other registers stay', ['sites', 'task_instances', 'risks', 'register_records', 'document_files'].every((t) => before.get(t).h === after.get(t).h));
  });
  onCopy('procurement', ({ run, scope, added, changed, after, qq }) => {
    check('scope: procurement commits', run.status === 0, run.err.trim().split('\n')[0]);
    check('scope: procurement takes the bookings and the advances along (they depend on it)', scope === 'car_dispatcher,financial_advances,procurement'
      && added === 'car_dispatcher,financial_advances', `${scope} / ${added}`);
    const allowed = ['procurement_records', 'assignment_readiness', 'vehicle_reservations', 'register_records', 'register_steps', 'register_level_actors',
      'register_record_locks', 'hlc_pr_links', 'user_drafts', 'document_record_snapshots'];
    check('scope: only the rows of procurement, bookings and advances went', only(changed, allowed).length === 0, only(changed, allowed).join(', '));
    check('scope: the kept company, the vehicle, the risk and the HLC record stay; the order, the booking and the advance went',
      qq(`SELECT string_agg(register_key || '/' || coalesce(record_type, '-'), ',' ORDER BY register_key, record_type) FROM register_records;`)
        === 'car_dispatcher/vehicle,contractors/company,hlc/-,risks/-');
    check('scope: the HLC link to the deleted order went, the HLC record stays', after.get('hlc_pr_links').n === 0 && after.get('hlc_records').n === 1);
    check('scope: the draft of the order went; the company, form and task drafts stay',
      qq(`SELECT string_agg(split_part(draft_key, '.', 1) || '.' || split_part(draft_key, '.', 2), ',' ORDER BY draft_key) FROM user_drafts WHERE draft_key NOT LIKE 'task.%';`) === 'form.profile,record.contractors'
      && qq(`SELECT count(*) FROM user_drafts WHERE draft_key LIKE 'task.%';`) === '1');
  });
  onCopy('sites', ({ run, added, after, before }) => {
    check('scope: sites commits', run.status === 0, run.err.trim().split('\n')[0]);
    const want = 'acquisition,as_built,car_dispatcher,change_control,daily_plan,deliverables,dismantle,documents,financial_advances,gecol,hlc,imports,issues,kpi,meetings,permits,procurement,quality,readiness,rf_design,risks,warehouse';
    check('scope: sites takes every site-scoped part along (tasks, documents, registers, imports, Daily Plan, KPI)', added === want, added);
    check('scope: sites leaves the inbox (its own part) and every account', after.get('notifications').n === 1 && before.get('users').h === after.get('users').h, String(after.get('notifications').n));
    check('scope: sites empties the project tables (the kept company batch stays)', after.get('sites').n === 0 && after.get('task_instances').n === 0 && after.get('import_batches').n === 1);
  });
  onCopy('change_control,permits', ({ run, changed }) => {
    check('scope: registers that feed the dates of kept tasks commit (the gate states are recalculated)', run.status === 0, run.err.trim().split('\n')[0]);
    const allowed = ['change_requests', 'site_scope_exceptions', 'permit_records', 'site_gate_state', 'task_instances', 'sites'];
    check('scope: only those registers and the recalculated site state changed', only(changed, allowed).length === 0, only(changed, allowed).join(', '));
  });
  onCopy('users,roles,staff', ({ run, scope, changed, before, after, qq, url }) => {
    check('identity: users, roles and staff commit', run.status === 0, run.err.trim().split('\n')[0]);
    check('identity: the scope is the three identity parts only', scope === 'roles,staff,users', scope);
    const allowed = ['users', 'user_role_assignments', 'user_role_assignment_regions', 'delegations', 'delegation_grants', 'groups', 'group_members', 'staff_registry', 'absences'];
    check('identity: no project table and no other table changed', only(changed, allowed).length === 0, only(changed, allowed).join(', '));
    check('identity: every account but the System Admin is deactivated (rows kept)', qq(`SELECT string_agg(employee_id || ':' || status, ',' ORDER BY employee_id) FROM users;`) === '9101:active,9102:disabled,9103:disabled'
      && after.get('users').n === before.get('users').n);
    check('identity: the System Admin keeps admin rights and the System Admins group its member',
      qq(`SELECT app_user_is_system_admin(id)::text || '|' || (SELECT count(*) FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins) FROM users WHERE employee_id = '9101';`) === 'true|1');
    check('identity: assignments, delegations, the staff registry and the absences are empty',
      ['user_role_assignments', 'user_role_assignment_regions', 'delegations', 'delegation_grants', 'staff_registry', 'absences'].every((t) => after.get(t).n === 0));
    check('identity: a group the matrix names is emptied and kept, the other group deleted',
      qq(`SELECT string_agg(name || ':' || (SELECT count(*) FROM group_members m WHERE m.group_id = g.id), ',' ORDER BY name) FROM groups g;`) === 'System Admins:1,TE Approvers Tripoli (synthetic):0');
    check('identity: role definitions, profiles, their grants, the matrix and the visibility settings stay',
      ['roles', 'permission_profiles', 'permission_grants', 'matrix_cell_assignees', 'staff_registry_visibility_entries', 'staff_registry_visibility_fields'].every((t) => before.get(t).h === after.get(t).h));
    check('identity: one audit row lists the accounts deactivated', qq(`SELECT (after -> 'identity' -> 'users' ->> 'deactivated') || '|' || (after -> 'identity' -> 'roles' ->> 'groups_deleted') FROM audit_log WHERE action = 'project_data_reset';`) === '2|1');
    check('identity: a deactivated account no longer resolves for sign-in', qq(`SELECT count(*) FROM auth_local_lookup('reset.engineer@example.test');`) === '0');
    const again = psql(url, { file: sqlFile, vars: { execute: 'true', reason: 'Synthetic scoped reset again', parts: 'users,roles,staff' }, check: false });
    const left = again.out.split('\n').filter((l) => l.startsWith('PLAN|') && ['users', 'user_role_assignments', 'groups', 'group_members', 'staff_registry', 'absences', 'delegations'].includes(l.split('|')[1]) && l.split('|')[4] !== '0');
    check('identity: idempotent, a second run commits with nothing left to deactivate or delete', again.status === 0 && left.length === 0, (again.err.trim().split('\n')[0] || left.join(' ')));
  });
  const bad = psql(superUrl, { file: sqlFile, vars: { execute: 'false', parts: 'sites,nonsense' }, check: false });
  check('scope: an unknown part is refused', bad.status !== 0 && /unknown part: nonsense/.test(bad.err), bad.err.trim().split('\n')[0]);
}

function main() {
  quarantineChecks();
  try {
    build();
  } catch (e) {
    console.error(`SETUP FAILED: ${e.message}`);
    return 2;
  }
  console.log(`database ${dbName} built and seeded`);

  // ---- 0. the System Log source backup (0146, 0153): the server's backup scripts run as the postgres superuser and must write it; the API
  // (pmis_app) never may. pg_has_role answers true for a superuser on every role, which made 0146 refuse the scripts too (owner report
  // 2026-11-25: "db-backup: could not write the System Log row"). The probe row uses event backup_probe, so it never counts as a backup.
  const probe = `SELECT log_system_write('info', 'backup', 'probe', '{"script":"db-backup","event":"backup_probe"}'::jsonb, NULL, NULL);`;
  const su = psql(superUrl, { input: probe, check: false });
  check('backup log: the postgres superuser (the backup scripts) writes a System Log row of source backup', su.status === 0, (su.err || '').trim());
  const app = psql(appUrl, { input: probe, check: false });
  check('backup log: pmis_app (the API) is still refused the source backup', app.status !== 0 && /backup scripts only/.test(app.err), (app.err || app.out).trim());

  // ---- 1. dry run through the shell script: plan printed, nothing changed --------------------------------------------------------------
  const conf = mkdtempSync(join(tmpdir(), 'pmis-reset-conf-'));
  try {
    writeFileSync(join(conf, 'pmis.env'), `DATABASE_URL=${appUrl}\nSTORAGE_DIR=${join(conf, 'files')}\n`);
    const env = { ...process.env, CONF_DIR: conf, PSQL_CMD: `psql -d ${superUrl}`, PGOPTIONS: '-c client_min_messages=warning' };
    const s0 = snapshot();
    const dry = spawnSync('bash', [shFile], { encoding: 'utf8', env, input: '' });
    check('script: the default mode is the dry run and succeeds', dry.status === 0, (dry.stderr || dry.stdout).trim().split('\n').slice(-3).join(' / '));
    check('script: the dry run prints the DELETE and KEEP counts', /DELETE\s+sites\s+2\b/.test(dry.stdout) && /KEEP\s+users\s+3\b/.test(dry.stdout), dry.stdout.slice(0, 400));
    const s1 = snapshot();
    const changed = [...s0.keys()].filter((t) => s0.get(t).h !== s1.get(t)?.h);
    check('script: the dry run changes nothing', changed.length === 0, changed.join(', '));
    const dp = spawnSync('bash', [shFile, '--parts', 'procurement'], { encoding: 'utf8', env, input: '' });
    check('script: --parts prints the scope with the parts its dependencies add', dp.status === 0 && /Scope: car_dispatcher,financial_advances,procurement/.test(dp.stdout)
      && /Added by the dependencies: car_dispatcher,financial_advances/.test(dp.stdout), (dp.stderr || dp.stdout).trim().split('\n').slice(0, 3).join(' / '));
    check('script: --parts refuses anything but part codes', spawnSync('bash', [shFile, '--parts', 'sites;drop'], { encoding: 'utf8', env, input: '' }).status !== 0);
    const ex = spawnSync('bash', [shFile, '--execute', '--reason', 'synthetic test reason'], { encoding: 'utf8', env, input: 'RESET pmis\n' });
    check('script: --execute without a terminal and without --yes-i-have-a-backup is refused', ex.status !== 0 && /non-interactive|terminal/i.test(ex.stderr), ex.stderr.trim());
    const s2 = snapshot();
    check('script: the refused --execute changes nothing', [...s0.keys()].every((t) => s0.get(t).h === s2.get(t)?.h));
  } finally {
    rmSync(conf, { recursive: true, force: true });
  }

  scopedChecks();

  // ---- 2. a kept row that points at project data: the whole reset rolls back --------------------------------------------------------------
  q(`SET session_replication_role = replica;
     INSERT INTO register_records (id, entity_id, register_key, record_type, site_id, region_id, state, is_current)
     VALUES ('a0000000-0000-4000-8000-0000000000ff', gen_random_uuid(), 'contractors', 'team', 'a0000000-0000-4000-8000-000000000031', 1, 'entry', true);`);
  const r0 = snapshot();
  const bad = psql(superUrl, { file: sqlFile, vars: { execute: 'true', reason: 'synthetic rollback test' }, check: false });
  const r1 = snapshot();
  check('rollback: a reset that would orphan a kept row fails on the foreign key of the kept row', bad.status !== 0 && /register_records/.test(bad.err) && /foreign key/.test(bad.err),
    bad.err.trim().split('\n')[0]);
  const moved = [...r0.keys()].filter((t) => r0.get(t).h !== r1.get(t)?.h);
  check('rollback: after the failure nothing changed (no table, no log, no session)', moved.length === 0, moved.join(', '));
  q(`SET session_replication_role = replica; DELETE FROM register_records WHERE id = 'a0000000-0000-4000-8000-0000000000ff';`);

  // ---- 3. the reset ------------------------------------------------------------------------------------------------------------------------
  const before = snapshot();
  const planOut = psql(superUrl, { file: sqlFile, vars: { execute: 'false' } }).out;
  const plan = new Map(planOut.split('\n').filter((l) => l.startsWith('PLAN|')).map((l) => { const p = l.split('|'); return [p[1], { action: p[2], rows: +p[3], del: +p[4], kept: +p[5] }]; }));
  check('plan: every table has a decision', [...before.keys()].every((t) => plan.has(t)), [...before.keys()].filter((t) => !plan.has(t)).join(', '));
  // The contract page names the same decision for every table (migration 0146: the plan is data_reset_plan(), shared with Settings > Data reset).
  const docPlan = new Map();
  let sec = null;
  for (const line of readFileSync(join(pmis, 'docs', 'ops', 'data-reset.md'), 'utf8').split('\n')) {
    const h = /^###\s+(.*)$/.exec(line);
    if (h) { sec = /\(DELETE\)/.test(h[1]) ? 'delete' : /^MIXED/.test(h[1]) ? 'mixed' : /^Logs/.test(h[1]) ? 'log' : /^Optional/.test(h[1]) ? 'optional' : /\(KEEP/.test(h[1]) ? 'keep' : null; continue; }
    if (/^##\s/.test(line)) { sec = null; continue; }
    const m = /^\| ([a-z_][a-z0-9_]*) \|/.exec(line);
    if (sec && m) docPlan.set(m[1], sec);
  }
  const docDiff = [...plan].filter(([t, p]) => docPlan.get(t) !== p.action).map(([t, p]) => `${t}: plan ${p.action}, page ${docPlan.get(t) ?? 'missing'}`)
    .concat([...docPlan.keys()].filter((t) => !plan.has(t)).map((t) => `${t}: on the page, not in the plan`));
  check('contract: docs/ops/data-reset.md lists every table of the plan with the same decision', docDiff.length === 0, docDiff.join('; '));
  const auditMax = q('SELECT max(id) FROM audit_log;');
  const secMax = q('SELECT max(id) FROM security_log;');
  const oldAudit = digest(`SELECT a::text FROM audit_log a WHERE id <= ${auditMax}`);
  const oldAuditChain = digest(`SELECT c::text FROM audit_log_chain c WHERE audit_id <= ${auditMax}`);
  const oldFieldChanges = digest(`SELECT f::text FROM audit_field_changes f WHERE audit_id <= ${auditMax}`);
  const oldSec = digest(`SELECT s::text FROM security_log s WHERE id <= ${secMax}`);
  const oldSecChain = digest(`SELECT c::text FROM security_log_chain c WHERE security_id <= ${secMax}`);
  const sessionsCore = 'SELECT concat_ws(\',\', id, token_hash, user_id, created_at, expires_at, auth_method) FROM user_sessions';
  const oldSessions = digest(sessionsCore);
  const activeSessions = Number(q('SELECT count(*) FROM user_sessions WHERE revoked_at IS NULL;'));

  const run = psql(superUrl, { file: sqlFile, vars: { execute: 'true', reason: 'Owner request 2026-11-23: reset project data (synthetic test)', operator: 'tester', backup: '/var/backups/gsdn-pmis/pre-reset-test.dump' }, check: false });
  check('reset: the transaction commits', run.status === 0, run.err.trim().split('\n')[0]);
  if (run.status !== 0) return 1;
  const files = run.out.split('\n').filter((l) => l.startsWith('FILE|')).map((l) => l.slice(5)).sort();
  const done = run.out.split('\n').find((l) => l.startsWith('DONE|'))?.split('|') ?? [];
  const after = snapshot();

  const del = [...plan].filter(([, p]) => p.action === 'delete').map(([t]) => t);
  const notEmpty = del.filter((t) => after.get(t).n !== 0);
  check(`delete: all ${del.length} DELETE tables are empty`, notEmpty.length === 0, notEmpty.join(', '));
  const seeded = del.filter((t) => before.get(t).n > 0);
  console.log(`      DELETE tables without seed rows: ${del.filter((t) => before.get(t).n === 0).join(', ') || 'none'}`);
  check('delete: the seed reached the DELETE tables (the check is not vacuous)', seeded.length >= 40, `${seeded.length} seeded: missing ${del.filter((t) => before.get(t).n === 0).join(', ')}`);

  const keepTables = [...plan].filter(([, p]) => p.action === 'keep' || p.action === 'optional').map(([t]) => t).filter((t) => t !== 'user_sessions');
  const keepChanged = keepTables.filter((t) => before.get(t).h !== after.get(t).h);
  check(`keep: all ${keepTables.length + 1} KEEP and optional identity tables unchanged by everything row for row (user_sessions apart)`, keepChanged.length === 0, keepChanged.join(', '));
  check('keep: users, passwords, two-factor, recovery codes, groups, departments are present', ['users', 'local_credentials', 'user_totp', 'user_recovery_codes', 'group_members', 'departments'].every((t) => after.get(t).n > 0));
  check('keep: configuration present (workflow, SLA, lists, templates, matrix, settings, master columns, warehouse items)',
    ['task_definitions', 'sla_rules', 'list_values', 'template_versions', 'matrix_cells', 'settings', 'master_columns', 'warehouse_items', 'holidays', 'doc_sequences', 'doc_number_issues', 'external_parties']
      .every((t) => after.get(t).n > 0 && after.get(t).n === before.get(t).n));

  const sessionsAfter = q('SELECT count(*) FILTER (WHERE revoked_at IS NULL) || \'|\' || count(*) FILTER (WHERE revoke_reason = \'project_data_reset\') FROM user_sessions;');
  check('sessions: every open session is ended, with reason project_data_reset', sessionsAfter === `0|${activeSessions}`, sessionsAfter);
  check('sessions: no session row added, removed or otherwise changed', digest(sessionsCore) === oldSessions);

  const mixedExpect = { register_records: 2, register_steps: 2, document_slots: 1, document_files: 1, comments: 1, levels_conversions: 1, import_batches: 1,
    import_batch_rows: 1, user_drafts: 2, stored_object_meta: 1, document_record_snapshots: 1, comment_mentions: 0, register_level_actors: 0, register_record_locks: 0 };
  const mixedBad = Object.entries(mixedExpect).filter(([t, n]) => after.get(t).n !== n).map(([t, n]) => `${t}=${after.get(t).n} (want ${n})`);
  check('mixed: exactly the kept rows remain (company and vehicle, their steps, slot, file, comment, batch, drafts, envelope)', mixedBad.length === 0, mixedBad.join(', '));
  check('mixed: the kept rows are the company and the vehicle', q(`SELECT string_agg(register_key || '/' || record_type, ',' ORDER BY register_key) FROM register_records;`) === 'car_dispatcher/vehicle,contractors/company');
  check('mixed: the kept drafts are the form draft and the company draft', q(`SELECT string_agg(split_part(draft_key, '.', 1) || '.' || split_part(draft_key, '.', 2), ',' ORDER BY draft_key) FROM user_drafts;`) === 'form.profile,record.contractors');

  const wantFiles = ['docs/2026/11/project-snag-photo', 'docs/2026/11/project-task-file', 'exports/2026/11/project-export-file', 'imports/2026/11/project-master-file'];
  check('files: the quarantine list is exactly the stored objects of the deleted rows', JSON.stringify(files) === JSON.stringify(wantFiles), files.join(', '));
  check('files: the kept company document stays', q(`SELECT count(*) FROM stored_object_meta WHERE storage_key = 'docs/2026/11/kept-company-file';`) === '1');

  // logs
  check('audit: every earlier audit row is unchanged', digest(`SELECT a::text FROM audit_log a WHERE id <= ${auditMax}`) === oldAudit);
  check('audit: every earlier chain row is unchanged', digest(`SELECT c::text FROM audit_log_chain c WHERE audit_id <= ${auditMax}`) === oldAuditChain);
  check('audit: every earlier field-change row is unchanged', digest(`SELECT f::text FROM audit_field_changes f WHERE audit_id <= ${auditMax}`) === oldFieldChanges);
  const newAudit = q(`SELECT count(*) || '|' || string_agg(action || '|' || coalesce(actor_id::text, 'null') || '|' || entity_type, ',') FROM audit_log WHERE id > ${auditMax};`);
  check('audit: exactly one new row, project_data_reset, no actor', newAudit === '1|project_data_reset|null|system', newAudit);
  check('audit: the reset row is the reported one and is sealed on the chain', q(`SELECT count(*) FROM audit_log_chain c JOIN audit_log a ON a.id = c.audit_id WHERE a.action = 'project_data_reset' AND a.id = ${Number(done[1]) || 0};`) === '1');
  const counts = q(`SELECT (after -> 'deleted' ->> 'sites') || '|' || (after ->> 'sessions_ended') || '|' || (after ->> 'files_quarantined') || '|' || reason FROM audit_log WHERE id > ${auditMax};`);
  check('audit: the reset row carries the counts and the reason', counts === `2|${activeSessions}|4|Owner request 2026-11-23: reset project data (synthetic test)`, counts);
  check('audit: the reset row carries counts only (no site code, no name)', !/RST-0000|Synthetic Site|PO-RST/.test(q(`SELECT before::text || after::text FROM audit_log WHERE id > ${auditMax};`)));
  check('security: every earlier security-log row is unchanged', digest(`SELECT s::text FROM security_log s WHERE id <= ${secMax}`) === oldSec);
  check('security: every earlier chain row is unchanged', digest(`SELECT c::text FROM security_log_chain c WHERE security_id <= ${secMax}`) === oldSecChain);
  const newSec = q(`SELECT count(*) || '|' || count(*) FILTER (WHERE event = 'session_ended' AND detail ->> 'reason' = 'project_data_reset') FROM security_log WHERE id > ${secMax};`);
  check('security: the only new rows are one session_ended per ended session', newSec === `${activeSessions}|${activeSessions}`, newSec);
  const otherLogs = [...plan].filter(([t, p]) => p.action === 'log' && !['audit_log', 'audit_log_chain', 'audit_field_changes', 'security_log', 'security_log_chain', 'log_chain_heads'].includes(t))
    .map(([t]) => t).filter((t) => before.get(t).h !== after.get(t).h);
  check('logs: the System Log, job runs, mail outbox, status transitions and the other logs are unchanged', otherLogs.length === 0, otherLogs.join(', '));

  // sign-in still resolves, through the same function the API uses
  const lookup = q(`SELECT string_agg(user_id::text || '|' || status, ',') FROM (SELECT * FROM auth_local_lookup('reset.engineer@example.test') UNION ALL SELECT * FROM auth_local_lookup('9101')) x;`, superUrl);
  check('sign-in: both users still resolve with their password hash and status', /^a0000000-0000-4000-8000-000000000002\|active,[0-9a-f-]{36}\|(active|pending_assignment)$/.test(lookup), lookup);

  // the integrity check of both chains (the admin button's function), as the bootstrap System Admin, in a transaction that is rolled back
  const adminId = q(`SELECT id FROM users WHERE email = 'reset.admin@example.test';`);
  const verify = psql(appUrl, { input: `BEGIN;
SELECT txid_current() AS txid \\gset
\\set wire \`node ${signScript} :txid ${adminId}\`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex')) \\g /dev/null
SELECT (log_verify_chain('audit') ->> 'status') || '|' || (log_verify_chain('security') ->> 'status');
ROLLBACK;` , check: false });
  check('integrity: log_verify_chain says ok for the Audit Log and the security log', verify.out.trim() === 'ok|ok', (verify.out + verify.err).trim().split('\n').slice(0, 3).join(' / '));

  // a second dry run finds nothing left to delete
  const again = psql(superUrl, { file: sqlFile, vars: { execute: 'false' } }).out.split('\n').filter((l) => l.startsWith('PLAN|')).map((l) => l.split('|'));
  check('idempotent: a second dry run finds nothing to delete', again.every((p) => p[4] === '0'), again.filter((p) => p[4] !== '0').map((p) => p[1]).join(', '));
  return failures ? 1 : 0;
}

let code;
try {
  code = main();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  code = 2;
}
if (!keepDb) {
  try { q(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`, urlFor('postgres')); } catch (e) { console.error(`could not drop ${dbName}: ${e.message}`); }
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(code);
