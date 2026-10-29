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
};

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

// Attack script: the session context, then the body, all inside one transaction that the runner always rolls back
// (except for positive controls, which commit). Deferred checks (the last-admin triggers, the assignment scope checks)
// are run at the end with SET CONSTRAINTS ALL IMMEDIATE, which is exactly what COMMIT would do, but without persisting
// anything. So a refusal comes from the same place as in production: the function's own check first, the trigger at commit.
function buildAttack(c, ids) {
  const lines = ['\\set VERBOSITY verbose', 'BEGIN;'];
  if (c.actor && c.actor !== 'none') {
    if (!(c.actor in ids)) throw new Error(`case ${c.id}: unknown actor ${c.actor}`);
    lines.push(`SET app.user_id = '${ids[c.actor]}';`);
  }
  if (c.region) lines.push(`SET app.region_ids = '${c.region}';`);
  lines.push(resolvePlaceholders(c.body.join('\n'), ids, c.id));
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
    const attack = buildAttack(c, ids);
    before = snapshot();
    res = asApp(attack, { tuples: true });
    after = snapshot();
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
