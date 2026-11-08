import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDb } from './helpers';
import { day, fillTemplate, downloadTemplate, uploadFile } from './tpl-helpers';
import { filled, streamTeam, taskRow } from './tpl-stream-helpers';
import { makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0060 (P3): the two modes of a stream template (Q206), the actual start of a pending task (Q209), the scenario-aware Master columns (Q205)
 * and the template mapping screen (Q207). Region 4: the other suites set no cells for these tasks there. The suites that issue new template versions share
 * the advisory lock 770101 (only the mapping test changes a version, and it puts the mapping back).
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 4;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const rowsOf = async (api: Api, id: string): Promise<Record<string, any>[]> => {
  const res = await api.call('get', `/import-batches/${id}/rows`);
  expect(res.status).toBe(200);
  return res.body.items;
};
/** tpl_master_candidates answers only for a site the session may see: read it as a session that sees every region. */
async function candidates(siteId: string, letter: string): Promise<Record<string, any>> {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL app.region_ids = '*'`);
    return (await q<{ c: Record<string, any> }>(db, 'SELECT tpl_master_candidates($1, $2) AS c', [siteId, letter]))[0]!.c;
  } finally {
    await db.query('COMMIT');
  }
}
const byTask = (rows: Record<string, any>[], code: string): Record<string, any> => {
  const r = rows.find((x) => x.task_code === code);
  if (!r) throw new Error(`no row for ${code}: ${JSON.stringify(rows.map((x) => [x.task_code, x.errors]))}`);
  return r;
};
const upload = async (api: Api, buf: Buffer, fields: Record<string, string> = {}): Promise<Record<string, any>> => {
  const res = await uploadFile(api, buf, 'filled.xlsx', fields);
  if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
};
const submit = async (api: Api, id: string, version: number | string): Promise<Record<string, any>> => {
  const r = await api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': `"${version}"` });
  expect(r.status).toBe(200);
  return r.body as Record<string, any>;
};

describe('Save Draft / Planning and Submit for Review (Q206)', () => {
  it('a draft row needs no actual date: the plan is saved, the pending task is not started, nothing goes to L2; a submit row still needs its actual date', async () => {
    const t = await streamTeam(app, db, { B4: 'open' }, { region: R });
    const buf = await filled(t.entry.api, 'TPL-SITE-CW', [{ 'Site ID': t.site.code, 'B4 CW Survey Planned': day('2026-02-01'), 'B4 AAT SE Name': 'Eng Draft' }]);
    const sub = await upload(t.entry.api, buf);
    expect((await rowsOf(t.entry.api, sub.id))[0]!.errors[0]).toMatchObject({ code: 'actual_date_required' });
    const draft = await upload(t.entry.api, buf, { mode: 'draft' });
    expect(draft).toMatchObject({ mode: 'draft', status: 'validated' });
    expect(byTask(await rowsOf(t.entry.api, draft.id), 'B4')).toMatchObject({ action: 'update', errors: [] });
    const sent = await submit(t.entry.api, draft.id, draft.version);
    expect(sent.outcome).toMatchObject({ saved: 1, submitted: 0 });
    expect(sent).toMatchObject({ status: 'applied' });
    expect(sent.counts.saved).toBe(1);
    expect(await taskRow(db, t.tasks.B4!)).toMatchObject({ state: 'open', planned_date: '2026-02-01', actual_start: null, values: { aat_se_name: 'Eng Draft' } });
    const steps = await q(db, `SELECT 1 FROM workflow_steps WHERE task_id = $1`, [t.tasks.B4]);
    expect(steps).toHaveLength(0);
    // a draft batch has no L2 decision
    const dec = await t.approve.api.call('post', `/import-batches/${draft.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${sent.version}"` });
    expect([403, 409]).toContain(dec.status);
    // a register file is always submitted
    const reg = await uploadFile(t.entry.api, buf, 'x.xlsx', { mode: 'bogus' });
    expect(reg.status).toBe(422);
  });
});

describe('the actual start of a pending task (Q209)', () => {
  it('a task with an Actual Start column needs it (never today); a single-event task starts on its actual date', async () => {
    const t = await streamTeam(app, db, { B11: 'open', B4: 'open' }, { region: R });
    const noStart = await upload(t.entry.api, await filled(t.entry.api, 'TPL-SITE-CW', [{ 'Site ID': t.site.code, 'B11 CW Actual End': day('2026-02-10') }]));
    const r1 = byTask(await rowsOf(t.entry.api, noStart.id), 'B11');
    expect(r1).toMatchObject({ action: 'error' });
    expect(r1.errors[0]).toMatchObject({ code: 'actual_start_required' });
    expect(r1.errors[0].message).toContain('never uses today');
    const ok = await upload(t.entry.api, await filled(t.entry.api, 'TPL-SITE-CW', [{
      'Site ID': t.site.code, 'B11 CW Actual Start': day('2026-02-03'), 'B11 CW Actual End': day('2026-02-10'), 'B4 CW Survey Actual': day('2026-01-20'),
    }]));
    const sent = await submit(t.entry.api, ok.id, ok.version);
    expect(sent.outcome.submitted).toBe(2);
    expect(await taskRow(db, t.tasks.B11!)).toMatchObject({ actual_start: '2026-02-03', actual_date: '2026-02-10' });
    expect(await taskRow(db, t.tasks.B4!)).toMatchObject({ actual_start: '2026-01-20', actual_date: '2026-01-20' });    // single event: its date is its start
  });
});

describe('scenario-aware Master columns (Q205)', () => {
  beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
  afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });
  it('a shared Master column fills the one task that applies on the site; with two applicable tasks and no projection the row is refused (ambiguous)', async () => {
    const t = await streamTeam(app, db, { B8: 'open', B9: 'open' }, { region: R });
    const only = await streamTeam(app, db, { B9: 'open' }, { region: R });
    await makeTask(db, only.site, 'B8', 'na');
    await db.query(`UPDATE task_instances SET is_na = true WHERE site_id = $1 AND task_def_id = (SELECT id FROM task_definitions WHERE code = 'B8' AND workflow_id = (SELECT workflow_version_id FROM sites WHERE id = $1))`, [only.site.id]);
    const cand = (await candidates(t.site.id, 'AZ'));
    expect(cand).toMatchObject({ status: 'ambiguous', fields: 2 });
    expect((await candidates(only.site.id, 'AZ'))).toMatchObject({ status: 'single' });
    expect((await candidates(t.site.id, 'BN'))).toMatchObject({ status: 'none' });

    // one user who holds both teams' cells (the second team set the cells last): use the TPL-MASTER file of the last team
    const dl = await downloadTemplate(only.entry.api, 'TPL-MASTER');
    expect(dl.status).toBe(200);
    const buf = await fillTemplate(dl.buffer, [
      { 'Site ID': only.site.code, 'CW MOS / Actual Date': day('2026-02-05') },
      { 'Site ID': t.site.code, 'CW MOS / Actual Date': day('2026-02-06') },
    ], { sheet: 'Master' });
    const res = await uploadFile(only.entry.api, buf);
    expect(res.status).toBe(202);
    const cw = (res.body.parts as Record<string, any>[]).find((p) => p.stream === 'CW')!;
    const rows = await rowsOf(only.entry.api, cw.id);
    const b9 = rows.find((r) => r.site_code === only.site.code)!;
    expect(b9).toMatchObject({ task_code: 'B9', action: 'update' });
    const amb = rows.find((r) => r.site_code === t.site.code)!;
    expect(amb).toMatchObject({ action: 'error' });
    expect(amb.errors.map((e: { code: string }) => e.code)).toContain('ambiguous_mapping');
  });
});

describe('the template mapping screen (Q207)', () => {
  beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
  afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });

  it('tests a change without saving (impact), saves it with a reason and a new version, refuses a calculated field as typed and refuses non-admins', async () => {
    const admin = await plainAdmin(app, db);
    const view = await admin.api.call('get', '/template-mapping');
    expect(view.status).toBe(200);
    expect(view.body.can_edit).toBe(true);
    expect(view.body.fields.find((f: { task_code: string; field_key: string }) => f.task_code === 'B10' && f.field_key === 'actual_start')).toMatchObject({ master_col: 'BL', projection: 'earliest' });
    const v0 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v;
    const change = { op: 'upsert', task_code: 'B6', field_key: 'v:layout_ref', label: 'Layout Ref', field_type: 'text' };
    const test = await admin.api.call('post', '/template-mapping', { changes: [change], reason: 'add the layout reference', dry_run: true });
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ dry_run: true, changes: 1 });
    expect(test.body.impact.find((i: { template_id: string }) => i.template_id === 'TPL-SITE-CW')).toMatchObject({ columns_added: ['B6 Layout Ref'], version_before: v0, version_after: v0 + 1 });
    expect((await q(db, `SELECT 1 FROM template_task_fields WHERE task_code = 'B6' AND field_key = 'v:layout_ref'`))).toHaveLength(0);   // a test changes nothing
    expect((await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v).toBe(v0);

    // a field the workflow sets never becomes typed
    const bad = await admin.api.call('post', '/template-mapping', { changes: [{ op: 'upsert', task_code: 'B7', field_key: 'submitted_date', label: 'x', read_only: false }], reason: 'try', dry_run: true });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/changes/0/read_only', code: 'calculated_field' });
    // a Master column GSDN Workspace does not own is never mapped
    const own = await admin.api.call('post', '/template-mapping', { changes: [{ ...change, master_col: 'V' }], reason: 'try', dry_run: true });
    expect(own.body.errors[0]).toMatchObject({ code: 'column_not_owned' });

    try {
      const saved = await admin.api.call('post', '/template-mapping', { changes: [change], reason: 'add the layout reference' });
      expect(saved.status).toBe(200);
      const cur = await q<{ version: number; reason: string }>(db, `SELECT v.version, v.reason FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current`);
      expect(cur[0]).toEqual({ version: v0 + 1, reason: 'add the layout reference' });
      expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'template_mapping.save' AND reason = 'add the layout reference'`)).length).toBeGreaterThan(0);
    } finally {
      await admin.api.call('post', '/template-mapping', { changes: [{ op: 'deactivate', task_code: 'B6', field_key: 'v:layout_ref' }], reason: 'test cleanup' });
    }
    const t = await streamTeam(app, db, { B4: 'open' }, { region: R });
    expect((await t.entry.api.call('post', '/template-mapping', { changes: [change], reason: 'not mine', dry_run: true })).status).toBe(403);
  });
});
