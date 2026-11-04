#!/usr/bin/env node
// GSDN PMIS: database security suite (P1-QA-02).
//
// Builds a scratch database, applies the migrations and the grants, loads synthetic fixtures, then runs every negative
// case as the application role pmis_app and checks the outcome. Zero dependencies: it drives the psql client.
//
// Usage:   node tests/db-security/run.mjs [--keep-db] [--only <category>] [--list]
// Exit:    0 = every case PASS, 1 = at least one case FAIL, 2 = setup failed (no verdict on the cases)
//
// Connection settings come from environment variables; the defaults are container-only test credentials:
//   PMIS_SECSUITE_PSQL            psql binary                       (psql)
//   PMIS_SECSUITE_PGHOST          host                              (127.0.0.1)
//   PMIS_SECSUITE_PGPORT          port                              (5432)
//   PMIS_SECSUITE_SUPER_USER      superuser that builds the DB      (postgres)
//   PMIS_SECSUITE_SUPER_PASSWORD  its password                      (localtest)
//   PMIS_SECSUITE_APP_USER        application role under test       (pmis_app)
//   PMIS_SECSUITE_APP_PASSWORD    its password                      (testpass-123456)
//   PMIS_SECSUITE_DB              scratch database name             (pmis_secsuite)
//   PMIS_SECSUITE_CONTEXT_KEY     test session-context key, hex     (a fixed test key; loaded into pmis_context_keys, used by sign-context.mjs)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pmisRoot = resolve(here, '..', '..');
const migrationsDir = join(pmisRoot, 'apps', 'api', 'prisma', 'migrations');
const grantsFile = join(pmisRoot, 'db', 'sql', 'app_grants.sql');
const sqlDir = join(here, 'sql');
const casesDir = join(here, 'cases');
const resultsDir = join(here, 'results');

const env = (name, fallback) => process.env[name] ?? fallback;
const cfg = {
  psql: env('PMIS_SECSUITE_PSQL', 'psql'),
  host: env('PMIS_SECSUITE_PGHOST', '127.0.0.1'),
  port: env('PMIS_SECSUITE_PGPORT', '5432'),
  superUser: env('PMIS_SECSUITE_SUPER_USER', 'postgres'),
  superPassword: env('PMIS_SECSUITE_SUPER_PASSWORD', 'localtest'),
  appUser: env('PMIS_SECSUITE_APP_USER', 'pmis_app'),
  appPassword: env('PMIS_SECSUITE_APP_PASSWORD', 'testpass-123456'),
  db: env('PMIS_SECSUITE_DB', 'pmis_secsuite'),
  // Test key of the verified session context (migration 0069). Never a production key; the child processes (psql, sign-context.mjs) inherit it.
  contextKey: env('PMIS_SECSUITE_CONTEXT_KEY', '5ec5a17e'.repeat(8)),
};
process.env.PMIS_SECSUITE_CONTEXT_KEY = cfg.contextKey;
const signScript = join(here, 'sign-context.mjs');

const args = process.argv.slice(2);
const keepDb = args.includes('--keep-db');
const listOnly = args.includes('--list');
const onlyIdx = args.indexOf('--only');
const onlyCategory = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

function psql({ role, password, database, input, file, tuples = false }) {
  const a = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', cfg.host, '-p', cfg.port, '-U', role, '-d', database];
  if (tuples) a.push('-A', '-t');
  if (file) a.push('-f', file);
  const r = spawnSync(cfg.psql, a, {
    input: file ? undefined : input ?? '',
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: password },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
  });
  if (r.error) throw new Error(`cannot run ${cfg.psql}: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const asSuper = (input, database = cfg.db, opts = {}) =>
  psql({ role: cfg.superUser, password: cfg.superPassword, database, input, ...opts });
const asApp = (input, opts = {}) =>
  psql({ role: cfg.appUser, password: cfg.appPassword, database: cfg.db, input, ...opts });

const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) ?? '';
const lastNonEmpty = (s) => (s || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------------------------------
// Case files: "-- @case ID" ... "-- @end". Header lines start with "-- @". "@expect error 23514|42501 regex" accepts
// either SQLSTATE when two layers may refuse the same attack; the message regex still has to match.
// ---------------------------------------------------------------------------------------------------------------------
function parseExpect(text, id) {
  const t = text.trim();
  let m = t.match(/^error\s+([0-9A-Z]{5}(?:\|[0-9A-Z]{5})*)(?:\s+(.+))?$/);
  if (m) return { kind: 'error', sqlstates: m[1].split('|'), msg: m[2] ? m[2].trim() : null };
  m = t.match(/^output\s*(>=)?\s*(.+)$/);
  if (m) return { kind: 'output', ge: Boolean(m[1]), value: m[2].trim() };
  if (t === 'ok') return { kind: 'ok' };
  throw new Error(`case ${id}: unknown @expect "${t}"`);
}

function parseCases(file) {
  const cases = [];
  let cur = null;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const start = line.match(/^--\s*@case\s+(\S+)\s*$/);
    if (start) {
      cur = { id: start[1], file: file.split('/').pop(), title: '', category: '', actor: null, region: null, expect: null, body: [] };
      continue;
    }
    if (/^--\s*@end\s*$/.test(line)) {
      if (cur) {
        if (!cur.expect) throw new Error(`case ${cur.id} in ${cur.file} has no @expect`);
        cases.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const h = line.match(/^--\s*@(\w+)\s*(.*)$/);
    if (h) {
      const [, key, value] = h;
      if (key === 'title') cur.title = value.trim();
      else if (key === 'category') cur.category = value.trim();
      else if (key === 'actor') cur.actor = value.trim();
      else if (key === 'region') cur.region = value.trim();
      else if (key === 'expect') cur.expect = parseExpect(value, cur.id);
      else throw new Error(`case ${cur.id}: unknown header @${key}`);
      continue;
    }
    cur.body.push(line);
  }
  return cases;
}

function resolvePlaceholders(text, ids, id) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in ids)) throw new Error(`case ${id}: unknown placeholder {{${name}}}`);
    return ids[name];
  });
}

// Session context (migration 0069). A case with @actor runs in a verified context: the runner starts the transaction, reads txid_current(), signs the
// context with the test key (sign-context.mjs, through a psql backtick) and calls app_begin, exactly as the API does. The database derives the regions, so
// "@region 1" means a session whose data-derived regions are exactly region 1: when the actor's assignments do not give that, the runner changes them
// (as the superuser, outside the case, restored afterwards) and the digest of the tables is taken after the change and before the restore.
//   @region *   an actor who is a System Admin gets '*' from the data. DEL_ALL and DEL_RD get an all-regions assignment. For anyone else (ALICE), '*' is a
//               FORGED setting: the verified context keeps the data-derived regions, and the plain setting app.region_ids = '*' is set in addition.
//   no @actor   no context at all (like a request before sign-in); the plain settings are set as the case says, to prove the database ignores them.
const ALL_REGION_ACTORS = new Set(['DEL_ALL', 'DEL_RD']);
const TEMP_ASSIGNMENT = '00000000-0000-4000-8000-0000000000f1';
const infoCache = new Map();
function actorInfo(id) {
  if (!infoCache.has(id)) {
    const r = asSuper(`SELECT app_user_is_system_admin('${id}')::text || '|' || coalesce(app_resolve_region_ids('${id}'), '');`, cfg.db, { tuples: true });
    if (r.status !== 0) throw new Error(`cannot read the regions of ${id}: ${firstLine(r.stderr)}`);
    const [admin, regions] = lastNonEmpty(r.stdout).split('|');
    infoCache.set(id, { admin: admin === 'true', regions: regions ?? '' });
  }
  return infoCache.get(id);
}

function planContext(c, ids) {
  if (!c.actor || c.actor === 'none') return { begin: false, userId: null, forge: c.region ?? null, prep: null };
  if (!(c.actor in ids)) throw new Error(`case ${c.id}: unknown actor ${c.actor}`);
  const userId = ids[c.actor];
  const info = actorInfo(userId);
  const plan = { begin: true, userId, forge: null, prep: null };
  if (!c.region) return plan;
  if (c.region === '*') {
    if (info.admin || info.regions === '*') return plan;
    if (ALL_REGION_ACTORS.has(c.actor)) plan.prep = { all: true, regions: [] };
    else plan.forge = '*';
    return plan;
  }
  const want = c.region.split(',').map((x) => Number(x.trim())).sort((x, y) => x - y);
  const have = info.regions === '*' ? ['*'] : info.regions.split(',').filter(Boolean).map(Number).sort((x, y) => x - y);
  if (want.join(',') !== have.join(',')) plan.prep = { all: false, regions: want };
  return plan;
}

// Changes the actor's assignments so that the derived regions are the wanted ones. Returns what restore() needs.
function prepareRegions(plan, ids) {
  const u = plan.userId;
  const saved = asSuper(`SELECT id || '|' || coalesce(valid_to::text, '') FROM user_role_assignments WHERE user_id = '${u}' AND id <> '${TEMP_ASSIGNMENT}' ORDER BY id;`, cfg.db, { tuples: true });
  if (saved.status !== 0) throw new Error(`cannot read the assignments of ${u}: ${firstLine(saved.stderr)}`);
  const rows = saved.stdout.split('\n').filter(Boolean).map((l) => l.split('|'));
  const sql = [
    'SET session_replication_role = replica;',
    `UPDATE user_role_assignments SET valid_to = valid_from + interval '1 millisecond' WHERE user_id = '${u}';`,
    `INSERT INTO user_role_assignments (id, user_id, role_id, permission_level, team, valid_from, all_regions, all_modules, is_primary)
       VALUES ('${TEMP_ASSIGNMENT}', '${u}', '${ids.ROLE_TE}', 'entry', 'te', now() - interval '1 hour', ${plan.prep.all}, true, false);`,
    ...plan.prep.regions.map((r) => `INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ('${TEMP_ASSIGNMENT}', ${r});`),
  ].join('\n');
  const r = asSuper(sql);
  if (r.status !== 0) throw new Error(`cannot set the regions of ${u}: ${firstLine(r.stderr)}`);
  infoCache.delete(u);
  return rows;
}

function restoreRegions(plan, rows) {
  const u = plan.userId;
  const sql = [
    'SET session_replication_role = replica;',
    `DELETE FROM user_role_assignment_regions WHERE assignment_id = '${TEMP_ASSIGNMENT}';`,
    `DELETE FROM user_role_assignments WHERE id = '${TEMP_ASSIGNMENT}';`,
    ...rows.map(([id, vt]) => `UPDATE user_role_assignments SET valid_to = ${vt ? `'${vt}'::timestamptz` : 'NULL'} WHERE id = '${id}';`),
  ].join('\n');
  const r = asSuper(sql);
  if (r.status !== 0) throw new Error(`cannot restore the assignments of ${u}: ${firstLine(r.stderr)}`);
  infoCache.delete(u);
}

// Attack script: the verified context, then the body, all inside one transaction that the runner always rolls back (except for positive controls, which
// commit). Deferred checks (the last-admin triggers, the assignment scope checks) are run at the end with SET CONSTRAINTS ALL IMMEDIATE, which is exactly
// what COMMIT would do, but without persisting anything. So a refusal comes from the same place as in production: the function's own check first, the
// trigger at commit.
function beginLines(userId) {
  return [
    'SELECT txid_current() AS txid \\gset',
    `\\set wire \`node ${signScript} :txid ${userId} via=manual\``,
    "SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex')) AS began \\gset",
  ];
}

// A line "\ctx NAME" in a case body switches the transaction to a verified context for that fixture user (the legitimate form of what used to be
// SET app.user_id = '...' in the middle of a case: a second person acting in the same transaction, signed with the test key).
function expandCtx(body, ids, id) {
  return body.replace(/^\\ctx\s+(\w+)\s*$/gm, (_, name) => {
    if (!(name in ids)) throw new Error(`case ${id}: unknown user ${name} in \\ctx`);
    return beginLines(ids[name]).join('\n');
  });
}

function buildAttack(c, ids, plan) {
  const lines = ['\\set VERBOSITY verbose', 'BEGIN;'];
  if (plan.begin) lines.push(...beginLines(plan.userId));
  if (plan.forge) lines.push(`SET app.region_ids = '${plan.forge}';`);
  lines.push(expandCtx(resolvePlaceholders(c.body.join('\n'), ids, c.id), ids, c.id));
  lines.push('SET CONSTRAINTS ALL IMMEDIATE;');
  lines.push(c.expect.kind === 'ok' ? 'COMMIT;' : 'ROLLBACK;');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------------------
function evaluate(c, res, before, after) {
  const e = c.expect;
  const changed = before.join('\n') !== after.join('\n')
    ? after.filter((x, i) => x !== before[i]).map((x) => x.split('=')[0])
    : [];
  const serverError = res.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s*(.*)/);

  if (e.kind === 'ok') {
    if (res.status === 0) return { verdict: 'PASS', evidence: 'committed as expected' };
    return { verdict: 'FAIL', evidence: serverError ? `${serverError[1]}: ${oneLine(serverError[2])}` : oneLine(firstLine(res.stderr)) };
  }

  if (e.kind === 'error') {
    if (res.status === 0) {
      return { verdict: 'FAIL', evidence: 'the statements completed without an error (refusal expected); the runner rolled them back' };
    }
    if (!serverError) return { verdict: 'FAIL', evidence: `no server error: ${oneLine(firstLine(res.stderr))}` };
    const [, state, message] = serverError;
    if (!e.sqlstates.includes(state)) return { verdict: 'FAIL', evidence: `${state}: ${oneLine(message)} (expected SQLSTATE ${e.sqlstates.join(' or ')})` };
    if (e.msg && !new RegExp(e.msg, 'i').test(message)) {
      return { verdict: 'FAIL', evidence: `${state}: ${oneLine(message)} (expected message containing "${e.msg}")` };
    }
    if (changed.length) return { verdict: 'FAIL', evidence: `state changed: ${changed.join(', ')}` };
    return { verdict: 'PASS', evidence: `${state}: ${oneLine(message)}` };
  }

  // output
  if (serverError) return { verdict: 'FAIL', evidence: `${serverError[1]}: ${oneLine(serverError[2])}` };
  const got = lastNonEmpty(res.stdout);
  let ok;
  if (e.ge) ok = Number(got) >= Number(e.value);
  else ok = got === e.value;
  const evidence = `output "${got}"${e.ge ? ` (expected >= ${e.value})` : ` (expected "${e.value}")`}`;
  if (!ok) return { verdict: 'FAIL', evidence };
  if (changed.length) return { verdict: 'FAIL', evidence: `state changed: ${changed.join(', ')}` };
  return { verdict: 'PASS', evidence };
}

// ---------------------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------------------
function setupFail(step, r) {
  console.error(`SETUP FAILED at ${step}: ${oneLine(firstLine(r.stderr)) || `exit ${r.status}`}`);
  process.exit(2);
}

function buildDatabase() {
  const q = (sql) => asSuper(sql, 'postgres');
  let r = q(`DROP DATABASE IF EXISTS ${cfg.db} WITH (FORCE); CREATE DATABASE ${cfg.db};`);
  if (r.status !== 0) setupFail('create database', r);

  // The migrations run as a member of pmis_migrator, the documented deployment role (0003). The superuser gets the
  // membership here, as a deployment would with GRANT pmis_migrator TO <deploy_login>.
  r = q(`GRANT pmis_migrator TO ${cfg.superUser};`);
  if (r.status !== 0) setupFail('grant pmis_migrator', r);

  const dirs = readdirSync(migrationsDir).filter((d) => /^0\d+_/.test(d)).sort();
  if (!dirs.length) setupFail('migrations', { stderr: `no migrations in ${migrationsDir}`, status: 1 });
  for (const d of dirs) {
    const file = join(migrationsDir, d, 'migration.sql');
    if (!existsSync(file)) setupFail(`migration ${d}`, { stderr: 'migration.sql missing', status: 1 });
    r = asSuper('', cfg.db, { file });
    if (r.status !== 0) setupFail(`migration ${d}`, r);
    console.log(`  migrated ${d}`);
  }

  r = asSuper('', cfg.db, { file: grantsFile });
  if (r.status !== 0) setupFail('app_grants.sql', r);
  console.log('  applied db/sql/app_grants.sql');

  r = asSuper(`SELECT app_ctx_key_install('${cfg.contextKey}');`, cfg.db, { tuples: true });
  if (r.status !== 0) setupFail('install the session context key', r);
  console.log('  installed the test session context key');

  for (const f of ['00_harness.sql', '01_fixtures.sql']) {
    r = asSuper('', cfg.db, { file: join(sqlDir, f) });
    if (r.status !== 0) setupFail(`sql/${f}`, r);
    console.log(`  applied tests/db-security/sql/${f}`);
  }

  r = asSuper(`SELECT name || E'\\t' || value FROM public.secsuite_ids ORDER BY name;`, cfg.db, { tuples: true });
  if (r.status !== 0) setupFail('read fixture ids', r);
  const ids = {};
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [k, ...v] = line.split('\t');
    ids[k] = v.join('\t');
  }
  ids.SIGN = signScript;
  return ids;
}

function preflight() {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  const who = asApp(`SELECT current_user || ' ' || (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user)
      || ' ' || (SELECT rolbypassrls::text FROM pg_roles WHERE rolname = current_user)
      || ' ' || pg_has_role(current_user, 'pmis_migrator', 'member')::text
      || ' ' || pg_has_role(current_user, 'pmis_identity_owner', 'member')::text
      || ' ' || pg_has_role(current_user, 'pmis_definer', 'member')::text
      || ' ' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user)::text;`, { tuples: true });
  const parts = lastNonEmpty(who.stdout).split(' ');
  add('connected as the application role', parts[0] === cfg.appUser, `current_user=${parts[0]}`);
  add('application role is not a superuser and has no BYPASSRLS', parts[1] === 'false' && parts[2] === 'false');
  add('application role is not a member of pmis_migrator', parts[3] === 'false');
  add('application role is not a member of pmis_identity_owner or pmis_definer', parts[4] === 'false' && parts[5] === 'false');
  add('application role owns no table in public', parts[6] === '0', `owned tables=${parts[6]}`);
  return checks;
}

function snapshot() {
  const r = asSuper(`SELECT tbl || '=' || digest FROM public.secsuite_snapshot() ORDER BY tbl;`, cfg.db, { tuples: true });
  if (r.status !== 0) throw new Error(`snapshot failed: ${firstLine(r.stderr)}`);
  return r.stdout.split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------
const caseFiles = readdirSync(casesDir).filter((f) => f.endsWith('.sql')).sort();
let cases = caseFiles.flatMap((f) => parseCases(join(casesDir, f)));
const seen = new Set();
for (const c of cases) {
  if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
  seen.add(c.id);
}
if (onlyCategory) cases = cases.filter((c) => c.category === onlyCategory);

if (listOnly) {
  for (const c of cases) console.log(`${c.id.padEnd(8)} ${c.category.padEnd(20)} ${c.title}`);
  console.log(`${cases.length} cases`);
  process.exit(0);
}

console.log(`GSDN PMIS database security suite: database ${cfg.db} on ${cfg.host}:${cfg.port}`);
console.log('Building the scratch database');
const ids = buildDatabase();

const pre = preflight();
for (const p of pre) console.log(`${p.ok ? 'PRE PASS' : 'PRE FAIL'}  ${p.name}${p.detail ? ` (${p.detail})` : ''}`);
if (pre.some((p) => !p.ok)) {
  console.error('SETUP FAILED: the application role does not have the expected privileges');
  process.exit(2);
}

mkdirSync(resultsDir, { recursive: true });
const results = [];
const started = Date.now();
for (const c of cases) {
  const t0 = Date.now();
  let res;
  let before;
  let after;
  try {
    const plan = planContext(c, ids);
    const saved = plan.prep ? prepareRegions(plan, ids) : null;
    try {
      const attack = buildAttack(c, ids, plan);
      before = snapshot();
      res = asApp(attack, { tuples: true });
      after = snapshot();
    } finally {
      if (saved) restoreRegions(plan, saved);
    }
    const v = evaluate(c, res, before, after);
    results.push({ id: c.id, category: c.category, title: c.title, verdict: v.verdict, evidence: v.evidence, ms: Date.now() - t0 });
  } catch (err) {
    results.push({ id: c.id, category: c.category, title: c.title, verdict: 'FAIL', evidence: `runner error: ${err.message}`, ms: Date.now() - t0 });
  }
  const r = results[results.length - 1];
  console.log(`${r.verdict}  ${r.id.padEnd(8)} ${r.title}\n        ${r.evidence}`);
}

const failed = results.filter((r) => r.verdict === 'FAIL');
const passed = results.length - failed.length;
const byCat = {};
for (const r of results) {
  byCat[r.category] ??= { pass: 0, fail: 0 };
  byCat[r.category][r.verdict === 'PASS' ? 'pass' : 'fail'] += 1;
}
console.log('\nSummary by category');
for (const [cat, n] of Object.entries(byCat)) console.log(`  ${cat.padEnd(22)} pass ${String(n.pass).padStart(3)}  fail ${String(n.fail).padStart(3)}`);
console.log(`\n${results.length} cases: ${passed} PASS, ${failed.length} FAIL (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) {
  console.log('FAILED:');
  for (const r of failed) console.log(`  ${r.id}  ${r.title}\n      ${r.evidence}`);
}

writeFileSync(join(resultsDir, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), database: cfg.db, total: results.length, pass: passed, fail: failed.length, results }, null, 2) + '\n');

if (!keepDb) {
  const drop = psql({ role: cfg.superUser, password: cfg.superPassword, database: 'postgres', input: `DROP DATABASE IF EXISTS ${cfg.db} WITH (FORCE);` });
  if (drop.status !== 0) console.log(`note: could not drop ${cfg.db}: ${firstLine(drop.stderr)}`);
}

process.exit(failed.length ? 1 : 0);
