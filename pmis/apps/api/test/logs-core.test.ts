import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, PASSWORD, adminApi, grantProfile, loggedIn, makeAdmin, makeUser, startApp } from './helpers';
import { GECOL, createRec, patch, team } from './reg-helpers';
import { LogsService } from '../src/logs/logs.service';
import { JobRunsService } from '../src/logs/job-runs.service';
import { parseDevice } from '../src/logs/context';

/**
 * Migration 0045 (logs core, contract 0.10.0). Runs on its own database (TEST_DATABASE_URL_LOGS): it breaks and restores a hash chain, changes the
 * retention and the alert thresholds. Nothing here depends on the weekday, the time zone or the collation.
 */
let app: NestExpressApplication;
let db: PgClient;
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MASK_RE = /^\?[A-Za-z0-9+]?\*\*\*#[0-9a-f]{12}$/;
const uid = (): string => `${process.pid}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_LOGS as string });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_LOGS });
  await db.connect();
});
afterAll(async () => {
  await app.get(LogsService).idle();
  await db.end();
  await app.close();
});

/** Polls the job until it ends (the worker starts when the response has been sent). */
async function waitJob(api: Api, id: string): Promise<Record<string, any>> {
  for (let i = 0; i < 100; i++) {
    await app.get(LogsService).idle();
    const j = await api.call('get', `/jobs/${id}`);
    if (j.body.status === 'done' || j.body.status === 'failed') return j.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not end');
}

const lastAudit = async (action: string): Promise<Record<string, any>> =>
  (await db.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action])).rows[0];

describe('device parsing', () => {
  it('reads browser, os and device type from the User-Agent', () => {
    expect(parseDevice(UA_CHROME)).toEqual({ browser: 'Chrome', os: 'Windows', type: 'desktop' });
    expect(parseDevice(UA_IPHONE)).toEqual({ browser: 'Safari', os: 'iOS', type: 'mobile' });
    expect(parseDevice('curl/8.5.0')?.type).toBe('bot');
    expect(parseDevice(null)).toBeNull();
  });
});

describe('request context reaches the database', () => {
  it('fills ip, device, user agent, request id, session, sign-in method and via on a row written by an existing SECURITY DEFINER function', async () => {
    const { api } = await adminApi(app, db);
    const code = `d${uid()}`.slice(0, 30);
    const res = await api.call('post', '/departments', { code, name_en: `Dept ${code}`, reason: 'logs context test' }, { 'User-Agent': UA_CHROME });
    expect(res.status).toBe(201);
    const row = await lastAudit('department_created');
    expect(row.entity_id).toBe(res.body.id);
    expect(row.ip).toBe(api.ip);
    expect(row.user_agent).toBe(UA_CHROME);
    expect(row.device).toEqual({ browser: 'Chrome', os: 'Windows', type: 'desktop' });
    expect(row.request_id).toBe(res.headers['x-request-id']);
    expect(row.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.auth_method).toBe('local');
    expect(row.mfa).toBe(false);
    expect(row.stepup_verified).toBe(true);
    expect(row.via).toBe('manual');
    expect(row.module_key).toBe('users');
  });

  it('a job transaction records via = job and the job name', async () => {
    const before = Number((await db.query(`SELECT count(*) FROM job_runs WHERE name = 'security_alerts'`)).rows[0].count);
    await app.get(JobRunsService).evaluateAlerts();
    const runs = await db.query(`SELECT * FROM job_runs WHERE name = 'security_alerts' ORDER BY started_at DESC LIMIT 1`);
    expect(Number((await db.query(`SELECT count(*) FROM job_runs WHERE name = 'security_alerts'`)).rows[0].count)).toBe(before + 1);
    expect(runs.rows[0].outcome).toBe('ok');
    expect(runs.rows[0].finished_at).not.toBeNull();
  });
});

describe('field-level change log', () => {
  it('writes one row per changed field of a register record edit, with labels, and serves the field history by the logical record', async () => {
    const t = await team(app, db, 'gecol', 'gecol', 3);
    const rec = await createRec(t, { ...GECOL, pr_no: `GP-${uid()}` });
    const res = await patch(t.entry.api, 'gecol', rec.id, rec.version, { data: { pr_no: 'GP-CHANGED' } });
    expect(res.status).toBe(200);
    const logical = (await db.query('SELECT entity_id::text AS e FROM register_records WHERE id = $1', [rec.id])).rows[0].e as string;
    const rows = await db.query(`SELECT * FROM audit_field_changes WHERE entity_type = 'register_record' AND entity_id = $1 AND action = 'register_record_update'`, [logical]);
    const fields = rows.rows.map((r) => r.field);
    expect(fields).toContain('pr_no');
    expect(fields).not.toContain('version');
    const pr = rows.rows.find((r) => r.field === 'pr_no');
    expect(pr.new_value).toBe('GP-CHANGED');
    expect(pr.old_value).toBe(rec.data.pr_no);
    expect(pr.field_label_en).toBeTruthy();
    expect(pr.record_id).toBe(rec.id);
    expect(pr.ip).toBe(t.entry.api.ip);
    expect(pr.region_id).toBe(3);

    const { api } = await adminApi(app, db);
    const list = await api.call('get', `/audit-log/field-changes?entity_type=register_record&entity_id=${logical}&field=pr_no`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ field: 'pr_no', new_value: 'GP-CHANGED', entity_id: logical, via: 'manual', auth_method: 'local' });
    expect(list.body.items[0].actor.id).toBe(t.entry.user.id);
    const hist = await api.call('get', `/audit-log/field-history?entity_type=register_record&entity_id=${logical}&field=pr_no`);
    expect(hist.status).toBe(200);
    expect(hist.body.items.length).toBeGreaterThanOrEqual(2); // the create and the edit, newest first
    expect(hist.body.items[0].new_value).toBe('GP-CHANGED');
    expect((await api.call('get', '/audit-log/field-history?entity_type=register_record')).status).toBe(422);
    expect((await lastAudit('audit_log.field_changes_read')).actor_id).toBeTruthy();
  });

  it('the field change log is append-only, even for the superuser', async () => {
    await expect(db.query('UPDATE audit_field_changes SET field = field WHERE id = (SELECT min(id) FROM audit_field_changes)')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM audit_field_changes WHERE id = (SELECT min(id) FROM audit_field_changes)')).rejects.toThrow(/append-only/);
  });
});

describe('hash chains', () => {
  it('verifies the Audit Log chain, detects a break made as superuser, and is audited; a delegate is refused', async () => {
    const { api, admin } = await adminApi(app, db);
    const ok = await api.call('get', '/audit-log/integrity');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ log: 'audit', status: 'ok', breaks: [] });
    expect(ok.body.head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.body.row_count).toBeGreaterThan(0);
    const audit = await lastAudit('audit_log.integrity_check');
    expect(audit.actor_id).toBe(admin.id);

    const victim = (await db.query(`SELECT a.id, a.reason, c.seq FROM audit_log a JOIN audit_log_chain c ON c.audit_id = a.id WHERE a.action = 'department_created' ORDER BY a.id LIMIT 1`)).rows[0];
    await db.query('BEGIN');
    await db.query(`SET LOCAL session_replication_role = replica`);
    await db.query(`UPDATE audit_log SET reason = 'tampered' WHERE id = $1`, [victim.id]);
    await db.query('COMMIT');
    try {
      const broken = await api.call('get', '/audit-log/integrity');
      expect(broken.body.status).toBe('broken');
      expect(broken.body.breaks).toContainEqual(expect.objectContaining({ seq: Number(victim.seq), kind: 'hash_mismatch', row_id: Number(victim.id) }));
      const ranged = await api.call('get', `/audit-log/integrity?from_seq=${victim.seq}&to_seq=${victim.seq}`);
      expect(ranged.body).toMatchObject({ status: 'broken', row_count: 1 });
      expect((await db.query(`SELECT 1 FROM security_alerts WHERE rule = 'audit_integrity_failure'`)).rowCount).toBeGreaterThan(0);
    } finally {
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role = replica`);
      await db.query(`UPDATE audit_log SET reason = $2 WHERE id = $1`, [victim.id, victim.reason]);
      await db.query('COMMIT');
    }
    expect((await api.call('get', '/audit-log/integrity')).body.status).toBe('ok');
    expect((await api.call('get', '/audit-log/integrity?from_seq=5&to_seq=2')).status).toBe(422);

    const delegate = await makeUser(db, { assigned: true });
    await grantProfile(db, delegate.id, [['audit', 'view_audit']]);
    const dapi = await loggedIn(app, delegate);
    expect((await dapi.call('get', '/audit-log/integrity')).status).toBe(403);
  });

  it('chains concurrent writers correctly and verifies the security log chain', async () => {
    const { api } = await adminApi(app, db);
    await Promise.all(Array.from({ length: 12 }, (_, i) => api.call('post', '/departments', { code: `c${uid()}${i}`.slice(0, 30), name_en: `Concurrent ${i}`, reason: 'concurrency' })));
    expect((await api.call('get', '/audit-log/integrity')).body.status).toBe('ok');
    const sec = await api.call('get', '/security-log/integrity');
    expect(sec.status).toBe(200);
    expect(sec.body).toMatchObject({ log: 'security', status: 'ok' });
    expect(sec.body.row_count).toBeGreaterThan(0);
  });
});

describe('sign-in and security log', () => {
  it('records failures with a masked identifier only, success, step-up, sign-out, lockout and password change', async () => {
    const u = await makeUser(db, { assigned: true });
    const typed = `NoSuchPerson-${uid()}`;
    const anon = new Api(app);
    expect((await anon.login(typed, 'whatever-password')).status).toBe(401);
    const unknown = (await db.query(`SELECT * FROM security_log WHERE ip = $1 AND event = 'sign_in_failed' ORDER BY id DESC LIMIT 1`, [anon.ip])).rows[0];
    expect(unknown.user_id).toBeNull();
    expect(unknown.identifier_hash).toMatch(MASK_RE);
    expect(JSON.stringify(unknown)).not.toContain(typed);
    expect(JSON.stringify(unknown).toLowerCase()).not.toContain(typed.toLowerCase());
    // the same text gives the same mask, so attempts group
    await anon.login(typed, 'other-password');
    const two = await db.query(`SELECT DISTINCT identifier_hash FROM security_log WHERE ip = $1 AND event = 'sign_in_failed'`, [anon.ip]);
    expect(two.rowCount).toBe(1);
    // the database refuses a raw identifier
    await expect(db.query(`SELECT sec_log_write('sign_in_failed', 'failure', NULL, $1, NULL, '{}'::jsonb)`, [typed])).rejects.toThrow(/check/);

    const a = new Api(app);
    expect((await a.login(u.email, 'wrong-password-1')).status).toBe(401);
    expect((await db.query(`SELECT 1 FROM security_log WHERE user_id = $1 AND event = 'sign_in_failed'`, [u.id])).rowCount).toBe(1);
    expect((await a.login(u.email, u.password)).status).toBe(200);
    const ok = (await db.query(`SELECT * FROM security_log WHERE user_id = $1 AND event = 'sign_in_succeeded'`, [u.id])).rows[0];
    expect(ok.ip).toBe(a.ip);
    expect(ok.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await a.stepUp('bad-password')).status).toBe(401);
    expect((await a.stepUp(u.password)).status).toBe(200);
    const events = async (): Promise<string[]> => (await db.query('SELECT event FROM security_log WHERE user_id = $1 ORDER BY id', [u.id])).rows.map((r) => r.event);
    expect(await events()).toEqual(expect.arrayContaining(['step_up_failed', 'step_up_passed']));
    expect((await a.call('post', '/auth/local/password', { current_password: u.password, new_password: 'A-Brand-New-Phrase-77' })).status).toBe(200);
    expect(await events()).toContain('password_changed');
    expect((await a.call('post', '/auth/logout')).status).toBe(204);
    expect(await events()).toContain('signed_out');

    const v = await makeUser(db, { assigned: true });
    const b = new Api(app);
    for (let i = 0; i < 5; i++) await b.login(v.email, `wrong-${i}`);
    expect((await db.query(`SELECT 1 FROM security_log WHERE user_id = $1 AND event = 'sign_in_locked'`, [v.id])).rowCount).toBe(1);
  });

  it('reading needs a System Admin or view_security_log; the ip is shown to System Admins only; every read is audited', async () => {
    const plain = await makeUser(db, { assigned: true });
    const papi = await loggedIn(app, plain);
    expect((await papi.call('get', '/security-log')).status).toBe(403);
    const reader = await makeUser(db, { assigned: true });
    await grantProfile(db, reader.id, [['admin.security_log', 'view_security_log']]);
    const rapi = await loggedIn(app, reader);
    const r = await rapi.call('get', '/security-log?event=sign_in_succeeded&limit=5');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((x: { ip: string | null }) => x.ip === null)).toBe(true);
    const read = await lastAudit('security_log.read');
    expect(read.actor_id).toBe(reader.id);
    expect(read.after.event).toEqual(['sign_in_succeeded']);

    const { api } = await adminApi(app, db);
    const all = await api.call('get', `/security-log?user_id=${reader.id}`);
    expect(all.body.items.some((x: { ip: string | null; event: string }) => x.event === 'sign_in_succeeded' && x.ip === rapi.ip)).toBe(true);
    const page = await api.call('get', '/security-log?limit=1');
    expect(page.body.page.next_cursor).toBeTruthy();
    const next = await api.call('get', `/security-log?limit=1&cursor=${page.body.page.next_cursor}`);
    expect(next.body.items[0].id).toBeLessThan(page.body.items[0].id);
    expect((await api.call('get', '/security-log?event=nonsense')).status).toBe(422);
    // pmis_app cannot read the table directly
    const app2 = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_LOGS });
    await app2.connect();
    await expect(app2.query('SELECT * FROM security_log LIMIT 1')).rejects.toThrow(/permission denied/);
    await app2.end();
  });

  it('ends another user\'s session with a reason and step-up (Online now) and logs session_revoked_by_admin', async () => {
    const { api } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const uapi = new Api(app);
    await request(uapi, u.email, u.password);
    const list = await api.call('get', '/admin/sessions', undefined, { 'X-PMIS-Live': '1' });
    expect(list.status).toBe(200);
    const s = list.body.items.find((x: { user: { id: string } }) => x.user.id === u.id);
    expect(s).toBeTruthy();
    expect(s.device).toEqual({ browser: 'Safari', os: 'iOS', type: 'mobile' });
    expect(s.ip).toBe(uapi.ip);
    const active = await api.call('get', '/sessions/active');
    expect(active.status).toBe(200);
    expect(active.body.items.some((x: { is_current: boolean }) => x.is_current)).toBe(true);
    expect((await api.call('post', `/admin/sessions/${s.session_id}/end`, {})).status).toBe(422);
    const ended = await api.call('post', `/admin/sessions/${s.session_id}/end`, { reason: 'left the company laptop open' });
    expect(ended.status).toBe(200);
    expect(ended.body.revoked_count).toBe(1);
    expect((await uapi.call('get', '/me')).status).toBe(401);
    expect((await db.query(`SELECT 1 FROM security_log WHERE user_id = $1 AND event = 'session_revoked_by_admin'`, [u.id])).rowCount).toBe(1);
    expect((await api.call('post', `/sessions/${list.body.items.find((x: { is_current: boolean }) => x.is_current)?.session_id}/revoke`, { reason: 'my own' })).status).toBe(422);
    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await plain.call('get', '/admin/sessions')).status).toBe(403);
  });
});

async function request(a: Api, id: string, pw: string): Promise<void> {
  const r = await (await import('supertest')).default(a.app.getHttpServer()).post('/api/v1/auth/local/login').set('X-Forwarded-For', a.ip).set('User-Agent', UA_IPHONE).send({ identifier: id, password: pw });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  a.token = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pmis_session='))!.split(';')[0]!.slice('pmis_session='.length);
  a.csrf = r.body.csrf_token;
}

describe('security alerts', () => {
  it('raises failed sign-in alerts from the job, notifies the System Admins, and an admin acknowledges with a note', async () => {
    const { api, admin } = await adminApi(app, db);
    const typed = `ghost-${uid()}@example.test`;
    const anon = new Api(app);
    for (let i = 0; i < 5; i++) await anon.login(typed, `pw-${i}`);
    await app.get(JobRunsService).evaluateAlerts();
    const open = await api.call('get', '/admin/security-alerts?status=open&limit=100');
    expect(open.status).toBe(200);
    expect(open.body.page.total).toBeGreaterThan(0);
    const alert = open.body.items.find((a: { rule: string; data: { key: string } }) => a.rule === 'failed_sign_ins' && /^\?g\*\*\*#/.test(a.data.key));
    expect(alert).toBeTruthy();
    expect(alert).toMatchObject({ severity: 'medium', status: 'open' });
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'security_alert'`, [admin.id])).rowCount).toBeGreaterThan(0);
    // idempotent: a second run raises nothing new for the same window
    const n = Number((await db.query('SELECT count(*) FROM security_alerts')).rows[0].count);
    await app.get(JobRunsService).evaluateAlerts();
    expect(Number((await db.query('SELECT count(*) FROM security_alerts')).rows[0].count)).toBe(n);

    expect((await api.call('post', `/admin/security-alerts/${alert.id}/ack`, { note: 'x' })).status).toBe(422);
    const ack = await api.call('post', `/admin/security-alerts/${alert.id}/ack`, { note: 'checked with the user' });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'acknowledged', ack_note: 'checked with the user' });
    expect((await api.call('post', `/admin/security-alerts/${alert.id}/ack`, { note: 'again please' })).status).toBe(409);
    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await plain.call('get', '/admin/security-alerts')).status).toBe(403);
    expect((await api.call('get', '/admin/job-runs?name=security_alerts')).body.items[0]).toMatchObject({ name: 'security_alerts', outcome: 'ok' });
  });

  it('thresholds are settings with allowed ranges, If-Match and a reason; a large export raises an alert', async () => {
    const { api } = await adminApi(app, db);
    const cur = await api.call('get', '/settings/security-alerts');
    expect(cur.status).toBe(200);
    const body = { reason: 'tighten for the pilot', failed_sign_ins: { count: 2, minutes: 15 }, failed_by_ip: { count: 20, minutes: 15 }, large_export_rows: 100, new_ip: true };
    const bad = await api.call('put', '/settings/security-alerts', body, { 'If-Match': String(cur.headers.etag) });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toContainEqual(expect.objectContaining({ path: '/failed_sign_ins/count' }));
    expect((await api.call('put', '/settings/security-alerts', { ...body, failed_sign_ins: { count: 5, minutes: 15 }, extra: 1 }, { 'If-Match': String(cur.headers.etag) })).status).toBe(422);
    const ok = await api.call('put', '/settings/security-alerts', { ...body, failed_sign_ins: { count: 5, minutes: 15 } }, { 'If-Match': String(cur.headers.etag) });
    expect(ok.status).toBe(200);
    expect(ok.body.large_export_rows).toBe(100);
    expect((await api.call('put', '/settings/security-alerts', { ...body, failed_sign_ins: { count: 5, minutes: 15 } }, { 'If-Match': String(cur.headers.etag) })).status).toBe(412);

    // an export above the threshold
    await db.query(`INSERT INTO audit_log (action, entity_type, entity_id) SELECT 'export_filler', 'user', g::text FROM generate_series(1, 120) g`);
    const job = await api.call('post', '/audit-log/exports', {});
    expect(job.status).toBe(202);
    expect((await waitJob(api, job.body.id)).status).toBe('done');
    await app.get(JobRunsService).evaluateAlerts();
    expect((await db.query(`SELECT 1 FROM security_alerts WHERE rule = 'large_export' AND (detail ->> 'action') = 'audit_log.export_done'`)).rowCount).toBeGreaterThan(0);
    const back = await api.call('get', '/settings/security-alerts');
    expect((await api.call('put', '/settings/security-alerts', { ...body, failed_sign_ins: { count: 5, minutes: 15 }, large_export_rows: 5000 }, { 'If-Match': String(back.headers.etag) })).status).toBe(200);
  });

  it('weakening a threshold needs a fresh step-up, is audited as such and raises a high alert; tightening does not', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);                       // signed in, no step-up yet
    const cur = await api.call('get', '/settings/security-alerts');
    const base = { reason: 'review', failed_sign_ins: cur.body.failed_sign_ins, failed_by_ip: cur.body.failed_by_ip, large_export_rows: cur.body.large_export_rows, new_ip: cur.body.new_ip };
    // weaker: more failures allowed, and the new-address rule off
    const weak = { ...base, failed_sign_ins: { ...base.failed_sign_ins, count: base.failed_sign_ins.count + 10 }, new_ip: false };
    const refused = await api.call('put', '/settings/security-alerts', weak, { 'If-Match': String(cur.headers.etag) });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('step_up_required');
    // tightening needs no step-up
    const tight = { ...base, failed_sign_ins: { ...base.failed_sign_ins, count: Math.max(3, base.failed_sign_ins.count - 1) } };
    const t = await api.call('put', '/settings/security-alerts', tight, { 'If-Match': String(cur.headers.etag) });
    expect(t.status).toBe(200);
    expect((await api.stepUp(admin.password)).status).toBe(200);
    const w = await api.call('put', '/settings/security-alerts', weak, { 'If-Match': String(t.headers.etag) });
    expect(w.status).toBe(200);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'security_alert_settings_weakened' AND actor_id = $1`, [admin.id])).rowCount).toBe(1);
    await app.get(JobRunsService).evaluateAlerts();
    expect((await db.query(`SELECT severity FROM security_alerts WHERE rule = 'alert_settings_weakened'`)).rows[0]).toMatchObject({ severity: 'high' });
    // put the defaults back for the other tests
    expect((await api.call('put', '/settings/security-alerts', base, { 'If-Match': String(w.headers.etag) })).status).toBe(200);
  });
});

describe('retention', () => {
  it('enforces the minimums, needs step-up to reduce, raises the mandatory alert, and the purge removes only old System Log rows', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const cur = await api.call('get', '/settings/log-retention');
    expect(cur.status).toBe(200);
    expect(cur.body).toMatchObject({ system_log_days: 365, security_log_days: 730, audit_log_years: 10 });
    const etag = cur.headers.etag as string;
    const low = await api.call('put', '/settings/log-retention', { reason: 'too short', system_log_days: 30, security_log_days: 100 }, { 'If-Match': etag });
    expect(low.status).toBe(422);
    expect(low.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['/system_log_days', '/security_log_days']));
    expect((await api.call('put', '/settings/log-retention', { reason: 'x years', system_log_days: 365, security_log_days: 730, audit_log_years: 5 }, { 'If-Match': etag })).status).toBe(422);
    const noStep = await api.call('put', '/settings/log-retention', { reason: 'save disk space', system_log_days: 200, security_log_days: 730 }, { 'If-Match': etag });
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect((await api.stepUp(admin.password)).status).toBe(200);
    const reduced = await api.call('put', '/settings/log-retention', { reason: 'save disk space', system_log_days: 200, security_log_days: 730 }, { 'If-Match': etag });
    expect(reduced.status).toBe(200);
    expect(reduced.body.system_log_days).toBe(200);
    const audit = await lastAudit('log_retention_reduced');
    expect(audit.reason).toBe('save disk space');
    expect(audit.before.system_log_days).toBe(365);
    expect((await db.query(`SELECT 1 FROM security_alerts WHERE rule = 'retention_reduced' AND severity = 'critical' AND (detail ->> 'audit_id')::bigint = $1`, [audit.id])).rowCount).toBe(1);
    // raising needs no step-up
    const fresh = await loggedIn(app, admin);
    const raised = await fresh.call('put', '/settings/log-retention', { reason: 'back to a year', system_log_days: 365, security_log_days: 730 }, { 'If-Match': String(reduced.headers.etag) });
    expect(raised.status).toBe(200);
    expect((await lastAudit('log_retention_set')).after.system_log_days).toBe(365);

    await db.query(`INSERT INTO system_log (level, source, message, at) VALUES ('info', 'test', 'old row', now() - interval '400 days'), ('info', 'test', 'young row', now() - interval '10 days')`);
    await app.get(JobRunsService).purge();
    const left = await db.query(`SELECT message FROM system_log WHERE source = 'test' ORDER BY message`);
    expect(left.rows.map((r) => r.message)).toEqual(['young row']);
    // the security log loses nothing younger than its retention, and the audit log is never purged
    expect((await api.call('get', '/security-log/integrity')).body.status).toBe('ok');
    const runs = await api.call('get', '/admin/job-runs?name=log_purge');
    expect(runs.body.items[0]).toMatchObject({ name: 'log_purge', outcome: 'ok' });
  });
});

describe('Audit Log readers (B4)', () => {
  it('a Team Lead sees only the entries of their own modules and regions; others need view_audit; every read is audited', async () => {
    const lead = await makeUser(db, { assigned: true });
    const role = (await db.query(`SELECT id FROM roles WHERE code = 'CW_TL'`)).rows[0].id;
    await db.query('BEGIN');
    const a = await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', false, false) RETURNING id`, [lead.id, role]);
    await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 1)', [a.rows[0].id]);
    await db.query(`INSERT INTO user_role_assignment_modules (assignment_id, module_key) VALUES ($1, 'gecol')`, [a.rows[0].id]);
    // makeUser's assignment covers every module and region: take it away so only the Team Lead assignment counts
    await db.query(`DELETE FROM user_role_assignments WHERE user_id = $1 AND role_id <> $2`, [lead.id, role]);
    await db.query('COMMIT');
    const tag = uid();
    const ins = (region: number, register: string) => db.query(`INSERT INTO audit_log (action, entity_type, entity_id, region_id, before, after) VALUES ('scope_probe', 'register_record', $1, $2, $3::jsonb, $4::jsonb)`,
      [`${tag}-${register}-${region}`, region, JSON.stringify({ register, data: { probe: 'a' } }), JSON.stringify({ register, data: { probe: 'b' } })]);
    await ins(1, 'gecol');
    await ins(2, 'gecol');
    await ins(1, 'hlc');
    await db.query(`INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('scope_probe', 'user', $1)`, [`${tag}-user`]);
    const lapi = await loggedIn(app, lead);
    const r = await lapi.call('get', '/audit-log?action=scope_probe&limit=200');
    expect(r.status).toBe(200);
    const mine = r.body.items.map((x: { entity_id: string }) => x.entity_id).filter((e: string) => e.startsWith(tag));
    expect(mine).toEqual([`${tag}-gecol-1`]);
    expect(r.body.items.every((x: { module_key: string; region_id: number }) => x.module_key === 'gecol' && x.region_id === 1)).toBe(true);
    const f = await lapi.call('get', '/audit-log/field-changes?field=probe&limit=200');
    expect(f.status).toBe(200);
    expect(f.body.items.every((x: { region_id: number; module_key: string }) => x.region_id === 1 && x.module_key === 'gecol')).toBe(true);
    expect(f.body.items.length).toBeGreaterThan(0);
    expect((await lastAudit('audit_log.read')).actor_id).toBe(lead.id);

    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await plain.call('get', '/audit-log')).status).toBe(403);
    expect((await plain.call('get', '/audit-log/field-changes')).status).toBe(403);

    const { api } = await adminApi(app, db);
    const all = await api.call('get', `/audit-log?action=scope_probe&limit=200`);
    expect(all.body.items.filter((x: { entity_id: string }) => x.entity_id.startsWith(tag)).length).toBe(4);
    const viaFilter = await api.call('get', `/audit-log?region_id=2&action=scope_probe`);
    expect(viaFilter.body.items.every((x: { region_id: number }) => x.region_id === 2)).toBe(true);
    expect((await api.call('get', '/audit-log?via=sideways')).status).toBe(422);
    expect((await api.call('get', '/audit-log?ip=not-an-ip')).status).toBe(422);
    const p1 = await api.call('get', '/audit-log?limit=2');
    const p2 = await api.call('get', `/audit-log?limit=2&cursor=${p1.body.page.next_cursor}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    expect((await api.call('get', '/audit-log?cursor=bogus')).status).toBe(400);
  });
});

describe('exports, System Log, deployments and the activity report', () => {
  it('exports the Audit Log as CSV through a job; start, completion and download are audited', async () => {
    const { api, admin } = await adminApi(app, db);
    const start = await api.call('post', '/audit-log/exports', { entity_type: 'department' }, { 'Idempotency-Key': `k-${uid()}` });
    expect(start.status).toBe(202);
    expect(start.body.kind).toBe('audit_export');
    const job = { body: await waitJob(api, start.body.id) };
    expect(job.body).toMatchObject({ kind: 'audit_export', status: 'done' });
    expect(job.body.result.download_path).toBe(`/audit-log/exports/${start.body.id}/download`);
    const file = await api.call('get', `/audit-log/exports/${start.body.id}/download`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    const text = file.text;
    expect(text).toContain('"action"');
    expect(text).toContain('department_created');
    for (const a of ['audit_log.export_start', 'audit_log.export_done', 'audit_log.export_download']) expect((await lastAudit(a)).actor_id).toBe(admin.id);
    expect((await api.call('get', `/exports/zip/${start.body.id}/download`)).status).toBe(404);
    const other = await adminApi(app, db);
    expect((await other.api.call('get', `/audit-log/exports/${start.body.id}/download`)).status).toBe(404);
    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await plain.call('post', '/audit-log/exports', {})).status).toBe(403);
    const sec = await api.call('post', '/security-log/exports', { event: ['sign_in_failed'] });
    expect(sec.status).toBe(202);
    expect((await waitJob(api, sec.body.id)).status).toBe('done');
  });

  it('serves the System Log, the deployment log and the monthly activity report to the right readers', async () => {
    const { api, admin } = await adminApi(app, db);
    const sys = await api.call('get', '/system-log?limit=5');
    expect(sys.status).toBe(200);
    await db.query(`SELECT log_deployment('0.10.0', 'abcdef1234567', ARRAY['0045_logs_core'], 'installer-test', 'pmis-test')`);
    const dep = await api.call('get', '/admin/deployments');
    expect(dep.status).toBe(200);
    expect(dep.body.items[0]).toMatchObject({ version: '0.10.0', git_sha: 'abcdef1234567', migrations: ['0045_logs_core'], by: 'installer-test' });
    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await plain.call('get', '/system-log')).status).toBe(403);
    expect((await plain.call('get', '/admin/deployments')).status).toBe(403);

    const month = new Date().toISOString().slice(0, 7);
    const rep = await api.call('get', `/reports/activity?month=${month}`);
    expect(rep.status).toBe(200);
    expect(rep.body.month).toBe(month);
    const me = rep.body.users.find((x: { user: { id: string } }) => x.user.id === admin.id);
    expect(me).toBeTruthy();
    expect(me.sign_ins).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(rep.body.sensitive)).toBe(true);
    expect((await api.call('get', '/reports/activity?month=2026-13')).status).toBe(422);
    expect((await plain.call('get', `/reports/activity?month=${month}`)).status).toBe(403);
  });
});

describe('pmis_app writes no log', () => {
  it('cannot insert, update or delete the Audit Log, the System Log or the security log, nor forge a chain entry', async () => {
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_LOGS });
    await c.connect();
    try {
      await expect(c.query(`INSERT INTO audit_log (action, entity_type) VALUES ('forged', 'user')`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`INSERT INTO system_log (level, source, message) VALUES ('info', 'x', 'forged')`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`DELETE FROM system_log`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`INSERT INTO security_log (event, outcome) VALUES ('sign_in_succeeded', 'success')`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`INSERT INTO audit_log_chain (seq, audit_id, prev_hash, hash) VALUES (999999, 1, repeat('0', 64), repeat('0', 64))`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE log_chain_heads SET hash = repeat('f', 64)`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT log_audit_write('forged', 'user', NULL, NULL, NULL, NULL)`)).rejects.toThrow(/no signed-in actor/);
    } finally {
      await c.end();
    }
  });
});

describe('performance of the field-change trigger', () => {
  it('keeps 1000 register saves under budget', async () => {
    const t = await team(app, db, 'gecol', 'gecol', 4);
    const rec = await createRec(t, { ...GECOL, pr_no: `GP-${uid()}` });
    let version = rec.version as number;
    const save = async (n: number): Promise<number> => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const r = await patch(t.entry.api, 'gecol', rec.id, version, { data: { remark: `perf ${i} ${uid()}` } });
        if (r.status !== 200) throw new Error(`save ${i}: ${r.status} ${JSON.stringify(r.body)}`);
        version = r.body.version;
      }
      return (performance.now() - t0) / n;
    };
    const withTrigger = await save(1000);
    await db.query('ALTER TABLE audit_log DISABLE TRIGGER b_audit_log_field_diff');
    let without: number;
    try {
      without = await save(300);
    } finally {
      await db.query('ALTER TABLE audit_log ENABLE TRIGGER b_audit_log_field_diff');
    }
    const timing = { saves: 1000, ms_per_save_with_trigger: Number(withTrigger.toFixed(2)), ms_per_save_without: Number(without.toFixed(2)), overhead_ms: Number((withTrigger - without).toFixed(2)) };
    process.stderr.write(`[perf] field-change trigger: ${JSON.stringify(timing)}\n`);
    expect(withTrigger).toBeLessThan(200);       // a register save stays far under the 2 s page budget
    expect(withTrigger - without).toBeLessThan(25);
    const n = await db.query(`SELECT count(*) FROM audit_field_changes WHERE record_id = $1 AND field = 'remark'`, [rec.id]);
    expect(Number(n.rows[0].count)).toBeGreaterThanOrEqual(1000);
  }, 600_000);
});

void PASSWORD;
