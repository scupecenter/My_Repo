import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDbWfg } from './helpers';
import { Actor, actor, etag, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0096 (owner request 2026-11-14): the closing task of a milestone, the date_field gate condition end to end, and the structural freeze API
 * (set, lift, set again) with its guard on every structural door. Own database (TEST_DATABASE_URL_WFG): the suite freezes the workflow.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_WFG as string });
  db = await superDbWfg();
  // 0547 seeds a draft workflow v2 (the B11 split); this suite creates its own draft, so it starts from none.
  const draftWf = `(SELECT id FROM workflow_definitions WHERE status = 'draft')`;
  const draftTd = `(SELECT id FROM task_definitions WHERE workflow_id IN ${draftWf})`;
  await db.query(`DELETE FROM scenario_task_rules WHERE workflow_id IN ${draftWf}`);
  await db.query(`DELETE FROM matrix_cells WHERE task_def_id IN ${draftTd} OR stage_id IN (SELECT id FROM stage_definitions WHERE workflow_id IN ${draftWf})`);
  await db.query(`DELETE FROM sla_rule_set_items WHERE task_def_id IN ${draftTd}`);
  await db.query(`DELETE FROM sla_rules WHERE task_def_id IN ${draftTd}`);
  await db.query(`DELETE FROM document_type_placements WHERE task_def_id IN ${draftTd}`);
  await db.query(`DELETE FROM task_predecessors WHERE task_def_id IN ${draftTd} OR predecessor_id IN ${draftTd}`);
  await db.query(`DELETE FROM workflow_definitions WHERE status = 'draft'`);
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'entry' });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const REASON = 'Owner request for the workflow editor';
const BASE = '/workflow/versions';
const hdr = (t: string): Record<string, string> => ({ 'If-Match': t });
interface Ver { version_etag: number; milestones: { code: string }[]; gates: { code: string; conditions: unknown[] }[]; placements: { task_code: string; stage_code: string; is_milestone_task: boolean; is_active: boolean }[] }
const read = async (v: number): Promise<{ body: Ver; tag: string }> => {
  const r = await admin.api.call('get', `${BASE}/${v}`);
  expect(r.status).toBe(200);
  return { body: r.body, tag: etag(r) };
};
const today = async (): Promise<string> => (await db.query(`SELECT current_date::text AS d`)).rows[0].d as string;
const shift = async (d: string, n: number): Promise<string> => (await db.query(`SELECT ($1::date + $2::int)::text AS d`, [d, n])).rows[0].d as string;

describe('date_field gate condition, end to end', () => {
  it('refuses a bad reference or offset, then holds the gate until the date is set and opens it at the date plus the working-day offset', async () => {
    const v1 = await read(1);
    const g = v1.body.gates.find((x) => x.code === 'G2')!;
    expect(g).toBeTruthy();
    const bad = await admin.api.call('patch', `${BASE}/1/gates/G2`, { conditions: [{ type: 'date_field', ref: 'nonsense', offset_wd: 1 }], reason: REASON }, hdr(v1.tag));
    expect(bad.status).toBe(422);
    const bad2 = await admin.api.call('patch', `${BASE}/1/gates/G2`, { conditions: [{ type: 'date_field', ref: 'site.rf_survey_date', offset_wd: 999 }], reason: REASON }, hdr(v1.tag));
    expect(bad2.status).toBe(422);
    const ok = await admin.api.call('patch', `${BASE}/1/gates/G2`, { conditions: [{ type: 'date_field', ref: 'site.rf_survey_date', offset_wd: 2 }], reason: REASON }, hdr(v1.tag));
    expect(ok.status).toBe(200);
    expect(ok.body.conditions).toEqual([{ type: 'date_field', ref: 'site.rf_survey_date', offset_wd: 2 }]);

    const site = await makeSite(db, 5);
    const ms1 = await today();
    await makeTask(db, site, 'MS1', 'approved', { actualDate: ms1 });
    const ev = async (): Promise<{ status: string; gate_date: string | null; reasons: { kind: string; ref_code: string }[] }> =>
      (await db.query(`SELECT status, gate_date::text AS gate_date, reasons FROM gate_eval($1, 'G2')`, [site.id])).rows[0];
    const held = await ev();
    expect(held.status).toBe('blocked');
    expect(held.reasons[0]).toMatchObject({ kind: 'condition_not_met', ref_code: 'site.rf_survey_date' });

    const survey = await shift(ms1, 14);
    await db.query('UPDATE sites SET rf_survey_date = $2 WHERE id = $1', [site.id, survey]);
    const open = await ev();
    const expected = (await db.query(`SELECT cal_add_workdays($1::date, 2)::text AS d`, [survey])).rows[0].d as string;
    expect(open.status).toBe('open');
    expect(open.gate_date).toBe(expected);

    // a date custom field and a task date are read the same way
    await db.query(`UPDATE phase_gate_rules SET conditions = '[{"type":"date_field","ref":"site.custom.handover","offset_wd":0},{"type":"date_field","ref":"task:MS1.actual_date","offset_wd":-1}]'::jsonb WHERE link_code = 'G2' AND workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1)`);
    expect((await ev()).status).toBe('blocked');
    await db.query(`INSERT INTO field_definitions (entity_type, code, label_en, data_type) VALUES ('site', 'handover', 'Handover date', 'date') ON CONFLICT DO NOTHING`);
    const handover = await shift(ms1, 20);
    await db.query(`UPDATE sites SET custom = jsonb_build_object('handover', $2::text) WHERE id = $1`, [site.id, handover]);
    const open2 = await ev();
    expect(open2.status).toBe('open');
    expect(open2.gate_date).toBe(handover);
  });
});

describe('the closing task of a milestone', () => {
  let draft = 0;
  it('is chosen in a draft only, one per milestone, with admin, reason, If-Match and step-up', async () => {
    const created = await admin.api.call('post', BASE, { parent_version: 1, reason: REASON });
    expect(created.status).toBe(201);
    draft = created.body.version;
    const d = await read(draft);
    const ms = d.body.milestones[0]!.code;
    const rows = d.body.placements.filter((p) => p.stage_code === ms && p.is_active);
    const closing = rows.filter((p) => p.is_milestone_task);
    const other = rows.find((p) => !p.is_milestone_task)!;
    expect(closing.length).toBeGreaterThanOrEqual(1);
    const url = `${BASE}/${draft}/tasks/${other.task_code}/closing`;
    expect((await plain.api.call('put', url, { closing: true, reason: REASON }, hdr(d.tag))).status).toBe(403);
    expect((await admin.api.call('put', url, { closing: true, reason: REASON })).status).toBe(428);
    expect((await noStep.api.call('put', url, { closing: true, reason: REASON }, hdr(d.tag))).status).toBe(401);
    expect((await admin.api.call('put', `${BASE}/1/tasks/${other.task_code}/closing`, { closing: true, reason: REASON }, hdr((await read(1)).tag))).status).toBe(409);
    const r = await admin.api.call('put', url, { closing: true, reason: REASON }, hdr(d.tag));
    expect(r.status).toBe(200);
    const after = (r.body as Ver).placements.filter((p) => p.stage_code === ms && p.is_milestone_task).map((p) => p.task_code);
    expect(after).toEqual([other.task_code]);
    const audit = await db.query(`SELECT after FROM audit_log WHERE action = 'workflow_task_closing' AND entity_id = $1`, [other.task_code]);
    expect(audit.rows[0].after).toMatchObject({ closing: other.task_code });
    expect((await admin.api.call('put', url, { closing: true, reason: REASON }, hdr(etag(r)))).status).toBe(409); // nothing changes
    const clear = await admin.api.call('put', url, { closing: false, reason: REASON }, hdr(etag(r)));
    expect(clear.status).toBe(200);
    expect((clear.body as Ver).placements.filter((p) => p.stage_code === ms && p.is_milestone_task)).toHaveLength(0);
  });
});

describe('the structural freeze: set, guard, lift, set again', () => {
  let tag = '';
  it('is off by default and readable by anyone signed in', async () => {
    const r = await plain.api.call('get', '/settings/structural-freeze');
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(false);
    tag = etag(r);
  });

  it('sets the window with admin, reason, If-Match and step-up; a window that ends before it starts is refused', async () => {
    const from = await shift(await today(), -1);
    const to = await shift(await today(), 30);
    const body = { starts_on: from, ends_on: to, reason: REASON };
    expect((await plain.api.call('put', '/settings/structural-freeze', body, hdr(tag))).status).toBe(403);
    expect((await admin.api.call('put', '/settings/structural-freeze', body)).status).toBe(428);
    expect((await noStep.api.call('put', '/settings/structural-freeze', body, hdr(tag))).status).toBe(401);
    expect((await admin.api.call('put', '/settings/structural-freeze', { ...body, ends_on: await shift(from, -3) }, hdr(tag))).status).toBe(422);
    const r = await admin.api.call('put', '/settings/structural-freeze', body, hdr(tag));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: true, lifted: false, starts_on: from, ends_on: to });
    tag = etag(r);
  });

  it('stops publishing, replacing the structure, removing a milestone and choosing a closing task with 409 freeze_active, and allows light changes', async () => {
    const draft = (await admin.api.call('get', BASE)).body.items.find((v: { status: string }) => v.status === 'draft').version as number;
    const d = await read(draft);
    const ms = d.body.milestones[0]!.code;
    const task = d.body.placements.find((p) => p.stage_code === ms && p.is_active && !p.is_milestone_task)!.task_code;
    const code = async (r: Promise<{ status: number; body: { code?: string } }>): Promise<string> => { const x = await r; return `${x.status}:${x.body.code}`; };
    let t = d.tag;
    expect(await code(admin.api.call('put', `${BASE}/${draft}/tasks/${task}/closing`, { closing: true, reason: REASON }, hdr(t)))).toBe('409:freeze_active');
    expect(await code(admin.api.call('post', `${BASE}/${draft}/remove`, { kind: 'milestone', code: ms, reason: REASON }, hdr(t)))).toBe('409:freeze_active');
    expect(await code(admin.api.call('put', `${BASE}/${draft}`, { milestones: d.body.milestones.map((m) => ({ code: m.code })), gates: [], reason: REASON }, hdr(t)))).toBe('409:freeze_active');
    expect(await code(admin.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: `v${draft}` }, hdr(t)))).toBe('409:freeze_active');
    const light = await admin.api.call('patch', `${BASE}/${draft}/milestones/${ms}`, { name_en: 'Renamed while frozen', reason: REASON, confirm_master_impact: 'master-impact' }, hdr(t));
    expect(light.status, JSON.stringify(light.body)).toBe(200);
    t = etag(light);
    const added = await admin.api.call('post', `${BASE}/${draft}/tasks`, { stage_code: ms, code: 'ZFRZ1', name_en: 'New task inside a milestone', reason: REASON, confirm_master_impact: 'master-impact' }, hdr(t));
    expect(added.status).toBe(201);
  });

  it('is lifted by a System Admin only, with the typed confirmation, and is set again afterwards (re-lock)', async () => {
    const url = '/settings/structural-freeze/lift';
    expect((await plain.api.call('post', url, { reason: REASON, confirm_text: 'structural-freeze' }, hdr(tag))).status).toBe(403);
    const wrong = await admin.api.call('post', url, { reason: REASON, confirm_text: 'nope' }, hdr(tag));
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('confirmation_mismatch');
    expect((await noStep.api.call('post', url, { reason: REASON, confirm_text: 'structural-freeze' }, hdr(tag))).status).toBe(401);
    const r = await admin.api.call('post', url, { reason: REASON, confirm_text: 'structural-freeze' }, hdr(tag));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: false, lifted: true, lift_reason: REASON });
    tag = etag(r);
    expect((await admin.api.call('post', url, { reason: REASON, confirm_text: 'structural-freeze' }, hdr(tag))).status).toBe(409);
    // re-lock: the same PUT sets a new window and the freeze is active again
    const again = await admin.api.call('put', '/settings/structural-freeze', { starts_on: await today(), ends_on: await shift(await today(), 7), reason: REASON }, hdr(tag));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ active: true, lifted: false });
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_id = 'workflow.structural_freeze' ORDER BY at, id`);
    expect(audit.rows.map((x) => x.action)).toEqual(['structural_freeze_set', 'structural_freeze_lifted', 'structural_freeze_set']);
    // leave the workflow unfrozen for whatever runs after
    const last = await admin.api.call('post', url, { reason: REASON, confirm_text: 'structural-freeze' }, hdr(etag(again)));
    expect(last.status).toBe(200);
  });

  it('now publishes the draft (no freeze)', async () => {
    const draft = (await admin.api.call('get', BASE)).body.items.find((v: { status: string }) => v.status === 'draft').version as number;
    const d = await read(draft);
    const r = await admin.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: `v${draft}`, confirm_master_impact: 'master-impact' }, hdr(d.tag));
    expect(r.status).toBe(200);
  });
});
