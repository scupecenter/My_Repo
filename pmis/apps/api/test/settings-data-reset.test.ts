import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** When set, the next file move fails as a whole (the store cannot be read): the database part stays committed and the move is retried. */
const failMove = vi.hoisted(() => ({ once: false }));
vi.mock('../src/settings/data-reset-files', async (orig) => {
  const real = await orig<typeof import('../src/settings/data-reset-files')>();
  return {
    ...real,
    quarantineFiles: async (...a: Parameters<typeof real.quarantineFiles>) => {
      if (failMove.once) {
        failMove.once = false;
        throw new Error('synthetic: the document store cannot be read');
      }
      return real.quarantineFiles(...a);
    },
  };
});
import { q } from './calc-helpers';
import { BOOTSTRAP_ADMIN } from './global-setup';
import { Api, loggedIn, startApp } from './helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';
import { DataResetService } from '../src/settings/data-reset.service';
import { MaintenanceService } from '../src/settings/maintenance.service';
import { quarantineFiles } from '../src/settings/data-reset-files';
import { IntegrityService } from '../src/logs/integrity.service';

/**
 * Migration 0146 (contract 0.15.62): the project data reset in Settings with two System Admins. The suite runs in its own database (TEST_DATABASE_URL_DRST)
 * and its own document store: it loads the synthetic project data of tests/ops/reset-seed.sql, then requests, approves and runs the reset, which empties the
 * project tables and ends every session but the runner's. Migration 0152 (contract 0.15.71): the scope (parts, closure computed by the database, hash binding of
 * the approval, per-part counts) and, after the full run, a scoped run of the identity parts.
 */
const SEED = resolve(__dirname, '..', '..', '..', 'tests', 'ops', 'reset-seed.sql');
const PROJECT_KEYS = ['docs/2026/11/project-task-file', 'docs/2026/11/project-snag-photo', 'exports/2026/11/project-export-file', 'imports/2026/11/project-master-file'];
const KEPT_KEY = 'docs/2026/11/kept-company-file';

let app: NestExpressApplication;
let db: PgClient;
let root: string;
let store: string;
let outside: string;
let admin1: Actor;      // requests and runs
let admin2: Actor;      // approves
let admin3: Actor;      // a third System Admin, neither requester nor approver
let adminNoStep: Actor; // a System Admin without a step-up
let plain: Actor;       // a user with the Sites module only
let deleg: Actor;       // a full delegate of the System Admin (all rights, all regions)
let phrase = '';

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const svc = () => app.get(DataResetService);
const settle = async () => {
  for (let i = 0; i < 400 && svc().running.size > 0; i++) await Promise.all([...svc().running]);
};
const backupRow = (ageHours = 0) => db.query(
  `INSERT INTO system_log (at, level, source, message, context) VALUES (now() - make_interval(hours => $1), 'info', 'backup', 'Database backup completed',
     '{"script":"db-backup","event":"backup_ok","mode":"full","type":"full","repos":"1","stanza":"gsdn-pmis"}'::jsonb)`, [ageHours]);
const post = (who: Actor, path: string, body: unknown, ifMatch?: string) =>
  who.api.call('post', `/settings/data-reset${path}`, body, ifMatch === undefined ? {} : { 'If-Match': ifMatch });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmis-drst-'));
  store = join(root, 'files');
  outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  for (const k of [...PROJECT_KEYS, KEPT_KEY]) {
    mkdirSync(join(store, k, '..'), { recursive: true });
    writeFileSync(join(store, k), `synthetic ${k}`);
  }
  // a project key whose file is a symbolic link to a file outside the store: refused and left in place, the target never touched
  writeFileSync(join(outside, 'victim'), 'outside the store');
  rmSync(join(store, 'imports/2026/11/project-master-file'));
  symlinkSync(join(outside, 'victim'), join(store, 'imports/2026/11/project-master-file'));

  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DRST as string, storage: { driver: 'local', localDir: store } });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_DRST });
  await db.connect();
  admin1 = await plainAdmin(app, db);
  admin2 = await plainAdmin(app, db);
  admin3 = await plainAdmin(app, db);
  adminNoStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: [['sites', 'view']], regions: [1], modules: null });
  deleg = await actor(app, db, { level: 'view', grants: [['sites', 'view']], regions: [1], modules: null });
  const from = await q<{ id: string }>(db, 'SELECT id FROM users WHERE email = $1', [BOOTSTRAP_ADMIN.email]);
  await db.query(`INSERT INTO delegations (from_user_id, target_kind, target_user_id, is_full, all_regions, valid_from, reason)
                  VALUES ($1, 'user', $2, true, true, now() - interval '1 minute', 'full delegate (synthetic)')`, [from[0]!.id, deleg.user.id]);
  // the synthetic project data of the operator script's test (its "admin" is the user with this e-mail)
  await db.query(`UPDATE users SET email = 'reset.admin@example.test' WHERE id = $1`, [admin3.user.id]);
  await db.query(readFileSync(SEED, 'utf8').split('\n').filter((l) => !l.startsWith('\\')).map((l) => l.replace(/ \\g \/dev\/null$/, ';')).join('\n'));
  phrase = `RESET ${(await q<{ d: string }>(db, 'SELECT current_database() AS d'))[0]!.d}`;
  // the existing run tests approve and run at once: the waiting period (default 24 h) is off for this suite, the tests of 0372 turn it on
  const cur = await admin1.api.call('get', '/settings/data-reset');
  await admin1.api.call('put', '/settings/data-reset/settings', { reason: 'Suite setup: no waiting period', request_expiry_minutes: 30, backup_max_age_hours: 24, cooloff_minutes: 0 }, { 'If-Match': String(cur.body.settings.version) });
}, 120_000);

afterAll(async () => {
  await settle();
  await db.end();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('who may use the data reset', () => {
  it('a plain user and a full delegate of the System Admin get 403 on every route; nobody signed in gets 401', async () => {
    for (const who of [plain, deleg]) {
      expect((await who.api.call('get', '/settings/data-reset')).status).toBe(403);
      expect((await post(who, '/requests', { reason: 'A long enough synthetic reason', confirm_text: phrase })).status).toBe(403);
    }
    expect((await new Api(app).raw('get', '/settings/data-reset')).status).toBe(401);
    expect(await q(db, 'SELECT 1 FROM data_reset_requests')).toHaveLength(0);
  });

  it('pmis_app never writes the System Log source backup (the backup precondition reads it)', async () => {
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DRST });
    await c.connect();
    try {
      await expect(c.query(`SELECT log_system_write('info', 'backup', 'forged', '{"script":"db-backup","event":"backup_ok","type":"full"}'::jsonb, NULL, NULL)`))
        .rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT * FROM data_reset_requests')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT data_reset_core(false, NULL, NULL, NULL, NULL)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });
});

describe('the state of the screen', () => {
  it('shows the plan with its counts, the backup (none yet), the System Admins, and no request', async () => {
    const res = await admin1.api.call('get', '/settings/data-reset');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmation_phrase: phrase, single_admin: false, maintenance: false, request: null, storage: { driver: 'local', supported: true },
      backup: { ok: false, max_age_hours: 24, last_success: null }, settings: { request_expiry_minutes: 30, backup_max_age_hours: 24 }, can: { request: true } });
    expect(res.body.system_admins_active).toBeGreaterThanOrEqual(4);
    const tables = new Map<string, { action: string; delete: number; keep: number }>(res.body.plan.tables.map((t: { table: string }) => [t.table, t]));
    expect(tables.get('sites')).toMatchObject({ action: 'delete', delete: 2, keep: 0 });
    expect(tables.get('users')).toMatchObject({ action: 'optional', delete: 0 });
    expect(tables.get('register_records')).toMatchObject({ action: 'mixed', keep: 2 });
    expect(tables.get('audit_log')?.action).toBe('log');
    expect(res.body.plan.files).toBe(4);
    expect(res.body.plan.error).toBeNull();
  });

  it('carries the catalogue of parts with their labels, dependencies and rows; everything is every project part, no identity part', async () => {
    const res = await admin1.api.call('get', '/settings/data-reset');
    const parts = new Map<string, any>(res.body.plan.parts.map((p: { code: string }) => [p.code, p]));
    expect(parts.get('sites')).toMatchObject({ kind: 'project', depends_on: [], selected: true, label_ar: expect.any(String) });
    expect(parts.get('sites').dependents).toEqual(expect.arrayContaining(['issues', 'documents', 'imports', 'procurement']));
    expect(parts.get('car_dispatcher')).toMatchObject({ depends_on: ['sites', 'procurement'] });
    expect(parts.get('procurement').rows).toBeGreaterThan(0);
    expect(parts.get('procurement').tables).toMatchObject({ procurement_records: 1 });
    for (const code of ['users', 'roles', 'staff']) expect(parts.get(code)).toMatchObject({ kind: 'identity', selected: false });
    expect(res.body.everything).not.toContain('users');
    expect(res.body.plan.scope).toMatchObject({ everything: true, identity: [], hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(res.body.plan.tables.find((t: { table: string }) => t.table === 'users')).toMatchObject({ action: 'optional', part: 'users', delete: 0 });
  });

  it('a table that a later migration added without a decision stops the plan: the screen says which one', async () => {
    await db.query('CREATE TABLE zz_unclassified_synthetic (id integer)');
    try {
      const res = await admin1.api.call('get', '/settings/data-reset');
      expect(res.status).toBe(200);
      expect(res.body.plan.error).toMatch(/tables without a decision.*zz_unclassified_synthetic/);
      expect(res.body.plan.tables).toEqual([]);
    } finally {
      await db.query('DROP TABLE zz_unclassified_synthetic');
    }
  });
});

describe('request, approve, cancel, expire', () => {
  let id = '';

  it('the request needs the typed phrase, a reason of 10 characters and a step-up', async () => {
    const bad = await post(admin1, '/requests', { reason: 'A long enough synthetic reason', confirm_text: 'RESET something' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('confirmation_mismatch');
    const short = await post(admin1, '/requests', { reason: 'too short', confirm_text: phrase });
    expect(short.status).toBe(422);
    expect(short.body.errors[0]).toMatchObject({ path: '/reason' });
    const ns = await post(adminNoStep, '/requests', { reason: 'A long enough synthetic reason', confirm_text: phrase });
    expect(ns.status).toBe(401);
    expect(ns.body.code).toBe('step_up_required');
    expect((await post(admin1, '/requests', { reason: 'A long enough synthetic reason', confirm_text: phrase, extra: 1 })).status).toBe(422);
  });

  it('requests: 201, the other System Admins are told, audited and in the security log; a second request is refused', async () => {
    const res = await post(admin1, '/requests', { reason: 'Owner decision: start the real data load', confirm_text: phrase });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'requested', requested_by: { id: admin1.user.id }, expired: false, plan_at_request: { sites: 2, files: 4 } });
    expect(etag(res)).toBe(`"${res.body.version}"`);
    id = res.body.id;
    expect(await q(db, `SELECT 1 FROM notifications WHERE kind = 'data_reset_request' AND user_id = $1`, [admin2.user.id])).toHaveLength(1);
    expect(await q(db, `SELECT 1 FROM notifications WHERE kind = 'data_reset_request' AND user_id = $1`, [admin1.user.id])).toHaveLength(0);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_request' AND entity_id = $1 AND actor_id = $2`, [id, admin1.user.id])).toHaveLength(1);
    expect(await q(db, `SELECT 1 FROM security_log WHERE event = 'project_data_reset' AND detail ->> 'step' = 'request' AND detail ->> 'request_id' = $1`, [id])).toHaveLength(1);
    const again = await post(admin2, '/requests', { reason: 'Owner decision: start the real data load', confirm_text: phrase });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
  });

  it('nobody approves their own request; a delegate never approves', async () => {
    const r = await admin1.api.call('get', `/settings/data-reset/requests/${id}`);
    const self = await post(admin1, `/requests/${id}/approve`, { reason: 'Approving my own request' }, etag(r));
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_approval_forbidden');
    expect((await post(deleg, `/requests/${id}/approve`, { reason: 'A delegate approves it' }, etag(r))).status).toBe(403);
  });

  it('an expired request cannot be approved and leaves the screen', async () => {
    await db.query(`UPDATE data_reset_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    const r = await admin2.api.call('get', `/settings/data-reset/requests/${id}`);
    expect(r.body.status).toBe('expired');
    const res = await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it' }, etag(r));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('request_expired');
    const st = await admin2.api.call('get', '/settings/data-reset');
    expect(st.body.request).toBeNull();
    expect(st.body.last_request).toMatchObject({ id, status: 'expired' });
  });

  it('either admin cancels; a cancelled request cannot be approved', async () => {
    const res = await post(admin1, '/requests', { reason: 'Owner decision: start the real data load', confirm_text: phrase });
    expect(res.status).toBe(201);
    const c = await post(admin2, `/requests/${res.body.id}/cancel`, { reason: 'Not this week' }, etag(res));
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', cancelled_by: { id: admin2.user.id }, cancel_reason: 'Not this week' });
    const a = await post(admin2, `/requests/${res.body.id}/approve`, { reason: 'Second admin agrees with it' }, etag(c));
    expect(a.status).toBe(409);
  });
});


describe('the scope of a request (0.15.71)', () => {
  let id = '';
  let hash = '';

  it('the dry run of a scope counts per part and per table; the database adds the dependent parts', async () => {
    const res = await admin1.api.call('get', '/settings/data-reset/plan?parts=procurement');
    expect(res.status).toBe(200);
    expect(res.body.scope).toMatchObject({ requested: ['procurement'], parts: ['car_dispatcher', 'financial_advances', 'invoices', 'procurement'],
      added: ['car_dispatcher', 'financial_advances', 'invoices'], everything: false });
    const tables = new Map<string, { delete: number; keep: number }>(res.body.tables.map((t: { table: string }) => [t.table, t]));
    expect(tables.get('sites')).toMatchObject({ delete: 0 });
    expect(tables.get('procurement_records')).toMatchObject({ delete: 1 });
    expect(tables.get('vehicle_reservations')).toMatchObject({ delete: 1 });
    expect(tables.get('register_records')).toMatchObject({ delete: 3 });
    const parts = new Map<string, any>(res.body.parts.map((p: { code: string }) => [p.code, p]));
    expect(parts.get('car_dispatcher')).toMatchObject({ selected: true, added: true, requested: false });
    expect(parts.get('sites')).toMatchObject({ selected: false });
    const ids = await admin1.api.call('get', '/settings/data-reset/plan?parts=users');
    expect(ids.body.accounts_to_deactivate).toBeGreaterThan(0);
    expect(ids.body.delete_rows).toBe(0);
    expect((await admin1.api.call('get', '/settings/data-reset/plan?parts=nonsense')).status).toBe(422);
    expect((await admin1.api.call('get', '/settings/data-reset/plan?parts=sites;drop')).status).toBe(422);
    expect((await plain.api.call('get', '/settings/data-reset/plan?parts=users')).status).toBe(403);
  });

  it('refuses an empty list and an unknown part', async () => {
    const empty = await post(admin1, '/requests', { reason: 'A scoped synthetic request', confirm_text: phrase, parts: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.errors[0]).toMatchObject({ path: '/parts', code: 'required' });
    const unknown = await post(admin1, '/requests', { reason: 'A scoped synthetic request', confirm_text: phrase, parts: ['audit_log'] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ path: '/parts', code: 'unknown_part' });
    expect(await q(db, `SELECT 1 FROM data_reset_requests WHERE status = 'requested'`)).toHaveLength(0);
  });

  it('stores the closure the database computed (the client cannot skip a dependent) and its hash', async () => {
    const res = await post(admin1, '/requests', { reason: 'A scoped synthetic request', confirm_text: phrase, parts: ['procurement'] });
    expect(res.status).toBe(201);
    id = res.body.id;
    hash = res.body.scope_hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.scope).toMatchObject({ parts: ['car_dispatcher', 'financial_advances', 'invoices', 'procurement'], added: ['car_dispatcher', 'financial_advances', 'invoices'] });
    expect(res.body.plan_at_request.parts).toMatchObject({ procurement: expect.any(Number), car_dispatcher: expect.any(Number) });
    const row = await q<{ requested_parts: string[]; scope_hash: string }>(db, 'SELECT requested_parts, scope_hash FROM data_reset_requests WHERE id = $1', [id]);
    expect(row[0]).toMatchObject({ requested_parts: ['procurement'], scope_hash: hash });
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_request' AND entity_id = $1 AND after -> 'scope' ->> 'hash' = $2`, [id, hash])).toHaveLength(1);
  });

  it('refuses an approval of another scope (409 scope_changed); the approval binds to the hash', async () => {
    const r = await admin2.api.call('get', `/settings/data-reset/requests/${id}`);
    const other = await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it', scope_hash: 'a'.repeat(64) }, etag(r));
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('scope_changed');
    expect((await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it', scope_hash: 'XYZ' }, etag(r))).status).toBe(422);
    const ok = await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it', scope_hash: hash }, etag(r));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', approved_scope_hash: hash, scope_hash: hash });
    // the scope and the approved hash never change, not even for the superuser
    await expect(db.query(`UPDATE data_reset_requests SET requested_parts = ARRAY['users'] WHERE id = $1`, [id])).rejects.toThrow(/never changes/);
    await expect(db.query(`UPDATE data_reset_requests SET approved_scope_hash = $2 WHERE id = $1`, [id, 'b'.repeat(64)])).rejects.toThrow(/never changes|data_reset_scope_bound/);
    const c = await post(admin1, `/requests/${id}/cancel`, { reason: 'Scope test only' }, etag(ok));
    expect(c.status).toBe(200);
  });

  it('narrowing (migration 0370): the dry run counts only the matching records, the filter is bound into the scope hash, and parts that cannot follow one record refuse it', async () => {
    const count = async (q2: string) => {
      const r = await admin1.api.call('get', `/settings/data-reset/plan?${q2}`);
      expect(r.status).toBe(200);
      return r;
    };
    const whole = await count('parts=procurement');
    const tripoli = await count('parts=procurement&regions=1');
    const nowhere = await count('parts=procurement&from=2100-01-01&to=2100-12-31');
    const unknownRegion = await admin1.api.call('get', '/settings/data-reset/plan?parts=procurement&regions=999');
    expect(unknownRegion.status).toBe(422);
    expect(unknownRegion.body.code).toBe('validation_failed');
    const rows = (r: { body: { plan?: unknown; tables?: { table: string; delete: number }[] } }, t: string) =>
      (r.body.tables ?? []).find((x) => x.table === t)?.delete ?? 0;
    expect(rows(whole, 'procurement_records')).toBe(1);
    expect(rows(tripoli, 'procurement_records')).toBe(1);
    expect(rows(nowhere, 'procurement_records')).toBe(0);
    expect(rows(nowhere, 'register_records')).toBe(0);
    expect(tripoli.body.scope.narrow).toMatchObject({ regions: [1] });
    expect(tripoli.body.scope.hash).not.toBe(whole.body.scope.hash);
    expect((await count('parts=procurement&from=2000-01-01&to=2100-01-01')).body.tables.find((x: { table: string }) => x.table === 'procurement_records').delete).toBe(1);
    const sitesNarrow = await admin1.api.call('get', '/settings/data-reset/plan?parts=sites&regions=1');
    expect(sitesNarrow.status).toBeGreaterThanOrEqual(400);
    expect(sitesNarrow.status).toBeLessThan(500);
    const opts = await admin1.api.call('get', '/settings/data-reset/narrow-options?part=procurement');
    expect(opts.status).toBe(200);
    expect(opts.body.regions.length).toBeGreaterThan(0);
    expect((await plain.api.call('get', '/settings/data-reset/narrow-options')).status).toBe(403);
    // the request stores the filter in its scope, bound into the hash the approver approves
    const r = await post(admin1, '/requests', { reason: 'Narrow scope synthetic test', confirm_text: phrase, parts: ['procurement'], narrow: { regions: [1] } });
    expect(r.status).toBe(201);
    expect(r.body.scope.narrow).toMatchObject({ regions: [1] });
    expect(r.body.scope_hash).toBe(tripoli.body.scope.hash);
    await expect(db.query(`UPDATE data_reset_requests SET scope = jsonb_set(scope, '{narrow}', '{"regions":[2]}') WHERE id = $1`, [r.body.id])).rejects.toThrow();
    const c = await post(admin1, `/requests/${r.body.id}/cancel`, { reason: 'Narrow scope test only' }, etag(r));
    expect(c.status).toBe(200);
  });

  it('archive before delete (migration 0371): the run is refused until the archive is made and (mode download) downloaded once; the download is System Admin only and logged', async () => {
    await backupRow();
    const r = await post(admin1, '/requests', { reason: 'Archive synthetic test', confirm_text: phrase, parts: ['procurement'], archive: 'download' });
    expect(r.status).toBe(201);
    expect(r.body.archive).toMatchObject({ mode: 'download', archive: null });
    const id = r.body.id as string;
    // the archive is made while the request is approved, not before
    expect((await post(admin1, `/requests/${id}/archive`, {})).status).toBe(409);
    const ap = await post(admin2, `/requests/${id}/approve`, { reason: 'Archive synthetic approval', scope_hash: r.body.scope_hash }, etag(r));
    expect(ap.status).toBe(200);
    const run1 = await post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, etag(ap));
    expect(run1.status).toBe(409);
    expect(run1.body.code).toBe('archive_required');
    expect((await post(plain, `/requests/${id}/archive`, {})).status).toBe(403);
    const made = await post(admin1, `/requests/${id}/archive`, {});
    expect(made.status).toBe(202);
    const { DataResetArchiveService } = await import('../src/settings/data-reset-archive.service');
    for (let i = 0; i < 400 && app.get(DataResetArchiveService).running.size > 0; i++) await Promise.all([...app.get(DataResetArchiveService).running]);
    const got = await admin1.api.call('get', `/settings/data-reset/requests/${id}`);
    expect(got.body.archive.archive).toMatchObject({ status: 'ready', downloads: 0 });
    expect(got.body.archive.archive.bytes).toBeGreaterThan(0);
    expect(got.body.archive.archive.entries.records).toBeGreaterThan(0);
    // mode download: still refused before the first download
    const run2 = await post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, etag(got));
    expect(run2.status).toBe(409);
    expect(run2.body.code).toBe('archive_required');
    expect((await plain.api.call('get', `/settings/data-reset/requests/${id}/archive/download`)).status).toBe(403);
    expect((await adminNoStep.api.call('get', `/settings/data-reset/requests/${id}/archive/download`)).status).toBe(401);
    const dl = await admin1.api.call('get', `/settings/data-reset/requests/${id}/archive/download`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-type'])).toContain('application/zip');
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_archive_download' AND actor_id = $1`, [admin1.user.id])).toHaveLength(1);
    expect((await q<{ downloads: number }>(db, `SELECT downloads FROM data_reset_archives WHERE request_id = $1`, [id]))[0]!.downloads).toBe(1);
    // the mode never changes with the request
    await expect(db.query(`UPDATE data_reset_requests SET archive_mode = 'none' WHERE id = $1`, [id])).rejects.toThrow();
    const last = await admin1.api.call('get', `/settings/data-reset/requests/${id}`);
    const c = await post(admin1, `/requests/${id}/cancel`, { reason: 'Archive test only' }, etag(last));
    expect(c.status).toBe(200);
  });
});

describe('the guarded settings', () => {
  it('validates, needs If-Match, and changes the expiry and the backup window (audited)', async () => {
    const st = await admin1.api.call('get', '/settings/data-reset');
    const v = String(st.body.settings.version);
    expect((await admin1.api.call('put', '/settings/data-reset/settings', { reason: 'Tune', request_expiry_minutes: 30, backup_max_age_hours: 24 })).status).toBe(428);
    const bad = await admin1.api.call('put', '/settings/data-reset/settings', { reason: 'Tune', request_expiry_minutes: 1, backup_max_age_hours: 100, colour: 1 }, { 'If-Match': v });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { path: string; code: string }) => `${e.path}:${e.code}`).sort())
      .toEqual(['/backup_max_age_hours:out_of_range', '/colour:unknown_key', '/request_expiry_minutes:out_of_range']);
    const ok = await admin1.api.call('put', '/settings/data-reset/settings', { reason: 'Owner: one hour', request_expiry_minutes: 60, backup_max_age_hours: 24 }, { 'If-Match': v });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ request_expiry_minutes: 60, backup_max_age_hours: 24 });
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_settings_update' AND actor_id = $1 AND reason = 'Owner: one hour'`, [admin1.user.id])).toHaveLength(1);
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DRST });
    await c.connect();
    try {
      // without a context row security hides the row; with one, the guard of the key refuses (tests/db-security E10): never a change
      const r = await c.query(`UPDATE settings SET value = '{"request_expiry_minutes": 240, "backup_max_age_hours": 72, "version": 9}' WHERE key = 'data_reset.settings'`)
        .then((x) => x.rowCount, (e: { code?: string }) => e.code);
      expect([0, '42501']).toContain(r);
      expect((await q<{ v: any }>(db, `SELECT value AS v FROM settings WHERE key = 'data_reset.settings'`))[0]!.v).toMatchObject({ request_expiry_minutes: 60 });
    } finally {
      await c.end();
    }
  });
});

const putSettings = async (body: Record<string, unknown>) => {
  const st = await admin1.api.call('get', '/settings/data-reset');
  return admin1.api.call('put', '/settings/data-reset/settings', { reason: 'Waiting period test', request_expiry_minutes: 60, backup_max_age_hours: 24, ...body }, { 'If-Match': String(st.body.settings.version) });
};

describe('the waiting period after the approval (migration 0372, contract 0.15.268)', () => {
  it('the setting is validated, optional in the body (omitted keeps the value) and defaults to 24 hours', async () => {
    const bad = await putSettings({ cooloff_minutes: 43201 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { path: string; code: string }) => `${e.path}:${e.code}`)).toEqual(['/cooloff_minutes:out_of_range']);
    expect((await putSettings({ cooloff_minutes: 1.5 })).status).toBe(422);
    const ok = await putSettings({ cooloff_minutes: 60 });
    expect(ok.status).toBe(200);
    expect(ok.body.cooloff_minutes).toBe(60);
    expect((await putSettings({})).body.cooloff_minutes).toBe(60);
    expect((await putSettings({ cooloff_minutes: 0 })).body.cooloff_minutes).toBe(0);
  });

  it('a request inherits the wait; the approval sets run_after and both admins are told; the run is 409 cooloff_active until then; the notice before the run is sent once', async () => {
    await backupRow();
    expect((await putSettings({ cooloff_minutes: 60 })).status).toBe(200);
    const r = await post(admin1, '/requests', { reason: 'Waiting period synthetic test', confirm_text: phrase, parts: ['procurement'], archive: 'none' });
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    expect(r.body.cooloff).toMatchObject({ minutes: 60, run_after: null, active: false });
    // the setting changes later, the request keeps its value (and the settings door refuses while a request is open)
    expect((await putSettings({ cooloff_minutes: 5 })).status).toBe(409);
    const ap = await post(admin2, `/requests/${id}/approve`, { reason: 'Waiting period synthetic approval', scope_hash: r.body.scope_hash }, etag(r));
    expect(ap.status).toBe(200);
    expect(ap.body.cooloff).toMatchObject({ minutes: 60, active: true });
    expect(new Date(ap.body.cooloff.run_after).getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    // the request stays open for the usual expiry counted from run_after
    expect(new Date(ap.body.expires_at).getTime()).toBeGreaterThan(new Date(ap.body.cooloff.run_after).getTime());
    const told = await q<{ user_id: string }>(db, `SELECT user_id FROM notifications WHERE kind = 'data_reset_request' AND title LIKE '%waiting before it can run%' AND created_at > now() - interval '1 minute'`);
    expect(told.map((t) => t.user_id).sort()).toEqual([admin1.user.id, admin2.user.id].sort());
    const run = await post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, etag(ap));
    expect(run.status).toBe(409);
    expect(run.body.code).toBe('cooloff_active');
    // the wait and the moment never change with the request
    await expect(db.query(`UPDATE data_reset_requests SET cooloff_minutes = 0 WHERE id = $1`, [id])).rejects.toThrow();
    await expect(db.query(`UPDATE data_reset_requests SET run_after = now() WHERE id = $1`, [id])).rejects.toThrow();
    // not yet near the end: no notice; near the end (the guard is bypassed for the test only): both admins once
    expect(await svc().notifyCooloff()).toBe(0);
    await db.query(`SET session_replication_role = replica`);
    await db.query(`UPDATE data_reset_requests SET run_after = now() + interval '10 minutes' WHERE id = $1`, [id]);
    await db.query(`RESET session_replication_role`);
    expect(await svc().notifyCooloff()).toBe(1);
    expect(await svc().notifyCooloff()).toBe(0);
    const soon = await q<{ user_id: string }>(db, `SELECT user_id FROM notifications WHERE kind = 'data_reset_request' AND title LIKE '%can run soon%' AND created_at > now() - interval '1 minute'`);
    expect(soon.map((t) => t.user_id).sort()).toEqual([admin1.user.id, admin2.user.id].sort());
    // either admin cancels while it waits
    const last = await admin2.api.call('get', `/settings/data-reset/requests/${id}`);
    expect(last.body.cooloff.active).toBe(true);
    const c = await post(admin2, `/requests/${id}/cancel`, { reason: 'Waiting period test only' }, etag(last));
    expect(c.status).toBe(200);
    expect((await putSettings({ cooloff_minutes: 0 })).status).toBe(200);
  });
});

describe('maintenance mode', () => {
  it('answers 503 maintenance on every route but the progress reads while a run is open in this process', async () => {
    const m = app.get(MaintenanceService);
    m.begin();
    try {
      const r = await plain.api.call('get', '/sites');
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('maintenance');
      expect(r.headers['retry-after']).toBe('30');
      expect((await admin1.api.call('get', '/settings/data-reset')).status).toBe(200);
      expect((await admin1.api.call('get', '/auth/session')).status).toBe(200);
      expect((await post(admin1, '/requests', { reason: 'During maintenance', confirm_text: phrase })).status).toBe(503);
    } finally {
      m.end();
    }
    expect((await plain.api.call('get', '/auth/session')).status).toBe(200);
  });
});

describe('the run', () => {
  let id = '';
  let tag = '';

  it('approval by a second System Admin (If-Match required and checked)', async () => {
    const res = await post(admin1, '/requests', { reason: 'Owner decision: start the real data load', confirm_text: phrase });
    expect(res.status).toBe(201);
    id = res.body.id;
    expect((await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it' })).status).toBe(428);
    expect((await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it' }, '*')).status).toBe(428);
    expect((await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it' }, '"999"')).status).toBe(412);
    const ok = await post(admin2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it' }, etag(res));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', approved_by: { id: admin2.user.id } });
    tag = etag(ok);
  });

  it('only the requester or the approver starts it, with the phrase again', async () => {
    const third = await post(admin3, `/requests/${id}/run`, { confirm_text: phrase }, tag);
    expect(third.status).toBe(403);
    const bad = await post(admin1, `/requests/${id}/run`, { confirm_text: 'RESET' }, tag);
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('confirmation_mismatch');
  });

  it('is refused without a successful backup in the window (an older one does not count); nothing is left in the store', async () => {
    const none = await post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, tag);
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('backup_missing');
    await backupRow(25);
    const old = await post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, tag);
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('backup_missing');
    expect(readdirSync(store).filter((n) => n.startsWith('.pre-reset-'))).toEqual([]);
    await backupRow(0);
    const st = await admin1.api.call('get', '/settings/data-reset');
    expect(st.body.backup).toMatchObject({ ok: true, last_success: { type: 'full', repository: '1' } });
    expect(st.body.can).toMatchObject({ start: true, approve: false });
  });

  it('is refused while the operator script holds the reset lock', async () => {
    const c = new PgClient({ connectionString: process.env.TEST_SUPER_URL_DRST });
    await c.connect();
    try {
      await c.query('SELECT pg_advisory_lock(353383097684)');
      const res = await post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, tag);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('reset_running');
    } finally {
      await c.end();
    }
  });

  it('a run that fails rolls back completely: status failed with the error, nothing changed, the API answers again', async () => {
    // a kept Contractors record that points at a project site: the delete of the sites fails on its foreign key (as in the operator script's test)
    await db.query(`SET session_replication_role = replica;
      INSERT INTO register_records (id, entity_id, register_key, record_type, site_id, region_id, state, is_current)
      VALUES ('a0000000-0000-4000-8000-0000000000fe', gen_random_uuid(), 'contractors', 'team', 'a0000000-0000-4000-8000-000000000031', 1, 'entry', true);
      SET session_replication_role = origin;`);
    const res = await post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, tag);
    expect(res.status).toBe(202);
    await settle();
    const got = await admin1.api.call('get', `/settings/data-reset/requests/${id}`);
    expect(got.body.status).toBe('failed');
    expect(got.body.error).toMatch(/foreign key/);
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) n FROM sites'))[0]!.n)).toBe(2);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'project_data_reset'`)).toHaveLength(0);
    expect((await admin2.api.call('get', '/auth/session')).status).toBe(200);
    expect((await plain.api.call('get', '/auth/session')).status).toBe(200);
    expect(readdirSync(store).filter((n) => n.startsWith('.pre-reset-'))).toEqual([]); // the empty quarantine of the failed run is removed
    await db.query(`SET session_replication_role = replica; DELETE FROM register_records WHERE id = 'a0000000-0000-4000-8000-0000000000fe'; SET session_replication_role = origin;`);
    // a new request and approval for the real run
    const n = await post(admin1, '/requests', { reason: 'Owner decision: start the real data load', confirm_text: phrase });
    expect(n.status).toBe(201);
    const ok = await post(admin2, `/requests/${n.body.id}/approve`, { reason: 'Second admin agrees with it' }, etag(n));
    expect(ok.status).toBe(200);
    id = n.body.id;
    tag = etag(ok);
  });

  it('two starts at once: exactly one runs; a file move that fails leaves the request files_pending (the database part is committed)', async () => {
    failMove.once = true;
    const [a, b] = await Promise.all([post(admin1, `/requests/${id}/run`, { confirm_text: phrase }, tag), post(admin2, `/requests/${id}/run`, { confirm_text: phrase }, tag)]);
    const codes = [a.status, b.status].sort();
    expect(codes[0]).toBe(202);
    expect([409, 412]).toContain(codes[1]);
    const won = a.status === 202 ? a : b;
    expect(won.body).toMatchObject({ status: 'running' });
    expect(won.body.quarantine_dir).toMatch(/\/\.pre-reset-\d{8}-\d{6}(-\d+)?$/); // the code adds -2, -3 when a quarantine of the same second exists (data-reset-files.ts)
    await settle();
    const runner = won === a ? admin1 : admin2;
    const got = await runner.api.call('get', `/settings/data-reset/requests/${id}`);
    expect(got.body).toMatchObject({ status: 'files_pending', files: { total: 4, pending: 4, moved: 0 } });
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) n FROM sites'))[0]!.n)).toBe(0);
    const st = await runner.api.call('get', '/settings/data-reset');
    expect(st.body.can).toMatchObject({ retry_files: true, request: false });
    // the retry moves the files only: a step-up and a reason, audited; the database part never runs again
    expect((await post(runner, `/requests/${id}/retry-files`, { reason: 'x' })).status).toBe(422);
    const retry = await post(runner, `/requests/${id}/retry-files`, { reason: 'The store is back' });
    expect(retry.status).toBe(202);
    await settle();
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_files_retry' AND entity_id = $1`, [id])).toHaveLength(1);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'project_data_reset'`)).toHaveLength(1);
  });

  it('after the run: project tables empty, users, configuration and logs kept, chains verify, files quarantined, the runner still signed in', async () => {
    const runBy = (await q<{ run_by: string }>(db, 'SELECT run_by FROM data_reset_requests WHERE id = $1', [id]))[0]!.run_by;
    const runner = runBy === admin1.user.id ? admin1 : admin2;
    const other = runner === admin1 ? admin2 : admin1;
    const res = await runner.api.call('get', `/settings/data-reset/requests/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'completed', files: { total: 4, moved: 3, refused: 1, missing: 0, pending: 0 } });
    expect(res.body.result.sessions_ended).toBeGreaterThan(0);
    expect(res.body.files.problems).toEqual([{ storage_key: 'imports/2026/11/project-master-file', outcome: 'refused', detail: expect.stringContaining('symbolic link') }]);
    // project data gone, kept rows kept
    const counts = await q<{ t: string; n: string }>(db, `SELECT 'sites' t, count(*) n FROM sites UNION ALL SELECT 'task_instances', count(*) FROM task_instances
      UNION ALL SELECT 'notifications', count(*) FROM notifications UNION ALL SELECT 'document_files', count(*) FROM document_files
      UNION ALL SELECT 'register_records', count(*) FROM register_records UNION ALL SELECT 'snag_photos', count(*) FROM snag_photos`);
    expect(Object.fromEntries(counts.map((c) => [c.t, Number(c.n)]))).toEqual({ sites: 0, task_instances: 0, notifications: 0, document_files: 1, register_records: 2, snag_photos: 0 });
    const plan = await runner.api.call('get', '/settings/data-reset');
    expect(plan.body.plan.delete_rows).toBe(0);
    expect(await q(db, `SELECT 1 FROM users WHERE id = ANY($1::uuid[])`, [[admin1.user.id, admin2.user.id, admin3.user.id, plain.user.id]])).toHaveLength(4);
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) n FROM task_definitions'))[0]!.n)).toBeGreaterThan(0);
    expect(await q(db, `SELECT 1 FROM settings WHERE key = 'data_reset.settings'`)).toHaveLength(1);
    // one audit row of the reset, by the runner, with the two admins; both chains verify
    const audit = await q<{ actor_id: string; after: any }>(db, `SELECT actor_id, after FROM audit_log WHERE action = 'project_data_reset'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: runner.user.id, after: { via: 'settings', request_id: id, requested_by: admin1.user.id, approved_by: admin2.user.id, deleted: { sites: 2 },
      scope: { everything: true, identity: [] } } });
    for (const log of ['audit', 'security']) {
      const start = await runner.api.call('post', '/admin/log-integrity/runs', { log });
      expect(start.status).toBe(202);
      await app.get(IntegrityService).idle();
      expect((await runner.api.call('get', `/admin/log-integrity/runs/${start.body.id}`)).body).toMatchObject({ status: 'ok', break_count: 0 });
    }
    // sessions: the runner's kept, every other ended (the other admin is signed out)
    expect((await runner.api.call('get', '/auth/session')).status).toBe(200);
    expect((await other.api.call('get', '/auth/session')).status).toBe(401);
    expect(await q(db, `SELECT 1 FROM user_sessions WHERE revoked_at IS NULL AND user_id <> $1`, [runner.user.id])).toHaveLength(0);
    // files: the three regular project files moved into the quarantine inside the store, the kept company file stays, the link and its target untouched
    const qdir = res.body.quarantine_dir as string;
    expect(qdir.startsWith(`${store}/.pre-reset-`)).toBe(true);
    for (const k of PROJECT_KEYS.filter((x) => !x.startsWith('imports/'))) {
      expect(existsSync(join(qdir, k))).toBe(true);
      expect(existsSync(join(store, k))).toBe(false);
    }
    expect(readFileSync(join(store, KEPT_KEY), 'utf8')).toBe(`synthetic ${KEPT_KEY}`);
    expect(lstatSync(join(store, 'imports/2026/11/project-master-file')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('outside the store');
    expect(readFileSync(`${qdir}.manifest`, 'utf8')).toMatch(/^MOVED docs\/2026\/11\/project-snag-photo$/m);
    // evidence in the security log
    const steps = (await q<{ step: string }>(db, `SELECT detail ->> 'step' AS step FROM security_log WHERE event = 'project_data_reset' AND detail ->> 'request_id' = $1 ORDER BY id`, [id]))
      .map((x) => x.step);
    expect(steps).toEqual(['request', 'approve', 'start', 'completed', 'files']);
  });

  it('never runs the database part twice; the file move cannot be retried once completed', async () => {
    const runBy = (await q<{ run_by: string }>(db, 'SELECT run_by FROM data_reset_requests WHERE id = $1', [id]))[0]!.run_by;
    const runner = runBy === admin1.user.id ? admin1 : admin2;
    const r = await runner.api.call('get', `/settings/data-reset/requests/${id}`);
    const again = await post(runner, `/requests/${id}/run`, { confirm_text: phrase }, etag(r));
    expect(again.status).toBe(409);
    expect((await post(runner, `/requests/${id}/retry-files`, { reason: 'Try the files again' })).status).toBe(409);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'project_data_reset'`)).toHaveLength(1);
  });
});


describe('a scoped run of the identity parts (0.15.71)', () => {
  it('deactivates every account but the System Admins, removes assignments, delegations and groups, empties the staff registry; admins keep their rights', async () => {
    // the full run ended every session but the runner's: both admins sign in again
    const a1 = await loggedIn(app, admin1.user);
    expect((await a1.stepUp(admin1.user.password)).status).toBe(200);
    const a2 = await loggedIn(app, admin2.user);
    expect((await a2.stepUp(admin2.user.password)).status).toBe(200);
    const g = await q<{ id: string }>(db, `INSERT INTO groups (name) VALUES ('Synthetic reviewers') RETURNING id`);
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [g[0]!.id, plain.user.id]);
    const res = await a1.call('post', '/settings/data-reset/requests', { reason: 'Owner decision: a fresh team on the new project', confirm_text: phrase, parts: ['users', 'roles', 'staff'] });
    expect(res.status).toBe(201);
    expect(res.body.scope).toMatchObject({ parts: ['roles', 'staff', 'users'], identity: ['roles', 'staff', 'users'], everything: false });
    expect(res.body.plan_at_request.accounts_to_deactivate).toBeGreaterThanOrEqual(2);
    const ok = await a2.call('post', `/settings/data-reset/requests/${res.body.id}/approve`, { reason: 'Second admin agrees with it', scope_hash: res.body.scope_hash },
      { 'If-Match': etag(res) });
    expect(ok.status).toBe(200);
    await backupRow(0);
    const run = await a1.call('post', `/settings/data-reset/requests/${res.body.id}/run`, { confirm_text: phrase }, { 'If-Match': etag(ok) });
    expect(run.status).toBe(202);
    await settle();
    const got = await a1.call('get', `/settings/data-reset/requests/${res.body.id}`);
    expect(got.body.status).toBe('completed');
    expect(got.body.result.identity.users.deactivated).toBeGreaterThanOrEqual(2);
    const status = async (u: string) => (await q<{ status: string }>(db, 'SELECT status FROM users WHERE id = $1', [u]))[0]!.status;
    for (const u of [plain.user.id, deleg.user.id]) expect(await status(u)).toBe('disabled');
    for (const u of [admin1.user.id, admin2.user.id, admin3.user.id, adminNoStep.user.id]) {
      expect(await status(u)).toBe('active');
      expect((await q<{ a: boolean }>(db, 'SELECT app_user_is_system_admin($1) AS a', [u]))[0]!.a).toBe(true);
    }
    expect(await q(db, 'SELECT 1 FROM user_role_assignments')).toHaveLength(0);
    expect(await q(db, 'SELECT 1 FROM delegations')).toHaveLength(0);
    expect(await q(db, 'SELECT 1 FROM groups WHERE id = $1', [g[0]!.id])).toHaveLength(0);
    expect(await q(db, 'SELECT 1 FROM staff_registry')).toHaveLength(0);
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) n FROM roles'))[0]!.n)).toBeGreaterThan(0);
    // the deactivated accounts are signed out; the runner works on
    expect((await plain.api.call('get', '/auth/session')).status).toBe(401);
    const st = await a1.call('get', '/settings/data-reset');
    expect(st.status).toBe(200);
    expect(st.body.plan.accounts_to_deactivate).toBe(0);
    const audit = await q<{ after: any }>(db, `SELECT after FROM audit_log WHERE action = 'project_data_reset' ORDER BY id DESC LIMIT 1`);
    expect(audit[0]!.after).toMatchObject({ scope: { parts: ['roles', 'staff', 'users'] }, identity: { users: { deactivated: expect.any(Number) } } });
    expect(audit[0]!.after.identity.users.accounts.map((x: { id: string }) => x.id)).not.toContain(admin1.user.id);
  });
});

describe('the backup choice of a request (0.15.72)', () => {
  let a1: Api;
  let a2: Api;
  const reqBody = (extra: Record<string, unknown> = {}) => ({ reason: 'Owner decision: clean the test data, no backup', confirm_text: phrase, parts: ['issues'], ...extra });
  const call = (who: Api, path: string, body: unknown, ifMatch?: string) =>
    who.call('post', `/settings/data-reset${path}`, body, ifMatch === undefined ? {} : { 'If-Match': ifMatch });

  beforeAll(async () => {
    // the run of the block before finishes in the background (the database part, then the file move): a new request is refused with 409
    // while that request is still open, so wait until none is (at most 60 s)
    for (let i = 0; i < 240; i++) {
      if ((await q(db, `SELECT 1 FROM data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending')`)).length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await q(db, `SELECT status FROM data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending')`)).toEqual([]);
    // the earlier runs ended every session but their runner's: both admins sign in again
    a1 = await loggedIn(app, admin1.user);
    expect((await a1.stepUp(admin1.user.password)).status).toBe(200);
    a2 = await loggedIn(app, admin2.user);
    expect((await a2.stepUp(admin2.user.password)).status).toBe(200);
    // no backup within the window any more (the System Log is append-only: the rows are aged with the triggers off, test only)
    await db.query(`SET session_replication_role = replica; UPDATE system_log SET at = at - interval '200 hours' WHERE source = 'backup';
      SET session_replication_role = origin;`);
    expect((await a1.call('get', '/settings/data-reset')).body).toMatchObject({ backup: { ok: false }, no_backup_phrase: 'NO BACKUP' });
  });

  it('a default request (no field) still requires a backup: approved, its run is refused with backup_missing', async () => {
    const res = await call(a1, '/requests', { reason: 'Owner decision: clean the test data', confirm_text: phrase, parts: ['issues'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ require_backup: true });
    const dry = await a1.call('get', '/settings/data-reset/plan?parts=issues');
    expect(res.body.scope_hash).toBe(dry.body.scope.hash);                 // a backup required: the hash of 0.15.71, unchanged
    const ok = await call(a2, `/requests/${res.body.id}/approve`, { reason: 'Second admin agrees with it', scope_hash: res.body.scope_hash }, etag(res));
    expect(ok.status).toBe(200);
    const run = await call(a1, `/requests/${res.body.id}/run`, { confirm_text: phrase }, etag(ok));
    expect(run.status).toBe(409);
    expect(run.body.code).toBe('backup_missing');
    expect(run.body.detail).toMatch(/without the backup requirement/);
    // a client cannot switch the check off at the run
    expect((await call(a1, `/requests/${res.body.id}/run`, { confirm_text: phrase, require_backup: false }, etag(ok))).status).toBe(422);
    expect((await call(a1, `/requests/${res.body.id}/cancel`, { reason: 'Backup test only' }, etag(ok))).status).toBe(200);
  });

  it('"without a backup" needs the typed phrase NO BACKUP and a boolean', async () => {
    const none = await call(a1, '/requests', reqBody({ require_backup: false }));
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'confirmation_mismatch' });
    expect(none.body.errors[0]).toMatchObject({ path: '/no_backup_confirm' });
    const wrong = await call(a1, '/requests', reqBody({ require_backup: false, no_backup_confirm: 'no backup' }));
    expect(wrong.status).toBe(422);
    expect((await call(a1, '/requests', reqBody({ require_backup: 'no' }))).status).toBe(422);
    expect(await q(db, `SELECT 1 FROM data_reset_requests WHERE status = 'requested'`)).toHaveLength(0);
  });

  it('the choice is bound into the approval and never changes; the run without a backup completes with no backup row', async () => {
    const res = await call(a1, '/requests', reqBody({ require_backup: false, no_backup_confirm: 'NO BACKUP' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ require_backup: false, scope: { parts: ['issues'] } });
    const id = res.body.id as string;
    const dry = await a1.call('get', '/settings/data-reset/plan?parts=issues');
    expect(res.body.scope_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.scope_hash).not.toBe(dry.body.scope.hash);              // the hash binds the choice too
    expect(res.body.scope.hash).toBe(dry.body.scope.hash);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_request' AND entity_id = $1 AND (after ->> 'require_backup')::boolean = false`, [id])).toHaveLength(1);
    expect(await q(db, `SELECT 1 FROM notifications WHERE kind = 'data_reset_request' AND user_id = $1 AND body LIKE '%WITHOUT a backup%'`, [admin2.user.id])).toHaveLength(1);
    // the choice never changes, not even for the superuser
    await expect(db.query('UPDATE data_reset_requests SET require_backup = true WHERE id = $1', [id])).rejects.toThrow(/never changes/);
    // an approval of the scope with a backup (the hash of the other choice) is refused
    const other = await call(a2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it', scope_hash: dry.body.scope.hash }, etag(res));
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('scope_changed');
    const ok = await call(a2, `/requests/${id}/approve`, { reason: 'Second admin agrees with it', scope_hash: res.body.scope_hash }, etag(res));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', require_backup: false, approved_scope_hash: res.body.scope_hash });
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_approve' AND entity_id = $1 AND (after ->> 'require_backup')::boolean = false`, [id])).toHaveLength(1);
    // every other check stays: the phrase, the runner
    expect((await call(a1, `/requests/${id}/run`, { confirm_text: 'RESET' }, etag(ok))).status).toBe(422);
    const third = await loggedIn(app, { ...admin3.user, email: 'reset.admin@example.test' }); // the e-mail of the seed's admin (beforeAll)
    expect((await third.stepUp(admin3.user.password)).status).toBe(200);
    expect((await call(third, `/requests/${id}/run`, { confirm_text: phrase }, etag(ok))).status).toBe(403);
    expect((await a1.call('get', '/settings/data-reset')).body.backup.ok).toBe(false);
    const run = await call(a1, `/requests/${id}/run`, { confirm_text: phrase }, etag(ok));
    expect(run.status).toBe(202);
    expect(run.body).toMatchObject({ status: 'running', require_backup: false, backup: null });
    await settle();
    const got = await a1.call('get', `/settings/data-reset/requests/${id}`);
    expect(got.body).toMatchObject({ status: 'completed', require_backup: false, backup: null, result: { require_backup: false } });
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'data_reset_start' AND entity_id = $1 AND (after ->> 'require_backup')::boolean = false
      AND (after ->> 'backup_ok')::boolean = false`, [id])).toHaveLength(1);
    const audit = await q<{ after: any }>(db, `SELECT after FROM audit_log WHERE action = 'project_data_reset' ORDER BY id DESC LIMIT 1`);
    expect(audit[0]!.after).toMatchObject({ via: 'settings', request_id: id, require_backup: false, backup: null });
    expect(await q(db, `SELECT 1 FROM security_log WHERE event = 'project_data_reset' AND detail ->> 'step' = 'completed' AND detail ->> 'request_id' = $1
      AND (detail ->> 'require_backup')::boolean = false`, [id])).toHaveLength(1);
  });
});

describe('one System Admin', () => {
  it('refuses the request (409 single_admin): the operator script is the way', async () => {
    const solo = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_SOLO as string });
    try {
      const api = new Api(solo);
      expect((await api.login(BOOTSTRAP_ADMIN.email, BOOTSTRAP_ADMIN.password)).status).toBe(200);
      expect((await api.stepUp(BOOTSTRAP_ADMIN.password)).status).toBe(200);
      const st = await api.call('get', '/settings/data-reset');
      expect(st.status).toBe(200);
      expect(st.body).toMatchObject({ single_admin: true, system_admins_active: 1, can: { request: false } });
      const res = await api.call('post', '/settings/data-reset/requests', { reason: 'Only one admin is here', confirm_text: st.body.confirmation_phrase });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('single_admin');
    } finally {
      await solo.close();
    }
  });
});

describe('the quarantine move (no database)', () => {
  it('moves regular files only, refuses links, "..", absolute and odd keys, counts a key already in the quarantine as moved', async () => {
    const r = mkdtempSync(join(tmpdir(), 'pmis-drst-q-'));
    try {
      const s = join(r, 'files');
      mkdirSync(join(s, 'docs', 'a'), { recursive: true });
      mkdirSync(join(r, 'out'));
      writeFileSync(join(s, 'docs', 'a', 'good'), 'g');
      writeFileSync(join(r, 'out', 'x'), 'x');
      symlinkSync(join(r, 'out'), join(s, 'docs', 'evil'));
      const qd = join(s, '.pre-reset-20261124-000000');
      mkdirSync(join(qd, 'docs', 'a'), { recursive: true });
      writeFileSync(join(qd, 'docs', 'a', 'done'), 'd');
      const out = await quarantineFiles(s, qd, ['docs/a/good', 'docs/evil/x', 'docs/../out/x', '/etc/hostname', 'docs/a/none', 'docs/a/done', 'Docs/A']);
      expect(out.map((o) => `${o.storage_key}:${o.outcome}`)).toEqual(['docs/a/good:moved', 'docs/evil/x:refused', 'docs/../out/x:refused', '/etc/hostname:refused',
        'docs/a/none:missing', 'docs/a/done:moved', 'Docs/A:refused']);
      expect(readFileSync(join(r, 'out', 'x'), 'utf8')).toBe('x');
      await expect(quarantineFiles(s, join(r, 'out'), ['docs/a/good'])).rejects.toThrow(/not a \.pre-reset-/);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
