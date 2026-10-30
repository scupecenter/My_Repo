import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allLocked, open, q, taskId, taskRow } from './calc-helpers';
import { makeTask } from './wf-helpers';
import { startApp, superDb } from './helpers';
import { GECOL, HLC, PERMIT_CW, PROC, G, Team, approveAll, createRec, otherSite, patch, post, recPath, regCell, team } from './reg-helpers';
import { actor, groupWith, makeSite, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0019: the register framework with Procurement, GECOL, HLC and Permits & HSE. Each describe builds its own site and holders in
 * regions 6 and 7 (no other suite writes register cells), so the suites can run in parallel on one database. Dates are fixed past dates:
 * nothing here depends on the weekday.
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const R = 7;

describe('catalogue and read access', () => {
  it('lists the enabled registers a caller may use, with their fields, and refuses a module the caller does not hold', async () => {
    const t = await team(app, db, 'gecol', 'gecol', R);
    const res = await t.entry.api.call('get', '/registers');
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: { register_key: string }) => i.register_key);
    expect(keys).toEqual(['gecol']);                                   // only the module the caller holds
    expect(res.body.items[0].approval_levels).toBe(3);
    expect(res.body.items[0].fields.map((f: { code: string }) => f.code)).toContain('power_on_date');
    const admin = await plainAdmin(app, db);
    const all = await admin.api.call('get', '/registers');
    expect(all.body.items.map((i: { register_key: string }) => i.register_key).sort()).toEqual(['gecol', 'hlc', 'permits_hse', 'procurement']);
    const permits = all.body.items.find((i: { register_key: string }) => i.register_key === 'permits_hse');
    expect(permits.fields.find((f: { code: string }) => f.code === 'permit_type').options.map((o: { value: string }) => o.value)).toContain('Access - CW');
    expect(permits.fields.find((f: { code: string }) => f.code === 'na_approved_by').read_only).toBe(true);
    // 0.4.6: the form section of each base field, from the field definitions
    expect(permits.fields.find((f: { code: string }) => f.code === 'valid_from').section).toBe('Validity');
    expect(all.body.items.find((i: { register_key: string }) => i.register_key === 'gecol').fields.find((f: { code: string }) => f.code === 'power_on_date').section).toBe('Meter and power-on');

    // permission denied: no grant on the module at all
    const nobody = await actor(app, db, { grants: G('gecol', 'view'), regions: [R], modules: null });
    const denied = await nobody.api.call('get', recPath('procurement'));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');
    expect((await nobody.api.call('get', recPath('quality'))).status).toBe(404);   // a register that is not enabled yet
    expect((await nobody.api.call('get', recPath('nope'))).status).toBe(404);
  });
});

describe('create and edit (entry ownership, validation, If-Match)', () => {
  it('creates a draft for an entry holder only, checks the grid right, the region and the data', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const res = await t.entry.api.call('post', recPath('procurement'), { site_id: t.site.id, record_type: 'pr', data: PROC });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: 'entry', current_level: 1, version: 1, version_no: 1, is_current: false, site_code: t.site.code, record_type: 'pr' });
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.allowed_actions).toEqual(expect.arrayContaining(['edit', 'submit']));
    expect(res.body.ball_in_court.level_kind).toBe('entry');
    // audit: the creation carries its after values
    const au = await q<{ after: { data: { pr_no: string } } }>(db, `SELECT after FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 AND action = 'register_record_create'`, [res.body.id]);
    expect(au[0]!.after.data.pr_no).toBe('PR-1001');
    // the approved typed table is untouched by a draft
    expect((await q(db, 'SELECT 1 FROM procurement_records WHERE site_id = $1', [t.site.id])).length).toBe(0);

    // permission denied: a holder of the review cell is not an entry holder (Q56 ownership)
    const reviewerRights = await actor(app, db, { grants: G('procurement', 'view', 'create', 'edit'), regions: [R], modules: null });
    const notOwner = await reviewerRights.api.call('post', recPath('procurement'), { site_id: t.site.id, data: PROC });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.code).toBe('not_eligible_holder');
    // permission denied: an entry holder of the matrix without the create right in the grid
    const viewOnly = await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null });
    await regCell(db, 'procurement', R, 'entry', { user: [t.entry.user.id, viewOnly.user.id] });
    const noGrant = await viewOnly.api.call('post', recPath('procurement'), { site_id: t.site.id, data: PROC });
    expect(noGrant.status).toBe(403);
    expect(noGrant.body.code).toBe('action_forbidden');
    await regCell(db, 'procurement', R, 'entry', { user: [t.entry.user.id] });
    // a site outside the caller's regions does not exist for the caller
    const other = await makeSite(db, 6, { prefix: 'REG' });
    expect((await t.entry.api.call('post', recPath('procurement'), { site_id: other.id, data: PROC })).status).toBe(404);
    expect((await t.entry.api.call('post', recPath('procurement'), { data: PROC })).status).toBe(422);   // a site is required
  });

  it('refuses another team\'s purchase request, unknown fields, bad dates and values outside a list (field-level errors)', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const codes = async (data: Record<string, unknown>): Promise<string[]> => {
      const r = await t.entry.api.call('post', recPath('procurement'), { site_id: t.site.id, data });
      expect(r.status).toBe(422);
      return r.body.errors.map((e: { code: string }) => e.code);
    };
    expect(await codes({ ...PROC, scope: 'GECOL' })).toEqual(['wrong_register']);      // Q56: the GECOL team enters it in the GECOL register
    expect(await codes({ ...PROC, scope: 'HLC' })).toEqual(['wrong_register']);
    expect(await codes({ colour: 'red' })).toEqual(['unknown_field']);
    expect(await codes({ pr_date: '2026-13-40' })).toEqual(['invalid_date']);
    expect(await codes({ pr_date: '2019-12-31' })).toEqual(['invalid_date']);
    expect(await codes({ pr_date: '2035-12-30' })).toEqual(['future_date']);             // an actual date cannot be in the future
    expect(await codes({ delivery: 'Magic' })).toEqual(['not_in_list']);
    const custom = await t.entry.api.call('post', recPath('procurement'), { site_id: t.site.id, data: PROC, custom: { not_defined: 1 } });
    expect(custom.status).toBe(422);
    expect(custom.body.errors[0].path).toBe('/custom/not_defined');
  });

  it('edits a draft with If-Match, clears a value with null, and refuses a non-holder and an edit outside entry', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const rec = await createRec(t, PROC);
    expect((await t.entry.api.call('patch', recPath('procurement', rec.id), { data: { remark: 'x' } })).status).toBe(428);
    const ok = await patch(t.entry.api, 'procurement', rec.id, 1, { data: { remark: 'first', pr_no: null } });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    expect(ok.body.data.remark).toBe('first');
    expect(ok.body.data.pr_no).toBeUndefined();
    expect((await patch(t.entry.api, 'procurement', rec.id, 1, { data: { remark: 'stale' } })).status).toBe(412);
    expect((await patch(t.entry.api, 'procurement', rec.id, 2, {})).status).toBe(422);
    const rights = await actor(app, db, { grants: G('procurement', 'view', 'create', 'edit'), regions: [R], modules: null });
    const denied = await patch(rights.api, 'procurement', rec.id, 2, { data: { remark: 'no' } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('not_eligible_holder');
    expect((await patch(t.review.api, 'procurement', rec.id, 2, { data: { remark: 'no' } })).body.code).toBe('action_forbidden');   // no edit right in the grid
    const noEdit = await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null });
    await regCell(db, 'procurement', R, 'entry', { user: [t.entry.user.id, noEdit.user.id] });
    const forbidden = await patch(noEdit.api, 'procurement', rec.id, 2, { data: { remark: 'no' } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('action_forbidden');
    await regCell(db, 'procurement', R, 'entry', { user: [t.entry.user.id] });
    const au = await q<{ before: { data: { remark?: string } }; after: { data: { remark?: string } } }>(
      db, `SELECT before, after FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 AND action = 'register_record_update'`, [rec.id]);
    expect(au[0]!.before.data.remark).toBeUndefined();
    expect(au[0]!.after.data.remark).toBe('first');
    // after the submission the record is no longer editable
    const sub = await post(t.entry.api, 'procurement', rec.id, 'submit', 2);
    expect(sub.status).toBe(200);
    const edit = await patch(t.entry.api, 'procurement', rec.id, sub.body.version, { data: { remark: 'late' } });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('invalid_transition');
  });
});

describe('submit validation (the register rules are blocking)', () => {
  it('lists every problem with its field, for each register', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const submitErrors = async (data: Record<string, unknown>): Promise<string[]> => {
      const rec = await createRec(t, data);
      const r = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('validation_failed');
      return r.body.errors.map((e: { code: string }) => e.code).sort();
    };
    expect(await submitErrors({ remark: 'empty' })).toEqual(['required', 'required']);                       // scope and order status
    expect(await submitErrors({ ...PROC, delivery: 'In-House' })).toEqual(['in_house_with_pr']);
    expect(await submitErrors({ ...PROC, po_wo_no: 'PO-1', po_wo_date: '2026-01-02' })).toEqual(['po_before_pr']);
    expect(await submitErrors({ scope: 'TE Installation', order_status: 'Open', pr_no: 'x' })).toEqual(['no_pr_po']);
    expect(await submitErrors({ scope: 'CW', order_status: 'Open', delivery: 'Outsourced', po_wo_no: 'PO-9' })).toEqual(['po_without_pr']);

    const g = await team(app, db, 'gecol', 'gecol', R);
    const rg = await createRec(g, { remark: 'only a remark' });
    const eg = await post(g.entry.api, 'gecol', rg.id, 'submit', rg.version);
    expect(eg.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['/data/pr_no', '/data/request_date']);
    const g2 = await otherSite(db, g);
    const rg2 = await createRec(g2, { ...GECOL, installation_finish: '2026-01-01' });
    const eg2 = await post(g.entry.api, 'gecol', rg2.id, 'submit', rg2.version);
    expect(eg2.body.errors.map((e: { code: string }) => e.code)).toEqual(['negative_duration']);               // finish before the request (DQ10)
    const h = await team(app, db, 'hlc', 'hlc', R);
    const rh = await createRec(h, { ...HLC, installation_date: '2026-02-10', tx_link_tested_date: '2026-02-01' });
    const eh = await post(h.entry.api, 'hlc', rh.id, 'submit', rh.version);
    expect(eh.body.errors.map((e: { code: string }) => e.code)).toEqual(['before_installation']);
  });

  it('refuses a GECOL or HLC record for a site whose scope says N/A (DQ07)', async () => {
    const g = await team(app, db, 'gecol', 'gecol', R);
    await db.query(`UPDATE sites SET scope_gecol_power = 'na' WHERE id = $1`, [g.site.id]);
    const r = await g.entry.api.call('post', recPath('gecol'), { site_id: g.site.id, data: GECOL });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].code).toBe('scope_conflict');
  });
});

describe('approval flow: 3 levels, projection, rejection, history', () => {
  it('goes entry -> review -> approve, projects the approved values and audits every step with before and after', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const rec = await createRec(t, { ...PROC, team_id: null });
    let res = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'in_review', current_level: 2, levels_required: 3 });
    expect(res.body.ball_in_court.level_kind).toBe('review');
    expect(res.body.ball_in_court.holders.map((h: { ref_id: string }) => h.ref_id)).toEqual([t.review.user.id]);
    expect(res.body.last_transition.skipped_levels).toEqual([]);
    expect((await q(db, 'SELECT 1 FROM procurement_records WHERE site_id = $1', [t.site.id])).length).toBe(0);   // not approved: nothing projected

    // the wrong person, the wrong action and the wrong state
    const wrong = await post(t.entry.api, 'procurement', rec.id, 'review', res.body.version);
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('not_eligible_holder');
    expect((await post(t.review.api, 'procurement', rec.id, 'approve', res.body.version)).status).toBe(409);
    expect((await post(t.review.api, 'procurement', rec.id, 'review', res.body.version - 1)).status).toBe(412);

    res = await post(t.review.api, 'procurement', rec.id, 'review', res.body.version);
    expect(res.body).toMatchObject({ state: 'in_approval', current_level: 3 });
    // permission denied: the reviewer has no approve right and is not the approve holder
    const reviewerApprove = await post(t.review.api, 'procurement', rec.id, 'approve', res.body.version);
    expect(reviewerApprove.status).toBe(403);
    // the final approval needs step-up
    const noStep = await actor(app, db, { level: 'approve', grants: G('procurement', 'view', 'approve'), regions: [R], modules: null, stepUp: false });
    await regCell(db, 'procurement', R, 'approve', { user: [noStep.user.id] });
    const needStep = await post(noStep.api, 'procurement', rec.id, 'approve', res.body.version);
    expect(needStep.status).toBe(401);
    expect(needStep.body.code).toBe('step_up_required');
    await regCell(db, 'procurement', R, 'approve', { user: [t.approve.user.id] });
    await t.approve.api.stepUp(t.approve.user.password);
    res = await post(t.approve.api, 'procurement', rec.id, 'approve', res.body.version);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'approved', is_current: true, self_approval: false });
    expect(res.body.approved_by.id).toBe(t.approve.user.id);
    expect(res.body.allowed_actions).not.toContain('approve');

    const typed = await q<Record<string, unknown>>(db, `SELECT scope, delivery, pr_no, pr_date::text AS pr_date, order_status, record_version, register_record_id::text AS rid, id::text AS id FROM procurement_records WHERE site_id = $1`, [t.site.id]);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ scope: 'CW', delivery: 'Outsourced', pr_no: 'PR-1001', pr_date: '2026-01-05', order_status: 'Open', record_version: 1, rid: rec.id, id: rec.entity_id });

    const hist = await t.review.api.call('get', recPath('procurement', rec.id, '/history'));
    expect(hist.body.items.map((s: { action: string }) => s.action)).toEqual(['create', 'submit', 'review', 'approve']);
    expect(hist.body.items[3]).toMatchObject({ stepup_verified: true, after_state: 'approved' });
    const audit = await q<{ action: string; before: { state: string }; after: { state: string } }>(
      db, `SELECT action, before, after FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 ORDER BY id`, [rec.id]);
    expect(audit.map((a) => a.action)).toEqual(['register_record_create', 'register_record_submit', 'register_record_review', 'register_record_approve']);
    expect(audit[3]!.before.state).toBe('in_approval');
    expect(audit[3]!.after.state).toBe('approved');
    // the History of a record outside the caller's regions does not exist
    const outsider = await actor(app, db, { grants: G('procurement', 'view'), regions: [6], modules: null });
    expect((await outsider.api.call('get', recPath('procurement', rec.id, '/history'))).status).toBe(404);
  });

  it('rejects one level back with a mandatory note, and the record comes back to the person who must fix it', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const rec = await createRec(t, PROC);
    let res = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
    res = await post(t.review.api, 'procurement', rec.id, 'review', res.body.version);
    const noNote = await post(t.approve.api, 'procurement', rec.id, 'reject', res.body.version, {});
    expect(noNote.status).toBe(422);
    expect(noNote.body.code).toBe('note_required');
    const notHolder = await post(t.entry.api, 'procurement', rec.id, 'reject', res.body.version, { note: 'x' });
    expect(notHolder.status).toBe(403);
    res = await post(t.approve.api, 'procurement', rec.id, 'reject', res.body.version, { note: 'PO number is missing' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'in_review', current_level: 2, return_count: 1, last_return_note: 'PO number is missing' });
    expect(res.body.last_transition.returned_to_level).toBe(2);
    res = await post(t.review.api, 'procurement', rec.id, 'reject', res.body.version, { note: 'wrong scope' });
    expect(res.body).toMatchObject({ state: 'entry', current_level: 1, return_count: 2 });
    const fixed = await patch(t.entry.api, 'procurement', rec.id, res.body.version, { data: { remark: 'fixed' } });
    expect(fixed.status).toBe(200);
    res = await post(t.entry.api, 'procurement', rec.id, 'submit', fixed.body.version);
    expect(res.body.state).toBe('in_review');
    const hist = await t.entry.api.call('get', recPath('procurement', rec.id, '/history'));
    expect(hist.body.items.map((s: { action: string }) => s.action)).toEqual(['create', 'submit', 'review', 'reject', 'reject', 'edit', 'submit']);
    expect(hist.body.items[3].note).toBe('PO number is missing');
  });
});

describe('levels of the register row: skip (B6), self-approval (B5), 2 levels', () => {
  it('skips a level held by the same person, logs it, and a rejection after the skip returns to the person who acted', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    await regCell(db, 'procurement', R, 'review', { user: [t.entry.user.id] });   // the entry holder also holds the review level
    const rec = await createRec(t, PROC);
    let res = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
    expect(res.body).toMatchObject({ state: 'in_approval', current_level: 3 });
    expect(res.body.last_transition.skipped_levels).toEqual([2]);
    expect(res.body.self_approval).toBe(false);
    res = await post(t.approve.api, 'procurement', rec.id, 'reject', res.body.version, { note: 'check the PR date' });
    expect(res.body).toMatchObject({ state: 'entry', current_level: 1 });                                   // not to the skipped level
    expect(res.body.ball_in_court.claimed_by.id).toBe(t.entry.user.id);
    expect(res.body.last_transition.returned_to_level).toBe(1);
    res = await post(t.entry.api, 'procurement', rec.id, 'submit', res.body.version);
    expect(res.body.last_transition.skipped_levels).toEqual([2]);                                           // applied again on resubmission
    const hist = await t.entry.api.call('get', recPath('procurement', rec.id, '/history'));
    expect(hist.body.items.filter((s: { action: string }) => s.action === 'auto_skip')).toHaveLength(2);
    const audit = await q(db, `SELECT 1 FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 AND action = 'register_record_auto_skip'`, [rec.id]);
    expect(audit).toHaveLength(2);
  });

  it('uses the level count of the row: 2 levels skip the review cell, 1 level is a self-approval that needs step-up', async () => {
    const t = await team(app, db, 'permits_hse', 'permits_hse', R);
    await db.query(`UPDATE register_definitions SET approval_levels = 2 WHERE register_key = 'permits_hse'`);
    try {
      const rec = await createRec(t, PERMIT_CW);
      let res = await post(t.entry.api, 'permits_hse', rec.id, 'submit', rec.version);
      expect(res.body).toMatchObject({ state: 'in_approval', current_level: 2, levels_required: 2 });
      await t.approve.api.stepUp(t.approve.user.password);
      res = await post(t.approve.api, 'permits_hse', rec.id, 'approve', res.body.version);
      expect(res.body).toMatchObject({ state: 'approved' });

      await db.query(`UPDATE register_definitions SET approval_levels = 1 WHERE register_key = 'permits_hse'`);
      const solo = await actor(app, db, { level: 'approve', grants: G('permits_hse', 'view', 'create', 'edit', 'approve'), regions: [R], modules: null, stepUp: false });
      await regCell(db, 'permits_hse', R, 'entry', { user: [solo.user.id] });
      const rec2 = await createRec({ ...t, entry: solo }, { ...PERMIT_CW, permit_type: 'Access - TE' });
      const noStep = await post(solo.api, 'permits_hse', rec2.id, 'submit', rec2.version);
      expect(noStep.status).toBe(401);
      expect(noStep.body.code).toBe('step_up_required');
      await solo.api.stepUp(solo.user.password);
      const done = await post(solo.api, 'permits_hse', rec2.id, 'submit', rec2.version);
      expect(done.body).toMatchObject({ state: 'approved', self_approval: true, levels_required: 1 });
      const hist = await solo.api.call('get', recPath('permits_hse', rec2.id, '/history'));
      expect(hist.body.items.find((s: { action: string }) => s.action === 'submit')).toMatchObject({ self_approval: true, stepup_verified: true });
    } finally {
      await db.query(`UPDATE register_definitions SET approval_levels = 3 WHERE register_key = 'permits_hse'`);
    }
  });

  it('freezes the level path at the first submission (B7): a later change of the row applies to new records only', async () => {
    const t = await team(app, db, 'hlc', 'hlc', R);
    const rec = await createRec(t, HLC);
    let res = await post(t.entry.api, 'hlc', rec.id, 'submit', rec.version);
    expect(res.body.levels_required).toBe(3);
    await db.query(`UPDATE register_definitions SET approval_levels = 2 WHERE register_key = 'hlc'`);
    try {
      res = await post(t.review.api, 'hlc', rec.id, 'review', res.body.version);
      expect(res.body).toMatchObject({ state: 'in_approval', levels_required: 3 });
      const fresh = await createRec(await otherSite(db, t), { ...HLC, request_no: 'HR-2' });
      expect((await t.entry.api.call('get', recPath('hlc', fresh.id))).body.levels_required).toBe(2);
    } finally {
      await db.query(`UPDATE register_definitions SET approval_levels = 3 WHERE register_key = 'hlc'`);
    }
  });
});

describe('group levels: claim, release, all members, no holder (B10)', () => {
  it('pins a record to the first member of a group, lets them release it and another claim it', async () => {
    const t = await team(app, db, 'gecol', 'gecol', R);
    const m1 = await actor(app, db, { level: 'entry', grants: G('gecol', 'view', 'create', 'edit'), regions: [R], modules: null });
    const m2 = await actor(app, db, { level: 'entry', grants: G('gecol', 'view', 'create', 'edit'), regions: [R], modules: null });
    const g = await groupWith(db, [m1.user.id, m2.user.id]);
    await regCell(db, 'gecol', R, 'entry', { group: [g] });
    const rec = await createRec({ ...t, entry: m1 }, GECOL);
    expect(rec.ball_in_court.claimed_by.id).toBe(m1.user.id);                       // the first action claims
    const blocked = await patch(m2.api, 'gecol', rec.id, rec.version, { data: { remark: 'mine' } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('already_claimed');
    expect(blocked.body.claimed_by.id).toBe(m1.user.id);
    expect((await post(m2.api, 'gecol', rec.id, 'release', rec.version)).status).toBe(403);   // only the claimant releases
    const rel = await post(m1.api, 'gecol', rec.id, 'release', rec.version);
    expect(rel.status).toBe(200);
    expect(rel.body.ball_in_court.claimed_by).toBeUndefined();
    const claim = await post(m2.api, 'gecol', rec.id, 'claim', rel.body.version);
    expect(claim.status).toBe(200);
    expect(claim.body.ball_in_court.claimed_by.id).toBe(m2.user.id);
    expect((await post(m1.api, 'gecol', rec.id, 'claim', claim.body.version)).body.code).toBe('already_claimed');
    expect((await post(m2.api, 'gecol', rec.id, 'claim', claim.body.version)).status).toBe(409);   // already holds it
    const outsider = await actor(app, db, { level: 'entry', grants: G('gecol', 'view', 'edit'), regions: [R], modules: null });
    expect((await post(outsider.api, 'gecol', rec.id, 'claim', claim.body.version)).body.code).toBe('not_eligible_holder');
  });

  it('needs every member of an all-members level, and sends the System Admins the records nobody can act on', async () => {
    const t = await team(app, db, 'hlc', 'hlc', R);
    const a = await actor(app, db, { level: 'review', grants: G('hlc', 'view'), regions: [R], modules: null });
    const b = await actor(app, db, { level: 'review', grants: G('hlc', 'view'), regions: [R], modules: null });
    await regCell(db, 'hlc', R, 'review', { group: [await groupWith(db, [a.user.id, b.user.id])] }, 'all_members');
    const rec = await createRec(t, HLC);
    let res = await post(t.entry.api, 'hlc', rec.id, 'submit', rec.version);
    expect(res.body.ball_in_court).toMatchObject({ rule: 'all_members', votes_needed: 2, votes_done: 0 });
    res = await post(a.api, 'hlc', rec.id, 'review', res.body.version);
    expect(res.body.state).toBe('in_review');
    expect(res.body.last_transition.votes_missing).toBe(1);
    expect((await post(a.api, 'hlc', rec.id, 'review', res.body.version)).status).toBe(409);   // already voted
    res = await post(b.api, 'hlc', rec.id, 'review', res.body.version);
    expect(res.body.state).toBe('in_approval');

    // B10: a level with nobody goes to the System Admins and is never skipped
    const rec2 = await createRec(await otherSite(db, t), { ...HLC, request_no: 'HR-3' });
    await regCell(db, 'hlc', R, 'review', {});
    const sub = await post(t.entry.api, 'hlc', rec2.id, 'submit', rec2.version);
    expect(sub.body.state).toBe('in_review');
    expect(sub.body.ball_in_court.no_eligible_holder).toBe(true);
    expect((await post(t.review.api, 'hlc', rec2.id, 'review', sub.body.version)).status).toBe(403);
    const n = await q(db, `SELECT 1 FROM notifications WHERE kind = 'no_eligible_holder' AND link = $1`, [`/registers/hlc/records/${rec2.id}`]);
    expect(n.length).toBeGreaterThan(0);
    const admin = await plainAdmin(app, db);
    const done = await post(admin.api, 'hlc', rec2.id, 'review', sub.body.version);
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('in_approval');
  });
});

describe('Q43: a record that is the source of a task is approved with the task\'s stage row', () => {
  /** Region R: register row holders R1/A1 (review, approve of the register) and stage holders for the task cells. */
  async function withTasks(t: Team, codes: string[], opened: string[]): Promise<{ stageReview: Awaited<ReturnType<typeof actor>>; stageApprove: Awaited<ReturnType<typeof actor>> }> {
    await allLocked(db, t.site);
    // Site Release dated, so gate G2 is open and its stage's tasks may unlock (Q81: a closed gate keeps them locked)
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = DATE '2025-12-01' WHERE id = $1`, [await taskId(db, t.site, 'MS1')]);
    for (const c of opened) await open(db, await taskId(db, t.site, c));
    const stageReview = await actor(app, db, { level: 'review', grants: G(t.key, 'view'), regions: [t.region], modules: null });
    const stageApprove = await actor(app, db, { level: 'approve', grants: G(t.key, 'view', 'approve'), regions: [t.region], modules: null });
    for (const c of codes) {
      await setCell(db, c, t.region, 'review', { user: [stageReview.user.id] });
      await setCell(db, c, t.region, 'approve', { user: [stageApprove.user.id] });
    }
    return { stageReview, stageApprove };
  }

  it('closes B1 and B2 with the first CW order (stage row), fills the dates, unlocks the successors; the next order uses the register row', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const { stageReview, stageApprove } = await withTasks(t, ['B1', 'B2'], ['B1']);
    const rec = await createRec(t, PROC);
    let res = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
    expect(res.status).toBe(200);
    expect(res.body.task.task_code).toBe('B1');
    expect(res.body.state).toBe('in_review');
    // the register row's reviewer does not hold the stage row's review cell
    const wrong = await post(t.review.api, 'procurement', rec.id, 'review', res.body.version);
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('not_eligible_holder');
    expect(res.body.ball_in_court.holders.map((h: { ref_id: string }) => h.ref_id)).toEqual([stageReview.user.id]);
    res = await post(stageReview.api, 'procurement', rec.id, 'review', res.body.version);
    expect(res.body.state).toBe('in_approval');
    await stageApprove.api.stepUp(stageApprove.user.password);
    res = await post(stageApprove.api, 'procurement', rec.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect(res.body.last_transition.unlocked_task_ids.length).toBeGreaterThan(0);

    const b1 = await taskRow(db, t.site, 'B1');
    expect(b1).toMatchObject({ state: 'approved', actual_date: '2026-01-05' });
    expect((await taskRow(db, t.site, 'B2')).state).toBe('open');                         // the successor unlocked
    const step = await q<{ note: string; acted_by: string }>(db, `SELECT note, acted_by::text AS acted_by FROM workflow_steps WHERE task_id = $1 AND action = 'approve'`, [await taskId(db, t.site, 'B1')]);
    expect(step[0]!.note).toContain(rec.id);
    expect(step[0]!.acted_by).toBe(stageApprove.user.id);
    const taskAudit = await q(db, `SELECT 1 FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 AND action = 'task_approve'`, [await taskId(db, t.site, 'B1')]);
    expect(taskAudit).toHaveLength(1);

    // a new version with the PO / WO date is the source of B2
    const v2 = await post(t.entry.api, 'procurement', rec.id, 'versions', res.body.version);
    expect(v2.status).toBe(201);
    const v2b = await patch(t.entry.api, 'procurement', v2.body.id, v2.body.version, { data: { po_wo_no: 'PO-77', po_wo_date: '2026-01-20' } });
    res = await post(t.entry.api, 'procurement', v2.body.id, 'submit', v2b.body.version);
    expect(res.body.task.task_code).toBe('B2');
    res = await post(stageReview.api, 'procurement', v2.body.id, 'review', res.body.version);
    res = await post(stageApprove.api, 'procurement', v2.body.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect(await taskRow(db, t.site, 'B2')).toMatchObject({ state: 'approved', actual_date: '2026-01-20' });
    expect(res.body.is_current).toBe(true);
    const typed = await q<{ po_wo_no: string; record_version: number }>(db, 'SELECT po_wo_no, record_version FROM procurement_records WHERE id = $1', [rec.entity_id]);
    expect(typed[0]).toMatchObject({ po_wo_no: 'PO-77', record_version: 2 });

    // a second CW order finds B1 and B2 closed: not a source, approved by the register row's holders
    const second = await createRec(t, { ...PROC, pr_no: 'PR-2002', pr_date: '2026-02-02' });
    res = await post(t.entry.api, 'procurement', second.id, 'submit', second.version);
    expect(res.body.task).toBeUndefined();
    expect(res.body.ball_in_court.holders.map((h: { ref_id: string }) => h.ref_id)).toEqual([t.review.user.id]);
    res = await post(t.review.api, 'procurement', second.id, 'review', res.body.version);
    res = await post(t.approve.api, 'procurement', second.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect((await taskRow(db, t.site, 'B1')).actual_date).toBe('2026-01-05');             // the task keeps its first date
  });

  const unlinked = (id: string): Promise<{ id: string }[]> =>
    q<{ id: string }>(db, `SELECT id::text AS id FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 AND action = 'register_record_task_unlinked'`, [id]);
  const linkOf = async (id: string): Promise<string | null> => (await q<{ t: string | null }>(db, 'SELECT task_id::text AS t FROM register_records WHERE id = $1', [id]))[0]!.t;

  it('drops the task link when an edit after a rejection no longer matches the task source: the record is approved on the register row, the task stays open', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const { stageReview } = await withTasks(t, ['B1'], ['B1']);
    const rec = await createRec(t, PROC);
    let res = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
    expect(res.body.task.task_code).toBe('B1');
    expect(await linkOf(rec.id)).not.toBeNull();
    res = await post(stageReview.api, 'procurement', rec.id, 'reject', res.body.version, { note: 'wrong scope' });
    expect(res.body.state).toBe('entry');
    // the scope no longer says CW / Tower Erection / Site Adaption: STA is not a source of B1
    const fixed = await patch(t.entry.api, 'procurement', rec.id, res.body.version, { data: { scope: 'STA' } });
    expect(fixed.status).toBe(200);
    res = await post(t.entry.api, 'procurement', rec.id, 'submit', fixed.body.version);
    expect(res.status).toBe(200);
    expect(res.body.task).toBeUndefined();
    expect(await linkOf(rec.id)).toBeNull();
    expect(await unlinked(rec.id)).toHaveLength(1);
    // the register row's holders decide now, not the stage row's
    expect((await post(stageReview.api, 'procurement', rec.id, 'review', res.body.version)).status).toBe(403);
    res = await post(t.review.api, 'procurement', rec.id, 'review', res.body.version);
    res = await post(t.approve.api, 'procurement', rec.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect(res.body.last_transition.unlocked_task_ids).toEqual([]);
    expect(await taskRow(db, t.site, 'B1')).toMatchObject({ state: 'open', actual_date: null });
    expect((await q<{ scope: string }>(db, 'SELECT scope FROM procurement_records WHERE id = $1', [rec.entity_id]))[0]!.scope).toBe('STA');
  });

  it('re-checks the match just before the task is closed: data that changed, or a source date that is gone, leaves the task open and the record approved', async () => {
    for (const change of [`data = data || '{"scope": "STA"}'::jsonb`, `data = data - 'pr_date'`]) {
      const t = await team(app, db, 'procurement', 'procurement', R);
      const { stageReview, stageApprove } = await withTasks(t, ['B1'], ['B1']);
      const rec = await createRec(t, PROC);
      let res = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
      expect(res.body.task.task_code).toBe('B1');
      res = await post(stageReview.api, 'procurement', rec.id, 'review', res.body.version);
      expect(res.body.state).toBe('in_approval');
      // the data changes behind the workflow (a direct correction by the database administrator)
      await db.query(`UPDATE register_records SET ${change} WHERE id = $1`, [rec.id]);
      await stageApprove.api.stepUp(stageApprove.user.password);
      res = await post(stageApprove.api, 'procurement', rec.id, 'approve', res.body.version);
      expect(res.status, change).toBe(200);
      expect(res.body.state).toBe('approved');
      expect(res.body.last_transition.unlocked_task_ids).toEqual([]);
      expect(await taskRow(db, t.site, 'B1')).toMatchObject({ state: 'open', actual_date: null });
      expect(await linkOf(rec.id)).toBeNull();
      expect(await unlinked(rec.id)).toHaveLength(1);
      expect(await q(db, `SELECT 1 FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 AND action = 'task_approve'`, [await taskId(db, t.site, 'B1')])).toHaveLength(0);
    }
  });

  it('refuses a future source date: at submit when a task is linked, and again when the task is closed (422 future_date)', async () => {
    const t = await team(app, db, 'permits_hse', 'permits_hse', R);
    const { stageReview, stageApprove } = await withTasks(t, ['B3'], ['B3']);
    // Valid From is not an actual date field of the register, but it is the date of task B3 now
    const rec = await createRec(t, { ...PERMIT_CW, valid_from: '2035-06-01', valid_to: '2035-12-31' });
    const early = await post(t.entry.api, 'permits_hse', rec.id, 'submit', rec.version);
    expect(early.status).toBe(422);
    expect(early.body.errors[0]).toMatchObject({ path: '/data/valid_from', code: 'future_date' });
    expect(await linkOf(rec.id)).toBeNull();
    expect((await taskRow(db, t.site, 'B3')).state).toBe('open');

    // a past date goes through; the date moves into the future behind the workflow: the approval is refused and nothing changes
    const ok = await patch(t.entry.api, 'permits_hse', rec.id, early.body.version ?? rec.version, { data: { valid_from: '2025-12-01' } });
    expect(ok.status).toBe(200);
    let res = await post(t.entry.api, 'permits_hse', rec.id, 'submit', ok.body.version);
    expect(res.body.task.task_code).toBe('B3');
    res = await post(stageReview.api, 'permits_hse', rec.id, 'review', res.body.version);
    await db.query(`UPDATE register_records SET data = data || '{"valid_from": "2035-06-01"}'::jsonb WHERE id = $1`, [rec.id]);
    await stageApprove.api.stepUp(stageApprove.user.password);
    const late = await post(stageApprove.api, 'permits_hse', rec.id, 'approve', res.body.version);
    expect(late.status).toBe(422);
    expect(late.body.errors[0]).toMatchObject({ path: '/data/valid_from', code: 'future_date' });
    expect((await q<{ state: string }>(db, 'SELECT state FROM register_records WHERE id = $1', [rec.id]))[0]!.state).toBe('in_approval');
    expect(await taskRow(db, t.site, 'B3')).toMatchObject({ state: 'open', actual_date: null });
    expect(await q(db, 'SELECT 1 FROM permit_records WHERE id = $1', [rec.entity_id])).toHaveLength(0);   // the whole approval rolled back
  });

  it('refuses a submission whose task is still locked, and needs the task\'s mandatory document slots', async () => {
    const t = await team(app, db, 'permits_hse', 'permits_hse', R);
    const { stageReview, stageApprove } = await withTasks(t, ['D1'], []);                    // D1 stays locked
    const rec = await createRec(t, { ...PERMIT_CW, permit_type: 'Access - TE' });
    const locked = await post(t.entry.api, 'permits_hse', rec.id, 'submit', rec.version);
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('invalid_transition');
    expect(locked.body.detail).toContain('D1');

    await open(db, await taskId(db, t.site, 'D1'));
    const dt = await db.query(`INSERT INTO document_types (code, name_en, updated_at) VALUES ($1, 'Test access doc', now()) RETURNING id, code`, [`REGD${Date.now() % 100000}`]);
    const td = await db.query(`SELECT td.id FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = 'D1'`);
    await db.query(`INSERT INTO document_type_placements (doc_type_id, kind, task_def_id) VALUES ($1, 'task', $2)`, [dt.rows[0].id, td.rows[0].id]);
    try {
      const missing = await post(t.entry.api, 'permits_hse', rec.id, 'submit', rec.version);
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('mandatory_slots_missing');
      expect(missing.body.missing).toEqual([dt.rows[0].code]);
      const tid = await taskId(db, t.site, 'D1');
      await db.query(`INSERT INTO document_slots (task_id, site_id, region_id, doc_type_id, status) VALUES ($1, $2, $3, $4, 'uploaded')`, [tid, t.site.id, t.region, dt.rows[0].id]);
      let res = await post(t.entry.api, 'permits_hse', rec.id, 'submit', rec.version);
      expect(res.status).toBe(200);
      expect((await q<{ status: string }>(db, 'SELECT status::text AS status FROM document_slots WHERE task_id = $1', [tid]))[0]!.status).toBe('in_review');
      res = await post(stageReview.api, 'permits_hse', rec.id, 'review', res.body.version);
      await stageApprove.api.stepUp(stageApprove.user.password);
      res = await post(stageApprove.api, 'permits_hse', rec.id, 'approve', res.body.version);
      expect(res.body.state).toBe('approved');
      expect(await taskRow(db, t.site, 'D1')).toMatchObject({ state: 'approved', actual_date: '2025-12-01' });
      expect((await q<{ status: string }>(db, 'SELECT status::text AS status FROM document_slots WHERE task_id = $1', [tid]))[0]!.status).toBe('approved');
    } finally {
      await db.query('DELETE FROM document_slots WHERE doc_type_id = $1', [dt.rows[0].id]);
      await db.query('DELETE FROM document_type_placements WHERE doc_type_id = $1', [dt.rows[0].id]);
    }
  });

  it('closes B3 with the first approved Access - CW permit; a renewal is a record only (Q57)', async () => {
    const t = await team(app, db, 'permits_hse', 'permits_hse', R);
    const { stageReview, stageApprove } = await withTasks(t, ['B3'], ['B3']);
    // a permit that is only applied for is not yet the source of B3
    const applied = await createRec(t, { permit_type: 'Access - CW', status: 'Applied', applied_date: '2025-11-20' });
    let res = await post(t.entry.api, 'permits_hse', applied.id, 'submit', applied.version);
    expect(res.body.task).toBeUndefined();
    res = await post(t.review.api, 'permits_hse', applied.id, 'review', res.body.version);
    await t.approve.api.stepUp(t.approve.user.password);
    res = await post(t.approve.api, 'permits_hse', applied.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect((await taskRow(db, t.site, 'B3')).state).toBe('open');

    // the approved version is the source of B3 (Master AL = Valid From)
    const v2 = await post(t.entry.api, 'permits_hse', applied.id, 'versions', res.body.version);
    const v2b = await patch(t.entry.api, 'permits_hse', v2.body.id, v2.body.version, { data: { status: 'Approved', valid_from: '2025-12-01', valid_to: '2030-12-31' } });
    res = await post(t.entry.api, 'permits_hse', v2.body.id, 'submit', v2b.body.version);
    expect(res.body.task.task_code).toBe('B3');
    res = await post(stageReview.api, 'permits_hse', v2.body.id, 'review', res.body.version);
    await stageApprove.api.stepUp(stageApprove.user.password);
    res = await post(stageApprove.api, 'permits_hse', v2.body.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect(await taskRow(db, t.site, 'B3')).toMatchObject({ state: 'approved', actual_date: '2025-12-01' });

    // the renewal (a new version with a later expiry): approved by the register row, B3 keeps its first date
    const v3 = await post(t.entry.api, 'permits_hse', v2.body.id, 'versions', res.body.version);
    const v3b = await patch(t.entry.api, 'permits_hse', v3.body.id, v3.body.version, { data: { valid_from: '2026-06-01', valid_to: '2031-12-31' } });
    res = await post(t.entry.api, 'permits_hse', v3.body.id, 'submit', v3b.body.version);
    expect(res.body.task).toBeUndefined();
    res = await post(t.review.api, 'permits_hse', v3.body.id, 'review', res.body.version);
    res = await post(t.approve.api, 'permits_hse', v3.body.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect((await taskRow(db, t.site, 'B3')).actual_date).toBe('2025-12-01');
    const permit = await q<{ valid_to: string; record_version: number }>(db, 'SELECT valid_to::text AS valid_to, record_version FROM permit_records WHERE id = $1', [applied.entity_id]);
    expect(permit[0]).toMatchObject({ valid_to: '2031-12-31', record_version: 3 });
  });

  it('closes C2 on the GECOL Power-On date and C4 on the HLC TX Link Tested date', async () => {
    const g = await team(app, db, 'gecol', 'gecol', R);
    const gs = await withTasks(g, ['C2'], ['C2']);
    const rec = await createRec(g, { ...GECOL, installation_finish: '2026-02-01' });
    let res = await approveAll(g, rec.id, rec.version);                                     // request only: the register row approves
    expect(res.task).toBeUndefined();
    expect((await taskRow(db, g.site, 'C2')).state).toBe('open');
    const v2 = await post(g.entry.api, 'gecol', rec.id, 'versions', res.version);
    const v2b = await patch(g.entry.api, 'gecol', v2.body.id, v2.body.version, { data: { meter_no: 'M-1', power_on_date: '2026-03-03' } });
    res = (await post(g.entry.api, 'gecol', v2.body.id, 'submit', v2b.body.version)).body;
    expect(res.task.task_code).toBe('C2');
    res = (await post(gs.stageReview.api, 'gecol', v2.body.id, 'review', res.version)).body;
    await gs.stageApprove.api.stepUp(gs.stageApprove.user.password);
    res = (await post(gs.stageApprove.api, 'gecol', v2.body.id, 'approve', res.version)).body;
    expect(res.state).toBe('approved');
    expect(await taskRow(db, g.site, 'C2')).toMatchObject({ state: 'approved', actual_date: '2026-03-03' });

    const h = await team(app, db, 'hlc', 'hlc', R);
    const hs = await withTasks(h, ['C4'], ['C4']);
    const hrec = await createRec(h, { ...HLC, installation_date: '2026-02-10', tx_link_tested_date: '2026-02-15' });
    let hr = (await post(h.entry.api, 'hlc', hrec.id, 'submit', hrec.version)).body;
    expect(hr.task.task_code).toBe('C4');
    hr = (await post(hs.stageReview.api, 'hlc', hrec.id, 'review', hr.version)).body;
    await hs.stageApprove.api.stepUp(hs.stageApprove.user.password);
    hr = (await post(hs.stageApprove.api, 'hlc', hrec.id, 'approve', hr.version)).body;
    expect(hr.state).toBe('approved');
    expect(await taskRow(db, h.site, 'C4')).toMatchObject({ state: 'approved', actual_date: '2026-02-15' });
  });
});

describe('GECOL and HLC: one logical record per site, new requests are versions (Q55, Q56)', () => {
  it('refuses a second record for the site, versions the first, keeps the approved one in force until the new one is approved', async () => {
    const t = await team(app, db, 'gecol', 'gecol', R);
    const rec = await createRec(t, GECOL);
    const dup = await t.entry.api.call('post', recPath('gecol'), { site_id: t.site.id, data: GECOL });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate');
    expect(dup.body.existing_id).toBe(rec.id);
    const early = await post(t.entry.api, 'gecol', rec.id, 'versions', rec.version);
    expect(early.status).toBe(409);                                                          // only an approved record gets a new version

    const approved = await approveAll(t, rec.id, rec.version);
    expect(approved.is_current).toBe(true);
    const edit = await patch(t.entry.api, 'gecol', rec.id, approved.version, { data: { remark: 'x' } });
    expect(edit.status).toBe(409);                                                           // an approved record is changed by a new version
    expect((await t.entry.api.call('get', recPath('gecol', rec.id))).body.allowed_actions).toContain('new_version');
    const noRight = await post(t.review.api, 'gecol', rec.id, 'versions', approved.version);
    expect(noRight.status).toBe(403);

    const v2 = await post(t.entry.api, 'gecol', rec.id, 'versions', approved.version);
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version_no: 2, supersedes_id: rec.id, state: 'entry', entity_id: rec.entity_id, is_current: false });
    expect(v2.body.data.pr_no).toBe('GP-1');
    expect((await post(t.entry.api, 'gecol', rec.id, 'versions', approved.version)).status).toBe(409);   // an open version exists
    const v2b = await patch(t.entry.api, 'gecol', v2.body.id, v2.body.version, { data: { pr_no: 'GP-2', request_date: '2026-04-01' } });
    expect((await q<{ pr_no: string }>(db, 'SELECT pr_no FROM gecol_records WHERE site_id = $1', [t.site.id]))[0]!.pr_no).toBe('GP-1');   // the approved version stays in force

    const list = await t.entry.api.call('get', recPath('gecol') + `?site_id=${t.site.id}`);
    expect(list.body.items.map((i: { version_no: number }) => i.version_no)).toEqual([2]);       // the latest version of the logical record
    const all = await t.entry.api.call('get', recPath('gecol') + `?site_id=${t.site.id}&all_versions=true`);
    expect(all.body.items.map((i: { version_no: number }) => i.version_no).sort()).toEqual([1, 2]);
    const versions = await t.entry.api.call('get', recPath('gecol', v2.body.id, '/versions'));
    expect(versions.body.items.map((i: { version_no: number }) => i.version_no)).toEqual([2, 1]);

    await approveAll(t, v2.body.id, v2b.body.version);
    const typed = await q<{ pr_no: string; record_version: number }>(db, 'SELECT pr_no, record_version FROM gecol_records WHERE site_id = $1', [t.site.id]);
    expect(typed).toEqual([{ pr_no: 'GP-2', record_version: 2 }]);                                // still one row per site
    const cur = await q<{ version_no: number }>(db, 'SELECT version_no FROM register_records WHERE entity_id = $1 AND is_current', [rec.entity_id]);
    expect(cur).toEqual([{ version_no: 2 }]);

    // the GECOL and HLC requests count as purchase requests (Q56)
    const h = await team(app, db, 'hlc', 'hlc', R);
    await approveAll(h, (await createRec(h, HLC)).id, 1);
    const prs = await q<{ register_key: string }>(db, `SELECT register_key FROM v_purchase_requests WHERE site_id = ANY($1::uuid[]) ORDER BY register_key`, [[t.site.id, h.site.id]]);
    expect(prs.map((p) => p.register_key)).toEqual(['gecol', 'hlc']);
  });

  it('frees the slot of a site when the first version is voided, and lets only a holder of delete (with step-up) void', async () => {
    const t = await team(app, db, 'hlc', 'hlc', R);
    const rec = await createRec(t, HLC);
    const noDelete = await post(t.entry.api, 'hlc', rec.id, 'void', rec.version, { reason: 'wrong site' });
    expect(noDelete.status).toBe(403);
    const admin = await plainAdmin(app, db);
    expect((await post(admin.api, 'hlc', rec.id, 'void', rec.version, {})).status).toBe(422);        // a reason is needed
    const voided = await post(admin.api, 'hlc', rec.id, 'void', rec.version, { reason: 'wrong site' });
    expect(voided.status).toBe(200);
    expect(voided.body.state).toBe('voided');
    expect((await createRec(t, HLC)).state).toBe('entry');                                           // the site can have a request again
    const second = await t.entry.api.call('post', recPath('hlc'), { site_id: t.site.id, data: { ...HLC, request_no: 'HR-9' } });
    expect(second.status).toBe(409);                                                                 // but only one open request
    const other = await team(app, db, 'hlc', 'hlc', R);
    const ap = await approveAll(other, (await createRec(other, HLC)).id, 1);
    expect((await post(admin.api, 'hlc', ap.id, 'void', ap.version, { reason: 'too late' })).status).toBe(409);   // an approved record is corrected by a version
  });
});

describe('Permits & HSE: expiry choice, N/A, stop work, approver from the approval (Q45, Q57, Q63c)', () => {
  const submitCodes = async (t: Team, data: Record<string, unknown>): Promise<string[]> => {
    const rec = await createRec(t, data);
    const r = await post(t.entry.api, 'permits_hse', rec.id, 'submit', rec.version);
    expect(r.status).toBe(422);
    return r.body.errors.map((e: { code: string }) => e.code).sort();
  };

  it('applies the expiry choice, N/A reason, PTW-only fields and date order', async () => {
    const t = await team(app, db, 'permits_hse', 'permits_hse', R);
    expect(await submitCodes(t, { permit_type: 'Access - CW', status: 'Approved', valid_from: '2025-12-01' })).toEqual(['required']);       // the type expires: Valid To needed
    expect(await submitCodes(t, { permit_type: 'Civil Aviation Authority Permit', status: 'Approved', valid_from: '2025-12-01', valid_to: '2030-01-01' })).toEqual(['permanent']);
    expect(await submitCodes(t, { permit_type: 'Access - CW', status: 'Approved', has_expiry: false, valid_from: '2025-12-01', valid_to: '2030-01-01' })).toEqual(['permanent']);
    expect(await submitCodes(t, { permit_type: 'Access - CW', status: 'Approved', valid_from: '2026-05-01', valid_to: '2026-04-01' })).toEqual(['before_valid_from']);
    expect(await submitCodes(t, { permit_type: 'Access - CW', status: 'N/A' })).toEqual(['required']);
    expect(await submitCodes(t, { permit_type: 'Access - CW', status: 'Applied', na_reason: 'x' })).toEqual(['not_applicable']);
    expect(await submitCodes(t, { permit_type: 'Access - CW', status: 'Applied', stop_work: true, loto: 'Done' })).toEqual(['ptw_only', 'ptw_only']);
    expect(await submitCodes(t, { permit_type: 'PTW - CW', status: 'Applied', stop_lifted_date: '2026-01-02' })).toEqual(['no_stop_work']);
    const permanent = await createRec(t, { permit_type: 'Civil Aviation Authority Permit', status: 'Approved', valid_from: '2025-12-01' });
    const res = await approveAll(t, permanent.id, permanent.version);
    expect(res.state).toBe('approved');
    const typed = await q<{ has_expiry: boolean; valid_to: string | null }>(db, 'SELECT has_expiry, valid_to::text AS valid_to FROM permit_records WHERE id = $1', [permanent.entity_id]);
    expect(typed[0]).toEqual({ has_expiry: false, valid_to: null });                                  // the type gives the default of the choice
  });

  it('fills the N/A approver from the final approval, never from the form', async () => {
    const t = await team(app, db, 'permits_hse', 'permits_hse', R);
    const typed = await t.entry.api.call('post', recPath('permits_hse'), { site_id: t.site.id, data: { permit_type: 'Access - Survey', status: 'N/A', na_reason: 'no survey needed', na_approved_by: 'Me' } });
    expect(typed.status).toBe(422);
    expect(typed.body.errors[0].code).toBe('field_read_only');
    const rec = await createRec(t, { permit_type: 'Access - Survey', status: 'N/A', na_reason: 'no survey needed' });
    const res = await approveAll(t, rec.id, rec.version);
    expect(res.data.na_approved_by).toBe(t.approve.user.name);
    const row = await q<{ na_approved_by: string; status: string }>(db, 'SELECT na_approved_by, status FROM permit_records WHERE id = $1', [rec.entity_id]);
    expect(row[0]).toEqual({ na_approved_by: t.approve.user.name, status: 'N/A' });
  });

  it('keeps gate_eval working: only approved permits count, and a stop work holds the gate until its lift is approved', async () => {
    const t = await team(app, db, 'permits_hse', 'permits_hse', R);
    const site = t.site;
    await makeTask(db, site, 'MS2', 'approved', { actualDate: '2026-01-04' });
    await makeTask(db, site, 'B10', 'approved', { actualDate: '2026-01-04' });
    await makeTask(db, site, 'B11', 'approved', { actualDate: '2026-01-04' });
    await open(db, await makeTask(db, site, 'MS3', 'locked'));
    const gate = async (): Promise<{ status: string; reasons: { ref_code: string | null }[] }> =>
      (await q<{ status: string; reasons: { ref_code: string | null }[] }>(db, `SELECT status, reasons FROM gate_eval($1, 'G3')`, [site.id]))[0]!;
    const refs = async (): Promise<(string | null)[]> => (await gate()).reasons.map((r) => r.ref_code).sort();

    const access = await createRec(t, PERMIT_CW);
    expect(await refs()).toEqual(['Access - CW', 'PTW - CW']);                                         // a draft counts for nothing
    await post(t.entry.api, 'permits_hse', access.id, 'submit', access.version);
    expect(await refs()).toEqual(['Access - CW', 'PTW - CW']);                                         // nor a record in review
    const cur = await t.entry.api.call('get', recPath('permits_hse', access.id));
    let res = await post(t.review.api, 'permits_hse', access.id, 'review', cur.body.version);
    await t.approve.api.stepUp(t.approve.user.password);
    res = await post(t.approve.api, 'permits_hse', access.id, 'approve', res.body.version);
    expect(res.body.state).toBe('approved');
    expect(await refs()).toEqual(['PTW - CW']);                                                        // approved: counted

    const ptw = await createRec(t, { permit_type: 'PTW - CW', status: 'Approved', valid_from: '2025-12-01', valid_to: '2034-12-31', stop_work: true });
    const ptwDone = await approveAll(t, ptw.id, ptw.version);
    expect(await refs()).toContain('PTW - CW');                                                        // stop work, no lift: the gate stays held
    expect((await gate()).status).not.toBe('open');
    const v2 = await post(t.entry.api, 'permits_hse', ptw.id, 'versions', ptwDone.version);
    const v2b = await patch(t.entry.api, 'permits_hse', v2.body.id, v2.body.version, { data: { stop_lifted_date: '2026-01-02' } });
    await approveAll(t, v2.body.id, v2b.body.version);
    expect(await refs()).toEqual([]);
    expect((await gate()).status).toBe('open');
  });
});

describe('region scope (B3) and rows without a site (Q69)', () => {
  it('shows a record only to people who hold the module in its region', async () => {
    const t7 = await team(app, db, 'procurement', 'procurement', 7);
    const t6 = await team(app, db, 'procurement', 'procurement', 6);
    const r7 = await createRec(t7, PROC);
    const r6 = await createRec(t6, { ...PROC, pr_no: 'PR-6' });
    // team() writes the cells of the region it is called for: both regions have their own holders now
    const list7 = await t7.entry.api.call('get', recPath('procurement'));
    expect(list7.body.items.map((i: { id: string }) => i.id)).toContain(r7.id);
    expect(list7.body.items.map((i: { id: string }) => i.id)).not.toContain(r6.id);
    expect(list7.body.items.every((i: { region_id: number }) => i.region_id === 7)).toBe(true);
    expect((await t7.entry.api.call('get', recPath('procurement', r6.id))).status).toBe(404);
    expect((await t7.entry.api.call('get', recPath('procurement') + '?region_id=6')).body.items).toEqual([]);
    expect((await t7.entry.api.call('get', recPath('procurement') + `?site_id=${t6.site.id}`)).body.items).toEqual([]);
    expect((await post(t7.entry.api, 'procurement', r6.id, 'submit', r6.version)).status).toBe(404);
    expect((await patch(t7.entry.api, 'procurement', r6.id, r6.version, { data: { remark: 'x' } })).status).toBe(404);
    // scopes never cross: procurement in region 7 plus gecol in region 6 shows no procurement in region 6
    const mixed = await actor(app, db, { grants: [...G('procurement', 'view')], regions: [7], modules: null });
    await mixed.api.call('get', recPath('procurement'));
    expect((await mixed.api.call('get', recPath('procurement', r6.id))).status).toBe(404);
    const admin = await plainAdmin(app, db);
    const both = await admin.api.call('get', recPath('procurement') + '?limit=200');
    expect(both.body.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([r7.id, r6.id]));
    const filtered = await admin.api.call('get', recPath('procurement') + '?q=PR-6&state=entry');
    expect(filtered.body.items.map((i: { id: string }) => i.id)).toContain(r6.id);
    expect(filtered.body.items.map((i: { id: string }) => i.id)).not.toContain(r7.id);
    expect((await admin.api.call('get', recPath('procurement') + '?state=bogus')).status).toBe(422);
    const page = await admin.api.call('get', recPath('procurement') + '?limit=1');
    expect(page.body.page.next_cursor).not.toBeNull();
    const next = await admin.api.call('get', recPath('procurement') + `?limit=1&cursor=${page.body.page.next_cursor}`);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
  });

  it('lets a row without a site be seen by anyone who holds the module, whatever their regions (framework, Q69)', async () => {
    // no enabled register is global yet: the database rule is tested directly with a global row and a region-limited session
    const reg = await db.query(`SELECT 1 FROM register_definitions WHERE register_key = 'risks'`);
    expect(reg.rowCount).toBe(1);
    await db.query(`UPDATE register_definitions SET enabled = true WHERE register_key = 'risks'`);
    try {
      const u = await actor(app, db, { level: 'entry', grants: G('risks', 'view', 'create'), regions: [6], modules: null });
      // migration 0020 seeds a global entry cell for this row (the Matrix suite reads it): add the holder to it and take only that holder away again
      const existed = await q<{ id: string }>(db, `SELECT id FROM matrix_cells WHERE register_key = 'risks' AND level = 1 AND region_id IS NULL`);
      if (existed.length === 0) await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('risks', 1, 'any_one', NULL, true, now())`);
      const cell = await q<{ id: string }>(db, `SELECT id FROM matrix_cells WHERE register_key = 'risks' AND level = 1 AND region_id IS NULL`);
      await db.query('INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, $2::"AssigneeKind", $3)', [cell[0]!.id, 'user', u.user.id]);
      const made = await u.api.call('post', recPath('risks'), { data: {} });
      expect(made.status).toBe(201);
      expect(made.body.region_id).toBeNull();
      const other = await actor(app, db, { grants: G('risks', 'view'), regions: [1], modules: null });
      expect((await other.api.call('get', recPath('risks', made.body.id))).status).toBe(200);
      const nobody = await actor(app, db, { grants: G('procurement', 'view'), regions: [1], modules: null });
      expect((await nobody.api.call('get', recPath('risks', made.body.id))).status).toBe(403);
      await db.query('DELETE FROM matrix_cell_assignees WHERE cell_id = $1 AND kind = $2::"AssigneeKind" AND ref_id = $3', [cell[0]!.id, 'user', u.user.id]);
      if (existed.length === 0) await db.query(`DELETE FROM matrix_cells WHERE id = $1`, [cell[0]!.id]);
    } finally {
      await db.query(`UPDATE register_definitions SET enabled = false WHERE register_key = 'risks'`);
    }
  });
});

describe('the database refuses every write that does not come from a reg_* function', () => {
  it('denies direct writes and the internal functions to the application role, and filters reads by region', async () => {
    const t = await team(app, db, 'procurement', 'procurement', R);
    const rec = await createRec(t, PROC);
    await approveAll(t, rec.id, rec.version);
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await appDb.connect();
    try {
      const refused = async (sql: string): Promise<string> => {
        try {
          await appDb.query(sql);
          return 'allowed';
        } catch (e) {
          return (e as { code?: string }).code ?? 'error';
        }
      };
      expect(await refused(`INSERT INTO register_records (entity_id, register_key, site_id, region_id) VALUES (gen_random_uuid(), 'procurement', '${t.site.id}', ${R})`)).toBe('42501');
      expect(await refused(`UPDATE register_records SET state = 'approved' WHERE id = '${rec.id}'`)).toBe('42501');
      expect(await refused(`DELETE FROM register_steps WHERE record_id = '${rec.id}'`)).toBe('42501');
      expect(await refused(`UPDATE procurement_records SET order_status = 'Hacked' WHERE site_id = '${t.site.id}'`)).toBe('42501');
      expect(await refused(`UPDATE permit_records SET status = 'Approved'`)).toBe('42501');
      expect(await refused(`DELETE FROM gecol_records`)).toBe('42501');
      expect(await refused(`UPDATE register_fields SET required = false`)).toBe('42501');
      expect(await refused(`SELECT reg_apply('${rec.id}')`)).toBe('42501');
      expect(await refused(`SELECT reg_complete('${rec.id}', NULL, 'approve', NULL, true)`)).toBe('42501');
      // without a signed-in actor the writers refuse
      expect(await refused(`SELECT reg_save_record('procurement', NULL, NULL, '${t.site.id}', NULL, '{}', NULL, NULL, false)`)).not.toBe('allowed');
      // row level security: a session limited to region 6 sees nothing of region 7
      await appDb.query('BEGIN');
      await appDb.query(`SELECT set_config('app.region_ids', '6', true)`);
      const seen = await appDb.query(`SELECT count(*)::int AS n FROM register_records WHERE site_id = '${t.site.id}'`);
      const seenTyped = await appDb.query(`SELECT count(*)::int AS n FROM procurement_records WHERE site_id = '${t.site.id}'`);
      await appDb.query('ROLLBACK');
      expect(seen.rows[0].n).toBe(0);
      expect(seenTyped.rows[0].n).toBe(0);
    } finally {
      await appDb.end();
    }
  });
});
