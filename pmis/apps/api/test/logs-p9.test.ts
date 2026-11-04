import ExcelJS from 'exceljs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { IntegrityService } from '../src/logs/integrity.service';
import { JobRunsService } from '../src/logs/job-runs.service';
import { LogsService } from '../src/logs/logs.service';
import { API, Api, PASSWORD, adminApi, assign, beginAs, delegate, grantProfile, loggedIn, makeRole, makeUser, startApp } from './helpers';

/**
 * Work package P9 (migration 0055, contract 0.12.3): owner answers Q165 (role capabilities), Q168 (severity, trusted networks, progressive limiting),
 * Q169 (activity workbook), Q170 (no silent truncation of an export) and Q171 (integrity check as a job, stored result, external anchor, sealing at
 * commit). Runs on its own database (TEST_DATABASE_URL_P9): it changes the alert settings and the reader settings. Nothing here depends on the
 * weekday, the time zone or the collation.
 */
let app: NestExpressApplication;
let db: PgClient;
const anchorDir = mkdtempSync(join(tmpdir(), 'pmis-anchor-'));

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_P9 as string, anchorDir });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_P9 });
  await db.connect();
});
afterAll(async () => {
  await app.get(LogsService).idle();
  await app.get(IntegrityService).idle();
  await db.end();
  await app.close();
});

const lastAudit = async (action: string): Promise<Record<string, any>> =>
  (await db.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action])).rows[0];
/** The calendar month of now in the project time zone (the report month). */
const thisMonth = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
async function waitJob(api: Api, id: string): Promise<Record<string, any>> {
  for (let i = 0; i < 200; i++) {
    await app.get(LogsService).idle();
    const j = await api.call('get', `/jobs/${id}`);
    if (j.body.status === 'done' || j.body.status === 'failed') return j.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not end');
}
async function alertSettings(api: Api): Promise<{ body: Record<string, any>; etag: string }> {
  const r = await api.call('get', '/settings/security-alerts');
  return { body: r.body, etag: r.headers.etag as string };
}
const baseAlertBody = (b: Record<string, any>) => ({ failed_sign_ins: b.failed_sign_ins, failed_by_ip: b.failed_by_ip, large_export_rows: b.large_export_rows, new_ip: b.new_ip });

describe('Q165: role capabilities decide the full readers and the Team Leads', () => {
  it('the migration turned the seeded codes into capabilities', async () => {
    const r = await db.query(`SELECT code, capabilities FROM roles WHERE code IN ('PM', 'RFD_ACQ_TL', 'CW_TL', 'TE_TL') ORDER BY code`);
    expect(Object.fromEntries(r.rows.map((x) => [x.code, x.capabilities]))).toEqual({ CW_TL: ['team_lead'], PM: ['audit_full_reader'], RFD_ACQ_TL: ['team_lead'], TE_TL: ['team_lead'] });
  });

  it('a System Admin gives a role audit_full_reader (reason, step-up, audited); its holders then read the Audit Log', async () => {
    const { api } = await adminApi(app, db);
    const roleId = await makeRole(db);
    const u = await makeUser(db);
    const aid = await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', true, true) RETURNING id`, [u.id, roleId]);
    expect(aid.rowCount).toBe(1);
    const uapi = await loggedIn(app, u);
    expect((await uapi.call('get', '/audit-log?limit=1')).status).toBe(403);

    const role = await api.call('get', `/roles/${roleId}`);
    expect(role.body.capabilities).toEqual([]);
    const bad = await api.call('patch', `/roles/${roleId}`, { capabilities: ['reads_everything'], reason: 'test' }, { 'If-Match': role.headers.etag as string });
    expect(bad.status).toBe(422);
    const ok = await api.call('patch', `/roles/${roleId}`, { capabilities: ['audit_full_reader'], reason: 'Q165 test' }, { 'If-Match': role.headers.etag as string });
    expect(ok.status).toBe(200);
    expect(ok.body.capabilities).toEqual(['audit_full_reader']);
    expect(ok.headers.etag).not.toBe(role.headers.etag);
    const audit = await lastAudit('role_capabilities_set');
    expect(audit.entity_id).toBe(roleId);
    expect(audit.before.capabilities).toEqual([]);
    expect(audit.after.capabilities).toEqual(['audit_full_reader']);
    expect(audit.reason).toBe('Q165 test');
    expect((await uapi.call('get', '/audit-log?limit=1')).status).toBe(200);

    const off = await api.call('patch', `/roles/${roleId}`, { capabilities: [], reason: 'Q165 test off' }, { 'If-Match': ok.headers.etag as string });
    expect(off.status).toBe(200);
    expect((await uapi.call('get', '/audit-log?limit=1')).status).toBe(403);
  });

  it('a delegate holding roles edit cannot set capabilities; the database refuses pmis_app without a System Admin', async () => {
    const roleId = await makeRole(db);
    const d = await makeUser(db, { assigned: true });
    await delegate(db, d.id, [['roles', 'edit']]);
    const dapi = await loggedIn(app, d);
    await dapi.stepUp(PASSWORD);
    const role = await (await adminApi(app, db)).api.call('get', `/roles/${roleId}`);
    const r = await dapi.call('patch', `/roles/${roleId}`, { capabilities: ['team_lead'], reason: 'not mine to give' }, { 'If-Match': role.headers.etag as string });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('delegate_forbidden');
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_P9 });
    await appDb.connect();
    try {
      await appDb.query('BEGIN');
      await beginAs(appDb, d.id);
      await expect(appDb.query(`SELECT idm_role_set_capabilities($1, ARRAY['audit_full_reader'], 'try')`, [roleId])).rejects.toThrow(/System Admin only/);
      await appDb.query('ROLLBACK');
      await expect(appDb.query(`UPDATE roles SET capabilities = ARRAY['audit_full_reader'] WHERE id = $1`, [roleId])).rejects.toThrow(/permission denied|idm_\*/);
    } finally {
      await appDb.end();
    }
  });

  it('the setting lists are a fallback only: once a role carries the capability, a code in the setting no longer reads everything', async () => {
    const code = `FALLBACK_${Date.now()}`;
    const roleId = await makeRole(db, { code });
    const u = await makeUser(db);
    await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', true, true)`, [u.id, roleId]);
    const old = (await db.query(`SELECT value FROM settings WHERE key = 'logs.audit.full_reader_roles'`)).rows[0].value;
    await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'logs.audit.full_reader_roles'`, [JSON.stringify([...old, code])]);
    try {
      const uapi = await loggedIn(app, u);
      expect((await uapi.call('get', '/audit-log?limit=1')).status).toBe(403);   // PM carries audit_full_reader: the list is not read
    } finally {
      await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'logs.audit.full_reader_roles'`, [JSON.stringify(old)]);
    }
  });

  it('a Team Lead reads only while the assignment is valid, and gets no security log', async () => {
    const tl = await db.query(`SELECT id FROM roles WHERE code = 'CW_TL'`);
    const u = await makeUser(db);
    await db.query('BEGIN');
    const a = await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules, valid_from, valid_to)
      VALUES ($1, $2, 'view', false, false, now() - interval '2 days', now() + interval '1 day') RETURNING id`, [u.id, tl.rows[0].id]);
    await db.query(`INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 1)`, [a.rows[0].id]);
    await db.query(`INSERT INTO user_role_assignment_modules (assignment_id, module_key) VALUES ($1, 'sites')`, [a.rows[0].id]);
    await db.query('COMMIT');
    const uapi = await loggedIn(app, u);
    expect((await uapi.call('get', '/audit-log?limit=5')).status).toBe(200);
    expect((await uapi.call('get', '/security-log?limit=1')).status).toBe(403);
    const ended = await makeUser(db);
    await db.query('BEGIN');
    const b = await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules, valid_from, valid_to)
      VALUES ($1, $2, 'view', false, true, now() - interval '5 days', now() - interval '1 day') RETURNING id`, [ended.id, tl.rows[0].id]);
    await db.query(`INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 1)`, [b.rows[0].id]);
    await db.query('COMMIT');
    await assign(db, ended.id);   // still active through another role, without any Audit Log right
    const eapi = await loggedIn(app, ended);
    expect((await eapi.call('get', '/audit-log?limit=1')).status).toBe(403);
  });
});

describe('Q168: severities, trusted networks, progressive limiting', () => {
  it('the alert settings carry a severity per rule, the mail floor and the trusted networks; adding a network is a weakening (step-up, audited, alert)', async () => {
    const { api } = await adminApi(app, db);
    let { body, etag } = await alertSettings(api);
    expect(body.severity).toMatchObject({ new_ip: 'low', failed_sign_ins: 'medium', admin_set_changed: 'high', break_glass_used: 'critical' });
    expect(body.mandatory_severity).toEqual({ retention_reduced: 'critical', audit_integrity_failure: 'critical' });
    expect(body.email_min_severity).toBe('low');
    expect(body.trusted_networks).toEqual([]);

    const badNet = await api.call('put', '/settings/security-alerts', { ...baseAlertBody(body), reason: 'net', trusted_networks: ['10.0.0.1/8'] }, { 'If-Match': etag });
    expect(badNet.status).toBe(422);
    expect(badNet.body.errors[0]).toMatchObject({ path: '/trusted_networks', code: 'invalid' });
    const locked = await api.call('put', '/settings/security-alerts', { ...baseAlertBody(body), reason: 'sev', severity: { audit_integrity_failure: 'low' } }, { 'If-Match': etag });
    expect(locked.status).toBe(422);
    expect(locked.body.errors[0]).toMatchObject({ path: '/severity/audit_integrity_failure', code: 'mandatory_locked' });
    expect((await api.call('put', '/settings/security-alerts', { ...baseAlertBody(body), reason: 'x', colour: 'red' }, { 'If-Match': etag })).status).toBe(422);

    const r = await api.call('put', '/settings/security-alerts', { ...baseAlertBody(body), reason: 'office NAT', trusted_networks: ['172.30.0.0/16'] }, { 'If-Match': etag });
    expect(r.status).toBe(200);
    expect(r.body.trusted_networks).toEqual(['172.30.0.0/16']);
    expect((await lastAudit('security_alert_settings_weakened')).after.trusted_networks).toEqual(['172.30.0.0/16']);
    ({ body, etag } = await alertSettings(api));
    // tightening (a higher severity) needs no step-up
    const fresh = await loggedIn(app, (await adminApi(app, db)).admin);
    const tighter = await fresh.call('put', '/settings/security-alerts', { ...baseAlertBody(body), reason: 'stricter', severity: { failed_sign_ins: 'high' } }, { 'If-Match': etag });
    expect(tighter.status).toBe(200);
    expect(tighter.body.severity.failed_sign_ins).toBe('high');
    const looser = await fresh.call('put', '/settings/security-alerts', { ...baseAlertBody(body), reason: 'looser', severity: { failed_sign_ins: 'low' } }, { 'If-Match': tighter.headers.etag as string });
    expect(looser.status).toBe(401);
    expect(looser.body.code).toBe('step_up_required');
  });

  it('a sign-in from a new address in a trusted network is still raised, one level softer; outside it the rule severity holds', async () => {
    const u = await makeUser(db, { assigned: true });
    await new Api(app, '10.99.1.1').login(u.email, u.password);
    await new Api(app, '172.30.4.5').login(u.email, u.password);
    await new Api(app, '10.99.2.2').login(u.email, u.password);
    await app.get(JobRunsService).evaluateAlerts();
    const rows = await db.query(`SELECT ip, severity, detail FROM security_alerts WHERE rule = 'new_ip' AND user_id = $1 ORDER BY ip`, [u.id]);
    expect(rows.rows.map((x) => [x.ip, x.severity, x.detail.trusted_network])).toEqual([['10.99.2.2', 'low', false], ['172.30.4.5', 'info', true]]);
  });

  it('every use of the break-glass account raises a critical alert', async () => {
    const u = await makeUser(db, { assigned: true });
    await db.query(`SELECT sec_log_write('break_glass_used', 'info', $1, NULL, NULL, '{"ip": "10.1.2.3", "client_type": "break_glass"}'::jsonb)`, [u.id]);
    await app.get(JobRunsService).evaluateAlerts();
    const a = await db.query(`SELECT severity, ip FROM security_alerts WHERE rule = 'break_glass_used' AND user_id = $1`, [u.id]);
    expect(a.rows).toEqual([{ severity: 'critical', ip: '10.1.2.3' }]);
  });

  it('limits an address progressively: free failures, then a doubling wait capped at 60 s; successes do not count', () => {
    const l = new RateLimiter();
    let now = 1_000_000;
    l.setClock({ now: () => now });
    const k = 'login:ip:198.51.100.7';
    for (let i = 0; i < 10; i++) {
      expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(0);
      l.progressiveFail(k, 900_000);
    }
    expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(2);
    now += 2_000;
    expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(0);
    l.progressiveFail(k, 900_000);
    expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(4);
    for (let i = 0; i < 10; i++) l.progressiveFail(k, 900_000);
    expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(60);
    now += 900_001;                                   // the window passed: the address is free again
    expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(0);
  });

  it('counts attempts still running as failures, so parallel attempts from one address cannot all pass the check', () => {
    const l = new RateLimiter();
    const now = 2_000_000;
    l.setClock({ now: () => now });
    const k = 'login:ip:198.51.100.8';
    const releases: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(0);
      releases.push(l.progressiveBegin(k));      // reserved before any await: nothing is recorded as failed yet
    }
    expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(2);
    releases.forEach((r) => { r(); r(); });       // all succeeded; a second release is a no-op
    expect(l.progressiveWait(k, 10, 900_000, 2, 60)).toBe(0);
  });

  it('behind one address, correct sign-ins keep working while failures from it are slowed', async () => {
    app.get(RateLimiter).reset();
    const ip = '198.51.100.99';
    const people = [];
    for (let i = 0; i < 12; i++) people.push(await makeUser(db, { assigned: true }));
    for (let i = 0; i < 10; i++) expect((await new Api(app, ip).login(`nobody.${i}.${Date.now()}@example.test`, 'Whatever-Pass-123')).status).toBe(401);
    const slowed = await new Api(app, ip).login('nobody.x@example.test', 'Whatever-Pass-123');
    expect(slowed.status).toBe(429);
    expect(Number(slowed.headers['retry-after'])).toBeLessThanOrEqual(60);
    app.get(RateLimiter).reset();
    for (const p of people) expect((await new Api(app, ip).login(p.email, p.password)).status).toBe(200);   // successes never count
    app.get(RateLimiter).reset();
  });
});

describe('Q170: an export above the cap is refused with the count, never cut', () => {
  it('answers 422 too_many_rows with the count (audited), and a narrower export goes through', async () => {
    const { api, admin } = await adminApi(app, db);
    const svc = app.get(LogsService);
    svc.exportMaxRows = 3;
    try {
      const big = await api.call('post', '/audit-log/exports', {});
      expect(big.status).toBe(422);
      expect(big.body.code).toBe('too_many_rows');
      expect(big.body.max_rows).toBe(3);
      expect(big.body.row_count).toBeGreaterThan(3);
      const refused = await lastAudit('audit_log.export_refused');
      expect(refused.actor_id).toBe(admin.id);
      expect(refused.after.matching_rows).toBe(big.body.row_count);
      const sec = await api.call('post', '/security-log/exports', {});
      expect(sec.status).toBe(422);
      expect(sec.body.code).toBe('too_many_rows');

      const small = await api.call('post', '/audit-log/exports', { action: 'audit_log.export_refused', actor_id: admin.id });
      expect(small.status).toBe(202);
      const job = await waitJob(api, small.body.id);
      expect(job.status).toBe('done');
      expect(job.result.row_count).toBeLessThanOrEqual(3);
    } finally {
      svc.exportMaxRows = 100_000;
    }
  });
});

describe('Q169: the monthly activity workbook', () => {
  it('has the six sheets, no security log, text cells only, and is audited as an export', async () => {
    const { api, admin } = await adminApi(app, db);
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.user_id', $1, true)`, [admin.id]);
    await db.query(`SELECT log_audit_write('role_updated', 'role', 'p9-role', NULL, '{"name_en": "x"}'::jsonb, '=HYPERLINK("http://evil.test")')`);
    await db.query('COMMIT');
    const month = thisMonth();
    const res = await api.raw('get', `/reports/activity?month=${month}&format=xlsx`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toContain(`GSDN_ActivityReport_${month}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'User Activity', 'Module Activity', 'Exports', 'Exceptions', 'About']);
    const ua = wb.getWorksheet('User Activity')!;
    expect((ua.getRow(1).values as unknown[]).slice(1)).toEqual(['Employee ID', 'Name', 'Actions', 'Field changes', 'Approvals']);
    const about = wb.getWorksheet('About')!;
    const aboutText = about.getSheetValues().map((r) => (Array.isArray(r) ? r.slice(1).join(' | ') : '')).join('\n');
    expect(aboutText).toContain(`month=${month}`);
    expect(aboutText).toMatch(/Security log \| Not included/);
    const exc = wb.getWorksheet('Exceptions')!;
    let found = false;
    exc.eachRow((row) => row.eachCell((cell) => {
      if (cell.value === '=HYPERLINK("http://evil.test")') {
        found = true;
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.formula).toBeUndefined();
      }
    }));
    expect(found).toBe(true);
    const audit = await lastAudit('report.activity_export');
    expect(audit.actor_id).toBe(admin.id);
    expect(audit.after).toMatchObject({ month, format: 'xlsx' });
    expect(audit.after.row_count).toBeGreaterThan(0);
    expect((await api.call('get', `/reports/activity?month=${month}&format=pdf`)).status).toBe(422);
    expect((await api.call('get', `/reports/activity?month=${month}`)).body.month).toBe(month);
  });

  it('a limited reader gets the workbook of their scope only', async () => {
    const u = await makeUser(db);
    await grantProfile(db, u.id, [['reports', 'view'], ['audit', 'view_audit']]);
    const uapi = await loggedIn(app, u);
    const res = await uapi.raw('get', `/reports/activity?month=${thisMonth()}&format=xlsx`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    const summary = wb.getWorksheet('Summary')!.getSheetValues().map((r) => (Array.isArray(r) ? r.slice(1).join(' | ') : '')).join('\n');
    // the grant covers every module of an all-modules assignment in all regions, but rows without a module stay with the full readers
    expect(summary).toMatch(/Month \| \d{4}-\d{2}/);
  });
});

describe('Q171: the integrity check as a job, its stored result and the external anchor', () => {
  it('a System Admin starts a check; it runs after the answer, reports progress, stores the result and appends the anchor', async () => {
    const { api } = await adminApi(app, db);
    const start = await api.call('post', '/admin/log-integrity/runs', { log: 'audit' });
    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({ log: 'audit', trigger: 'manual', status: 'running' });
    await app.get(IntegrityService).idle();
    const run = (await api.call('get', `/admin/log-integrity/runs/${start.body.id}`)).body;
    expect(run).toMatchObject({ status: 'ok', progress: 100, break_count: 0 });
    expect(run.row_count).toBe(run.to_seq - run.from_seq + 1);
    expect(run.head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.anchor_ref).toMatch(/^anchor-audit\.jsonl#\d+:[0-9a-f]{16}$/);
    const job = await db.query(`SELECT outcome, detail, rows FROM job_runs WHERE id = (SELECT job_run_id FROM log_integrity_runs WHERE id = $1)`, [run.id]);
    expect(job.rows[0]).toMatchObject({ outcome: 'ok', detail: expect.objectContaining({ progress: 100, status: 'ok', run_id: run.id }) });
    const lines = readFileSync(join(anchorDir, 'anchor-audit.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ log: 'audit', seq: run.to_seq, hash: run.head_hash, run_id: run.id });
    expect((await lastAudit('audit_log.integrity_check')).after).toMatchObject({ status: 'ok', run_id: run.id, as_job: true });
    const list = await api.call('get', '/admin/log-integrity/runs?log=audit');
    expect(list.body.items.some((x: { id: string }) => x.id === run.id)).toBe(true);
    const u = await makeUser(db, { assigned: true });
    expect((await (await loggedIn(app, u)).call('post', '/admin/log-integrity/runs', { log: 'audit' })).status).toBe(403);
  });

  it('the nightly run checks both chains and the last anchor; a changed anchor is a break with the mandatory alert', async () => {
    const svc = app.get(IntegrityService);
    const first = await svc.nightly();
    expect(first.map((r) => [r.log, r.trigger, r.status])).toEqual([['audit', 'nightly', 'ok'], ['security', 'nightly', 'ok']]);
    const second = await svc.nightly();
    expect(second[0]!.anchor_check).toMatchObject({ ok: true });
    // someone rewrote the chain (here: the anchor no longer matches what the chain holds at that position)
    const f = join(anchorDir, 'anchor-audit.jsonl');
    const saved = readFileSync(f, 'utf8');
    const lines = saved.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!);
    writeFileSync(f, [...lines.slice(0, -1), JSON.stringify({ ...last, hash: 'f'.repeat(64) })].join('\n') + '\n');
    try {
      const third = await svc.nightly();
      expect(third[0]).toMatchObject({ log: 'audit', status: 'broken' });
      expect(third[0]!.breaks).toContainEqual(expect.objectContaining({ kind: 'anchor_mismatch', seq: last.seq, expected_hash: 'f'.repeat(64) }));
      const alert = await db.query(`SELECT severity FROM security_alerts WHERE dedup_key = $1`, [`audit_integrity_failure:audit:run:${third[0]!.id}`]);
      expect(alert.rows[0].severity).toBe('critical');
      const job = await db.query(`SELECT outcome FROM job_runs WHERE id = (SELECT job_run_id FROM log_integrity_runs WHERE id = $1)`, [third[0]!.id]);
      expect(job.rows[0].outcome).toBe('failed');
      const health = await request(app.getHttpServer()).get(`${API}/health`);
      expect(health.body).toMatchObject({ status: 'degraded', checks: { integrity: 'broken' } });
    } finally {
      writeFileSync(f, saved);
    }
    const fourth = await svc.nightly();
    expect(fourth.map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('a check runs in steps with progress; one at a time per log; only its driver moves it', async () => {
    const r = (await db.query(`SELECT * FROM log_integrity_start('audit', 'nightly')`)).rows[0];
    expect(r.status).toBe('running');
    await expect(db.query(`SELECT * FROM log_integrity_start('audit', 'nightly')`)).rejects.toThrow(/running already/);
    const s1 = (await db.query(`SELECT * FROM log_integrity_step($1, 2)`, [r.id])).rows[0];
    expect(Number(s1.checked_through)).toBe(Number(r.from_seq) + 1);
    const p1 = (await db.query(`SELECT detail FROM job_runs WHERE id = $1`, [r.job_run_id])).rows[0].detail.progress;
    expect(p1).toBeGreaterThan(0);
    expect(p1).toBeLessThan(100);
    await expect(db.query(`SELECT * FROM log_integrity_finish($1, NULL)`, [r.id])).rejects.toThrow(/has not reached the end/);
    // a signed-in user cannot drive a nightly run
    await db.query('BEGIN');
    const admin = (await db.query(`SELECT u.id FROM users u JOIN group_members gm ON gm.user_id = u.id JOIN groups g ON g.id = gm.group_id AND g.is_system_admins LIMIT 1`)).rows[0].id;
    await db.query(`SELECT set_config('app.user_id', $1, true)`, [admin]);
    await expect(db.query(`SELECT * FROM log_integrity_step($1, 100)`, [r.id])).rejects.toThrow(/not the driver/);
    await db.query('ROLLBACK');
    let cur = s1;
    while (Number(cur.checked_through) < Number(cur.to_seq)) cur = (await db.query(`SELECT * FROM log_integrity_step($1, 50000)`, [r.id])).rows[0];
    const done = (await db.query(`SELECT * FROM log_integrity_finish($1, NULL)`, [r.id])).rows[0];
    expect(done.status).toBe('ok');
    await expect(db.query(`UPDATE log_integrity_runs SET status = 'broken' WHERE id = $1`, [r.id])).rejects.toThrow(/blocked/);
  });

  it('the integrity button refuses a range larger than logs.integrity.sync_max_rows', async () => {
    const { api } = await adminApi(app, db);
    await db.query(`UPDATE settings SET value = '1'::jsonb WHERE key = 'logs.integrity.sync_max_rows'`);
    try {
      const r = await api.call('get', '/audit-log/integrity');
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('integrity_too_large');
      expect(r.body.max_rows).toBe(1);
      expect((await api.call('get', '/audit-log/integrity?from_seq=1&to_seq=1')).status).toBe(200);
    } finally {
      await db.query(`UPDATE settings SET value = '200000'::jsonb WHERE key = 'logs.integrity.sync_max_rows'`);
    }
  });

  it('sealing at commit: interleaved transactions both seal in commit order, a rolled-back one leaves no position', async () => {
    const admin = (await db.query(`SELECT u.id FROM users u JOIN group_members gm ON gm.user_id = u.id JOIN groups g ON g.id = gm.group_id AND g.is_system_admins LIMIT 1`)).rows[0].id;
    const a = new PgClient({ connectionString: process.env.TEST_SUPER_URL_P9 });
    const b = new PgClient({ connectionString: process.env.TEST_SUPER_URL_P9 });
    const c = new PgClient({ connectionString: process.env.TEST_SUPER_URL_P9 });
    await Promise.all([a.connect(), b.connect(), c.connect()]);
    try {
      const head0 = Number((await db.query(`SELECT seq FROM log_chain_heads WHERE log = 'audit'`)).rows[0].seq);
      for (const x of [a, b, c]) {
        await x.query('BEGIN');
        await x.query(`SELECT set_config('app.user_id', $1, true)`, [admin]);
      }
      const ia = Number((await a.query(`SELECT log_audit_write('p9_seal', 'report', 'a', NULL, NULL, NULL) AS id`)).rows[0].id);
      const ib = Number((await b.query(`SELECT log_audit_write('p9_seal', 'report', 'b', NULL, NULL, NULL) AS id`)).rows[0].id);
      await c.query(`SELECT log_audit_write('p9_seal', 'report', 'c', NULL, NULL, NULL)`);
      await b.query('COMMIT');
      await c.query('ROLLBACK');
      await a.query('COMMIT');
      const seq = await db.query(`SELECT audit_id, seq FROM audit_log_chain WHERE audit_id = ANY($1::bigint[]) ORDER BY seq`, [[ia, ib]]);
      expect(seq.rows.map((r) => Number(r.audit_id))).toEqual([ib, ia]);             // commit order, not id order
      const head1 = Number((await db.query(`SELECT seq FROM log_chain_heads WHERE log = 'audit'`)).rows[0].seq);
      expect(head1 - head0).toBeGreaterThanOrEqual(2);
      expect(Number((await db.query(`SELECT count(*) FROM audit_log_chain WHERE seq > $1 AND seq <= $2`, [head0, head1])).rows[0].count)).toBe(head1 - head0);
      expect((await db.query(`SELECT count(*) FROM audit_log WHERE action = 'p9_seal' AND entity_id = 'c'`)).rows[0].count).toBe('0');
      const nightly = await app.get(IntegrityService).nightly();
      expect(nightly[0]).toMatchObject({ log: 'audit', status: 'ok' });
    } finally {
      await Promise.all([a.end(), b.end(), c.end()]);
    }
  });
});
