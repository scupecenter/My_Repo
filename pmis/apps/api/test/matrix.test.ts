import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, adminApi, delegate, loggedIn, makeAdmin, makeRole, makeUser, startApp, superDb, superDbCalc } from './helpers';
import { Actor, actor, etag, groupWith, makeSite, makeTask } from './wf-helpers';

/**
 * The Responsibility Matrix API (P1-BE-12): read shape, self-skip and self-approval preview, edit with step-up, If-Match, reason and audit,
 * empty_cell, the effect of a level-count change on tasks not yet submitted and on tasks in flight (B7), permissions per write.
 * No test depends on the weekday: dates are fixed past dates and the day count is never asserted.
 * Each test works on its own matrix row (a register row, or stage MS9 whose tasks no other suite uses), so parallel suites do not meet.
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  // MS9 is changed by the B7 test: leave it as the seed has it
  await db.query(`UPDATE stage_definitions SET approval_levels = 3 WHERE code = 'MS9'`);
  await db.end();
  await app.close();
});

interface Cell { id: string; level: number; level_kind: string; used: boolean; region_id: number | null; task_code: string | null; rule: string; assignees: { kind: string; ref_id: string; label: string; employee_id: string | null; member_count?: number }[]; skip_preview: { id: string }[] }
interface Row { kind: string; code: string; register_key: string | null; approval_levels: number; used_levels: number[]; region_ids_with_cells: number[]; cells: Cell[]; task_counts?: { not_submitted: number; in_flight: number }; preview: { single_level: boolean; skips: { user: { id: string }; from_level_kind: string; skipped_level_kinds: string[]; self_approval: boolean; region_ids: number[]; task_code: string | null }[] } }
interface MatrixBody { workflow_version: number; version: number; stages: Row[] }

const REGISTER_CODES = ['procurement', 'contractors', 'rf_design', 'acquisition', 'gecol', 'hlc', 'permits_hse', 'warehouse', 'quality', 'issues', 'risks', 'change_control',
  'readiness_handover', 'as_built', 'meetings', 'deliverables'];
/** Built in migration 0019: the registers suite owns their level count and region cells (it changes them while this suite runs), and Q90 leaves their Review and Approve empty. */
const BUILT = ['procurement', 'gecol', 'hlc', 'permits_hse'];
const NOT_BUILT = [...REGISTER_CODES.filter((c) => !BUILT.includes(c)), 'dismantle'];

const getMatrix = (api: Api, qs = '') => api.call('get', `/matrix${qs}`);
const rowOf = (m: MatrixBody, code: string): Row => m.stages.find((r) => r.code === code) as Row;
const patchMatrix = (api: Api, tag: string, body: unknown) => api.call('patch', '/matrix', body, { 'If-Match': tag });
const cellOf = (m: MatrixBody, code: string, level: number): Cell => rowOf(m, code).cells.find((c) => c.level === level && c.task_code === null && c.region_id === null) as Cell;
const userHolder = (id: string) => ({ kind: 'user', ref_id: id });
const holders = (...ids: string[]) => ids.map(userHolder);

/** A person who may act as a holder (active, assigned to every region and module). */
const person = (): Promise<{ id: string; name: string; employeeId: string }> => makeUser(db, { assigned: true });

/** A signed-in person with a delegation for the matrix (create, edit, delete), for all regions or the given ones. */
async function delegateOf(regions?: number[], stepUp = true): Promise<Api> {
  const u = await makeUser(db, { assigned: true });
  await delegate(db, u.id, [['matrix', 'create'], ['matrix', 'edit'], ['matrix', 'delete']], regions);
  const api = await loggedIn(app, u);
  if (stepUp) await api.stepUp(u.password);
  return api;
}

describe('GET /matrix', () => {
  it('returns one row per stage, one per register and Dismantle, each with its cells, level count, holders and preview', async () => {
    const { api } = await adminApi(app, db);
    const res = await getMatrix(api);
    expect(res.status).toBe(200);
    expect(etag(res)).toMatch(/^"\d+"$/);
    const m = res.body as MatrixBody;
    expect(etag(res)).toBe(`"${m.version}"`);
    expect(m.workflow_version).toBe(1);

    const codes = m.stages.map((r) => r.code);
    expect(codes.slice(0, 10)).toEqual(['MS1', 'MS2', 'MS3', 'MS4', 'MS5', 'MS6', 'MS7', 'MS8', 'MS9', 'MS10']);
    expect(codes.slice(10)).toEqual([...REGISTER_CODES, 'dismantle']);
    expect(m.stages.slice(0, 10).every((r) => r.kind === 'stage' && r.register_key === null)).toBe(true);
    expect(m.stages.slice(10, 26).every((r) => r.kind === 'register' && r.register_key === r.code)).toBe(true);
    expect(rowOf(m, 'dismantle')).toMatchObject({ kind: 'dismantle', register_key: 'dismantle' });

    for (const r of m.stages) {
      expect(r.approval_levels).toBeGreaterThanOrEqual(1);
      expect(r.approval_levels).toBeLessThanOrEqual(3);
      expect(r.used_levels).toEqual(r.approval_levels === 1 ? [1] : r.approval_levels === 2 ? [1, 3] : [1, 2, 3]);
      expect(Array.isArray(r.cells)).toBe(true);
      expect(Array.isArray(r.region_ids_with_cells)).toBe(true);
      expect(typeof r.preview.single_level).toBe('boolean');
      expect(Array.isArray(r.preview.skips)).toBe(true);
      expect(r.task_counts !== undefined).toBe(r.kind === 'stage');
    }
    // every register row that is not built yet, and Dismantle, has Entry, Review and Approve with at least one holder, rule any_one
    for (const code of NOT_BUILT) {
      const row = rowOf(m, code);
      expect(row.approval_levels).toBe(3);
      for (const level of [1, 2, 3]) {
        const c = cellOf(m, code, level);
        expect(c, `${code} level ${level}`).toBeTruthy();
        expect(c.level_kind).toBe(['entry', 'review', 'approve'][level - 1]);
        expect(c.used).toBe(true);
        expect(c.rule).toBe('any_one');
        expect(c.assignees.length).toBeGreaterThan(0);
      }
    }
    // Q44: RF & Design and Acquisition take the stage-1 holders
    for (const code of ['rf_design', 'acquisition']) {
      expect(cellOf(m, code, 1).assignees.map((a) => a.label).sort()).toEqual(['Acquisition Team', 'MW Engineer', 'RF Engineer']);
      expect(cellOf(m, code, 2).assignees.map((a) => a.label)).toEqual(['RF & Design / Acquisition Team Lead']);
      expect(cellOf(m, code, 3).assignees.map((a) => a.label)).toEqual(['RF & Design / Acquisition Team Lead']);
    }
    const role = cellOf(m, 'rf_design', 1).assignees[0]!;
    expect(role).toMatchObject({ kind: 'role', employee_id: null });
    expect(typeof role.member_count).toBe('number');
  });

  it('shows the four registers of migration 0019 as they are: Q56 entry cells for Procurement, GECOL and HLC, nothing else seeded (Q90)', async () => {
    const { api } = await adminApi(app, db);
    const m = (await getMatrix(api)).body as MatrixBody;
    for (const [code, role] of [['procurement', 'Project Procurement Team'], ['gecol', 'GECOL Power Team'], ['hlc', 'HLC Fiber Team']] as const) {
      expect(cellOf(m, code, 1).assignees.map((a) => a.label), code).toEqual([role]);
      expect(cellOf(m, code, 2), code).toBeUndefined();
      expect(cellOf(m, code, 3), code).toBeUndefined();
    }
    for (const level of [1, 2, 3]) expect(cellOf(m, 'permits_hse', level)).toBeUndefined();
    for (const code of BUILT) expect(rowOf(m, code)).toMatchObject({ kind: 'register', register_key: code });
  });

  it('one model: the level count and the cells the Matrix saves are the ones the register engine (reg_*) reads', async () => {
    const { api } = await adminApi(app, db);
    const u = await person();
    const v = await person();
    const m0 = await getMatrix(api);
    // a register row that is not built: its level count lives in register_definitions.approval_levels, the same column reg_levels_live reads
    const res = await patchMatrix(api, etag(m0), {
      reason: 'Warehouse has two levels',
      stage_levels: [{ stage_code: 'warehouse', approval_levels: 2 }],
      cells: [{ stage_code: 'warehouse', level: 3, region_id: 5, rule: 'any_one', assignees: holders(u.id) }],
    });
    expect(res.status).toBe(200);
    const def = await db.query(`SELECT approval_levels FROM register_definitions WHERE register_key = 'warehouse'`);
    expect(def.rows[0].approval_levels).toBe(2);
    expect(await db.query(`SELECT to_regclass('matrix_rows') AS t`).then((r) => r.rows[0].t)).toBeNull();
    // the cell of Approve (cell level 3) of a two-level row is what reg_cell_row returns for that region and kind
    const cell = rowOf((await getMatrix(api, '?region_id=5')).body, 'warehouse').cells.find((c) => c.level === 3 && c.region_id === 5)!;
    const eng = await db.query(`SELECT reg_cell_row('warehouse', 5, 'approve') AS id, reg_cell_row('warehouse', 1, 'approve') AS other, reg_cell_row('warehouse', 5, 'entry') AS entry`);
    expect(eng.rows[0].id).toBe(cell.id);
    expect(eng.rows[0].other).toBe(cellOf(res.body, 'warehouse', 3).id);
    expect(eng.rows[0].entry).toBe(cellOf(res.body, 'warehouse', 1).id);

    // a built register: one cell alone is refused (Review and Approve are in use and empty), all three levels in one save are accepted
    const tag = etag(res);
    const one = await patchMatrix(api, tag, { reason: 'Only the entry holder', cells: [{ stage_code: 'permits_hse', level: 1, rule: 'any_one', assignees: holders(u.id) }] });
    expect(one.status).toBe(422);
    expect(one.body.code).toBe('empty_cell');
    expect(one.body.cells.map((c: { level: number }) => c.level)).toEqual([2, 3]);
    try {
      const all = await patchMatrix(api, tag, {
        reason: 'Permits and HSE holders',
        cells: [1, 2, 3].map((level) => ({ stage_code: 'permits_hse', level, rule: 'any_one', assignees: holders(level === 1 ? u.id : v.id) })),
      });
      expect(all.status).toBe(200);
      const read = await db.query(`SELECT level, reg_cell_row('permits_hse', NULL, CASE level WHEN 1 THEN 'entry' WHEN 2 THEN 'review' ELSE 'approve' END) = id AS same
        FROM matrix_cells WHERE register_key = 'permits_hse' AND region_id IS NULL ORDER BY level`);
      expect(read.rows).toEqual([{ level: 1, same: true }, { level: 2, same: true }, { level: 3, same: true }]);
    } finally {
      await db.query(`DELETE FROM matrix_cells WHERE register_key = 'permits_hse'`);
    }
  });

  it('names user holders with their employee ID and groups with their member count', async () => {
    const { api } = await adminApi(app, db);
    const u = await person();
    const v = await person();
    const g = await groupWith(db, [u.id, v.id]);
    const tag = etag(await getMatrix(api));
    const res = await patchMatrix(api, tag, {
      reason: 'Holders with names',
      cells: [{ stage_code: 'deliverables', level: 1, rule: 'any_one', assignees: [userHolder(u.id), { kind: 'group', ref_id: g }] }],
    });
    expect(res.status).toBe(200);
    const c = cellOf(res.body, 'deliverables', 1);
    const user = c.assignees.find((a) => a.kind === 'user')!;
    expect(user).toMatchObject({ ref_id: u.id, label: u.name, employee_id: u.employeeId, user_id: u.id, account_status: 'active' });
    expect(c.assignees.find((a) => a.kind === 'group')).toMatchObject({ ref_id: g, member_count: 2 });
  });

  it('refuses a missing session, an unknown workflow version and a bad parameter; a Team Lead style viewer may read', async () => {
    expect((await getMatrix(new Api(app))).status).toBe(401);
    const { api } = await adminApi(app, db);
    expect((await getMatrix(api, '?workflow_version=999')).status).toBe(404);
    const bad = await getMatrix(api, '?workflow_version=abc');
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].path).toBe('/workflow_version');
    expect((await getMatrix(api, '?region_id=99')).status).toBe(422);
    expect((await getMatrix(api, '?workflow_version=1&region_id=5')).status).toBe(200);

    const viewer = await actor(app, db, { grants: [['admin.matrix', 'view']] });
    expect((await getMatrix(viewer.api)).status).toBe(200);
    const nobody = await actor(app, db, { grants: [['sites', 'view']] });
    const denied = await getMatrix(nobody.api);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');
  });

  it('shows region-specific cells only for the region asked, and lists the regions that have their own cells', async () => {
    const { api } = await adminApi(app, db);
    const u = await person();
    const m0 = await getMatrix(api);
    const res = await patchMatrix(api, etag(m0), {
      reason: 'Benghazi has its own entry holder',
      cells: [{ stage_code: 'issues', level: 1, region_id: 5, rule: 'any_one', assignees: holders(u.id) }],
    });
    expect(res.status).toBe(200);
    expect(rowOf(res.body, 'issues').region_ids_with_cells).toContain(5);
    expect(rowOf(res.body, 'issues').cells.some((c) => c.region_id === 5)).toBe(false);

    const withRegion = (await getMatrix(api, '?region_id=5')).body as MatrixBody;
    const regional = rowOf(withRegion, 'issues').cells.find((c) => c.region_id === 5)!;
    expect(regional.assignees.map((a) => a.ref_id)).toEqual([u.id]);
    // the row default still comes first, so a screen that takes the first cell of a level shows the default
    expect(rowOf(withRegion, 'issues').cells.findIndex((c) => c.level === 1 && c.region_id === null)).toBeLessThan(rowOf(withRegion, 'issues').cells.findIndex((c) => c.region_id === 5));
    const other = (await getMatrix(api, '?region_id=1')).body as MatrixBody;
    expect(rowOf(other, 'issues').cells.some((c) => c.region_id === 5)).toBe(false);
    // the row of Benghazi's holder is hidden from someone who sees Tripoli only
    const tripoli = await actor(app, db, { grants: [['admin.matrix', 'view']], regions: [1] });
    const seen = (await getMatrix(tripoli.api, '?region_id=5')).body as MatrixBody;
    expect(rowOf(seen, 'issues').cells.some((c) => c.region_id === 5)).toBe(false);
    expect(rowOf(seen, 'issues').region_ids_with_cells).not.toContain(5);
  });
});

describe('self-skip and self-approval preview (B5, B6)', () => {
  it('shows who holds consecutive levels, whether it reaches the last level, and follows the rule all_members', async () => {
    const { api } = await adminApi(app, db);
    const u1 = await person();
    const u2 = await person();
    const u3 = await person();
    const m0 = await getMatrix(api);
    // contractors: entry U1, review U1 and U2, approve U1  -> U1 skips review and approve at entry (self-approval), approve at review (self-approval)
    let res = await patchMatrix(api, etag(m0), {
      reason: 'Preview scenario one',
      cells: [
        { stage_code: 'contractors', level: 1, rule: 'any_one', assignees: holders(u1.id) },
        { stage_code: 'contractors', level: 2, rule: 'any_one', assignees: holders(u1.id, u2.id) },
        { stage_code: 'contractors', level: 3, rule: 'any_one', assignees: holders(u1.id) },
      ],
    });
    expect(res.status).toBe(200);
    let row = rowOf(res.body, 'contractors');
    const mine = row.preview.skips.filter((s) => s.user.id === u1.id);
    expect(mine.map((s) => `${s.from_level_kind}>${s.skipped_level_kinds.join('+')}:${s.self_approval}`).sort()).toEqual(['entry>review+approve:true', 'review>approve:true']);
    expect(row.preview.skips.some((s) => s.user.id === u2.id)).toBe(false);
    expect(mine[0]!.region_ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(cellOf(res.body, 'contractors', 1).skip_preview.map((u) => u.id)).toEqual([u1.id]);
    expect(cellOf(res.body, 'contractors', 3).skip_preview).toEqual([]);

    // the review level needs all members: nobody skips it any more, so the entry case is gone; at review, U1 still skips the approve level
    res = await patchMatrix(api, etag(res), {
      reason: 'Preview scenario one, all members',
      cells: [{ stage_code: 'contractors', level: 2, rule: 'all_members', assignees: holders(u1.id, u2.id) }],
    });
    expect(res.status).toBe(200);
    row = rowOf(res.body, 'contractors');
    expect(row.preview.skips.filter((s) => s.user.id === u1.id).map((s) => s.from_level_kind)).toEqual(['review']);

    // acquisition, two levels: entry U1, approve U1 and U3 -> a self-approval at once
    res = await patchMatrix(api, etag(res), {
      reason: 'Preview scenario two',
      stage_levels: [{ stage_code: 'acquisition', approval_levels: 2 }],
      cells: [
        { stage_code: 'acquisition', level: 1, rule: 'any_one', assignees: holders(u1.id) },
        { stage_code: 'acquisition', level: 3, rule: 'any_one', assignees: holders(u1.id, u3.id) },
      ],
    });
    expect(res.status).toBe(200);
    row = rowOf(res.body, 'acquisition');
    expect(row.preview.skips.map((s) => `${s.user.id === u1.id}:${s.from_level_kind}>${s.skipped_level_kinds}:${s.self_approval}`)).toEqual(['true:entry>approve:true']);

    // a skip that is not a self-approval: entry and review U1, approve U2
    res = await patchMatrix(api, etag(res), {
      reason: 'Preview scenario three',
      cells: [
        { stage_code: 'as_built', level: 1, rule: 'any_one', assignees: holders(u1.id) },
        { stage_code: 'as_built', level: 2, rule: 'any_one', assignees: holders(u1.id) },
        { stage_code: 'as_built', level: 3, rule: 'any_one', assignees: holders(u2.id) },
      ],
    });
    row = rowOf(res.body, 'as_built');
    expect(row.preview.skips).toHaveLength(1);
    expect(row.preview.skips[0]).toMatchObject({ from_level_kind: 'entry', skipped_level_kinds: ['review'], self_approval: false });

    // one level: every submission by the entry holders is a self-approval (B5)
    res = await patchMatrix(api, etag(res), { reason: 'Preview scenario four', stage_levels: [{ stage_code: 'meetings', approval_levels: 1 }] });
    expect(res.status).toBe(200);
    expect(rowOf(res.body, 'meetings').preview.single_level).toBe(true);
    expect(rowOf(res.body, 'meetings').used_levels).toEqual([1]);
    expect(rowOf(res.body, 'meetings').cells.find((c) => c.level === 3)!.used).toBe(false);
    expect(rowOf(res.body, 'contractors').preview.single_level).toBe(false);
  });

  it('sees the people behind a group and a role, like the engine does', async () => {
    const { api } = await adminApi(app, db);
    const u1 = await person();
    const g = await groupWith(db, [u1.id]);
    const role = await makeRole(db);
    await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'review', true, true)`, [u1.id, role]);
    const res = await patchMatrix(api, etag(await getMatrix(api)), {
      reason: 'Groups and roles',
      cells: [
        { stage_code: 'quality', level: 1, rule: 'any_one', assignees: holders(u1.id) },
        { stage_code: 'quality', level: 2, rule: 'any_one', assignees: [{ kind: 'group', ref_id: g }] },
        { stage_code: 'quality', level: 3, rule: 'any_one', assignees: [{ kind: 'role', ref_id: role }] },
      ],
    });
    expect(res.status).toBe(200);
    // U1 is in the group and holds the role with review level only: the role gives no approve right, so the chain stops before approve
    const s = rowOf(res.body, 'quality').preview.skips.filter((x) => x.user.id === u1.id);
    expect(s.map((x) => `${x.from_level_kind}>${x.skipped_level_kinds}:${x.self_approval}`)).toEqual(['entry>review:false']);
    await db.query(`UPDATE user_role_assignments SET permission_level = 'approve' WHERE user_id = $1 AND role_id = $2`, [u1.id, role]);
    const again = (await getMatrix(api)).body as MatrixBody;
    expect(rowOf(again, 'quality').preview.skips.filter((x) => x.user.id === u1.id).map((x) => `${x.from_level_kind}>${x.skipped_level_kinds}:${x.self_approval}`).sort())
      .toEqual(['entry>review,approve:true', 'review>approve:true']);
  });
});

describe('PATCH /matrix', () => {
  it('needs step-up, If-Match and a reason; saves holders, rule and level count; audits before and after; raises the ETag', async () => {
    const adminNoStep = await makeAdmin(db);
    const noStepApi = await loggedIn(app, adminNoStep);
    const { api } = await adminApi(app, db);
    const u = await person();
    const m0 = await getMatrix(api);
    const tag0 = etag(m0);
    const body = { reason: 'Quality is reviewed by one person', cells: [{ stage_code: 'change_control', level: 2, rule: 'any_one', assignees: holders(u.id) }] };

    const noStep = await patchMatrix(noStepApi, tag0, body);
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    const missing = await api.call('patch', '/matrix', body);
    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe('precondition_required');
    const stale = await patchMatrix(api, `"${m0.body.version + 50}"`, body);
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    expect((await patchMatrix(api, tag0, { ...body, reason: 'no' })).status).toBe(422);
    const empty = await patchMatrix(api, tag0, { reason: 'Nothing to change' });
    expect(empty.status).toBe(422);
    const unknownRow = await patchMatrix(api, tag0, { reason: 'Unknown row', cells: [{ stage_code: 'nope', level: 1, rule: 'any_one', assignees: holders(u.id) }] });
    expect(unknownRow.status).toBe(422);
    expect(unknownRow.body.errors[0]).toMatchObject({ path: '/cells/0/stage_code', code: 'unknown_row' });
    const extra = await patchMatrix(api, tag0, { ...body, surprise: true });
    expect(extra.status).toBe(422);
    expect(extra.body.errors[0].code).toBe('unknown_field');
    const twice = await patchMatrix(api, tag0, { ...body, cells: [body.cells[0], body.cells[0]] });
    expect(twice.status).toBe(422);
    expect(twice.body.errors[0].code).toBe('duplicate');
    // none of the refused calls changed anything
    expect(etag(await getMatrix(api))).toBe(tag0);

    const before = cellOf(m0.body, 'change_control', 2);
    const res = await patchMatrix(api, tag0, { ...body, stage_levels: [{ stage_code: 'change_control', approval_levels: 2 }] });
    expect(res.status).toBe(200);
    expect(etag(res)).toBe(`"${m0.body.version + 1}"`);
    expect(res.body.version).toBe(m0.body.version + 1);
    const row = rowOf(res.body, 'change_control');
    expect(row.approval_levels).toBe(2);
    expect(row.used_levels).toEqual([1, 3]);
    expect(cellOf(res.body, 'change_control', 2)).toMatchObject({ used: false });
    expect(cellOf(res.body, 'change_control', 2).assignees.map((a) => a.ref_id)).toEqual([u.id]);

    // audit: before and after values, the reason, the actor
    const cellAudit = await db.query(`SELECT action, before, after, reason, actor_id FROM audit_log WHERE entity_type = 'matrix_cell' AND entity_id = $1 ORDER BY id`, [before.id]);
    expect(cellAudit.rows).toHaveLength(1);
    expect(cellAudit.rows[0]).toMatchObject({ action: 'matrix_cell_update', reason: body.reason });
    expect(cellAudit.rows[0].before.assignees.map((a: { label: string }) => a.label)).toEqual(before.assignees.map((a) => a.label).sort());
    expect(cellAudit.rows[0].after.assignees).toEqual([{ kind: 'user', ref_id: u.id, label: u.name, employee_id: u.employeeId }]);
    expect(cellAudit.rows[0].after).toMatchObject({ row: 'change_control', level: 2, level_kind: 'review', rule: 'any_one', region_id: null });
    const levelAudit = await db.query(`SELECT before, after, reason FROM audit_log WHERE entity_type = 'matrix_row' AND entity_id = 'change_control' ORDER BY id DESC LIMIT 1`);
    expect(levelAudit.rows[0].before.approval_levels).toBe(3);
    expect(levelAudit.rows[0].after.approval_levels).toBe(2);
    expect(levelAudit.rows[0].reason).toBe(body.reason);

    // the old ETag is stale now
    expect((await patchMatrix(api, tag0, body)).status).toBe(412);
    // saving what is already there writes nothing: same ETag, no new audit row
    const countBefore = (await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'matrix\\_%'`)).rows[0].n as number;
    const same = await patchMatrix(api, etag(res), { reason: 'Same again', cells: [{ stage_code: 'change_control', level: 2, rule: 'any_one', assignees: holders(u.id) }] });
    expect(same.status).toBe(200);
    expect(etag(same)).toBe(etag(res));
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'matrix\\_%'`)).rows[0].n).toBe(countBefore);
  });

  it('records the region of a region-specific cell in the audit log and refuses unknown regions', async () => {
    const { api } = await adminApi(app, db);
    const u = await person();
    const m0 = await getMatrix(api);
    const bad = await patchMatrix(api, etag(m0), { reason: 'Bad region', cells: [{ stage_code: 'readiness_handover', level: 1, region_id: 77, rule: 'any_one', assignees: holders(u.id) }] });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].code).toBe('unknown_region');
    const ok = await patchMatrix(api, etag(m0), { reason: 'Zawia has its own entry', cells: [{ stage_code: 'readiness_handover', level: 1, region_id: 4, rule: 'any_one', assignees: holders(u.id) }] });
    expect(ok.status).toBe(200);
    const a = await db.query(`SELECT region_id, action, before FROM audit_log WHERE action = 'matrix_cell_create' AND after ->> 'row' = 'readiness_handover' ORDER BY id DESC LIMIT 1`);
    expect(a.rows[0]).toMatchObject({ region_id: 4, before: null });
  });

  it('refuses roles that may not hold levels, inactive users, and all_members on the Entry level', async () => {
    const { api } = await adminApi(app, db);
    const u = await person();
    const gone = await makeUser(db, { status: 'suspended' });
    const noHold = await makeRole(db, { canHold: false });
    const tag = etag(await getMatrix(api));
    const cell = (assignees: unknown[], level = 2, rule = 'any_one') => ({ reason: 'Validation checks', cells: [{ stage_code: 'risks', level, rule, assignees }] });

    let res = await patchMatrix(api, tag, cell([userHolder(u.id), { kind: 'role', ref_id: noHold }]));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ path: '/cells/0/assignees/1', code: 'role_cannot_hold_levels' });
    res = await patchMatrix(api, tag, cell([userHolder(gone.id)]));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ path: '/cells/0/assignees/0', code: 'holder_inactive' });
    res = await patchMatrix(api, tag, cell([userHolder(u.id)], 1, 'all_members'));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ path: '/cells/0/rule', code: 'entry_rule_fixed' });
    res = await patchMatrix(api, tag, cell([{ kind: 'group', ref_id: '00000000-0000-4000-8000-000000000000' }]));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('unknown_holder');
    expect(etag(await getMatrix(api))).toBe(tag);
  });

  it('writes nothing for a stage task override that does not exist, and keeps task overrides apart from the stage default', async () => {
    const { api } = await adminApi(app, db);
    const u = await person();
    const tag = etag(await getMatrix(api));
    const bad = await patchMatrix(api, tag, { reason: 'Unknown task', cells: [{ stage_code: 'MS8', task_code: 'Q9', level: 1, rule: 'any_one', assignees: holders(u.id) }] });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].code).toBe('unknown_task');
    const onRegister = await patchMatrix(api, tag, { reason: 'Task on a register', cells: [{ stage_code: 'risks', task_code: 'A1', level: 1, rule: 'any_one', assignees: holders(u.id) }] });
    expect(onRegister.status).toBe(422);
  });
});

describe('empty_cell', () => {
  it('refuses a used level with no holder and changes nothing; an unused level may be empty', async () => {
    const { api } = await adminApi(app, db);
    const m0 = await getMatrix(api);
    const tag = etag(m0);
    const before = cellOf(m0.body, 'risks', 2).assignees.map((a) => a.ref_id).sort();

    const res = await patchMatrix(api, tag, { reason: 'Empty the review cell', cells: [{ stage_code: 'risks', level: 2, rule: 'any_one', assignees: [] }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('empty_cell');
    expect(res.body.cells).toEqual([{ stage_code: 'risks', task_code: null, level: 2, level_kind: 'review', region_id: null }]);
    const after = await getMatrix(api);
    expect(etag(after)).toBe(tag);
    expect(cellOf(after.body, 'risks', 2).assignees.map((a) => a.ref_id).sort()).toEqual(before);

    // two levels: the review cell is not in use, so it may be emptied in the same save
    const ok = await patchMatrix(api, tag, { reason: 'Two levels, no review', stage_levels: [{ stage_code: 'risks', approval_levels: 2 }], cells: [{ stage_code: 'risks', level: 2, rule: 'any_one', assignees: [] }] });
    expect(ok.status).toBe(200);
    expect(cellOf(ok.body, 'risks', 2).assignees).toEqual([]);
    // going back to three levels needs the review holder again
    const back = await patchMatrix(api, etag(ok), { reason: 'Three levels again', stage_levels: [{ stage_code: 'risks', approval_levels: 3 }] });
    expect(back.status).toBe(422);
    expect(back.body.code).toBe('empty_cell');
    expect(back.body.cells.map((c: { level: number }) => c.level)).toEqual([2]);
  });

  it('a stage row that has no cells yet needs all its used levels in one save', async () => {
    const { api } = await adminApi(app, db);
    const e = await person();
    const r = await person();
    const tag = etag(await getMatrix(api));
    const one = await patchMatrix(api, tag, { reason: 'Only the entry holder', cells: [{ stage_code: 'MS8', level: 1, rule: 'any_one', assignees: holders(e.id) }] });
    expect(one.status).toBe(422);
    expect(one.body.code).toBe('empty_cell');
    expect(one.body.cells.map((c: { level: number; stage_code: string }) => `${c.stage_code}:${c.level}`)).toEqual(['MS8:2', 'MS8:3']);
    const all = await patchMatrix(api, tag, {
      reason: 'All three levels',
      cells: [1, 2, 3].map((level) => ({ stage_code: 'MS8', level, rule: 'any_one', assignees: holders(level === 1 ? e.id : r.id) })),
    });
    expect(all.status).toBe(200);
    expect(rowOf(all.body, 'MS8').cells.map((c) => c.level)).toEqual([1, 2, 3]);
    await db.query(`DELETE FROM matrix_cells WHERE stage_id IN (SELECT id FROM stage_definitions WHERE code = 'MS8' AND workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1))`);
  });
});

describe('a level-count change applies to new transitions only (B7)', () => {
  it('tasks not yet submitted follow the new count; a task already submitted keeps the path frozen at its first submission', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const r = await actor(app, db, { level: 'review' });
    const a = await actor(app, db, { level: 'approve' });
    const { api } = await adminApi(app, db);
    const tag = etag(await getMatrix(api));
    const set = await patchMatrix(api, tag, {
      reason: 'Stage 9 holders',
      cells: [
        { stage_code: 'MS9', level: 1, rule: 'any_one', assignees: holders(e.user.id) },
        { stage_code: 'MS9', level: 2, rule: 'any_one', assignees: holders(r.user.id) },
        { stage_code: 'MS9', level: 3, rule: 'any_one', assignees: holders(a.user.id) },
      ],
    });
    expect(set.status).toBe(200);
    expect(rowOf(set.body, 'MS9').approval_levels).toBe(3);

    // D17 belongs to stage 9. One task has not been submitted; the other was submitted before and is waiting for review on a frozen 3-level path.
    const siteNew = await makeSite(db, 5);
    const tNew = await makeTask(db, siteNew, 'D17', 'entry', { actualDate: '2026-01-05' });
    const siteOld = await makeSite(db, 5);
    const tOld = await makeTask(db, siteOld, 'D17', 'in_review', { level: 2, levels: 3, actualDate: '2026-01-05' });
    await db.query('UPDATE task_instances SET path_frozen_at = now() WHERE id = $1', [tOld]);

    const before = (await getMatrix(api)).body as MatrixBody;
    expect(rowOf(before, 'MS9').task_counts!.not_submitted).toBeGreaterThanOrEqual(1);
    expect(rowOf(before, 'MS9').task_counts!.in_flight).toBeGreaterThanOrEqual(1);

    const res = await patchMatrix(api, etag(set), { reason: 'Stage 9 needs two levels now', stage_levels: [{ stage_code: 'MS9', approval_levels: 2 }] });
    expect(res.status).toBe(200);
    expect(rowOf(res.body, 'MS9')).toMatchObject({ approval_levels: 2, used_levels: [1, 3] });
    expect(rowOf(res.body, 'MS9').task_counts!.not_submitted).toBe(rowOf(before, 'MS9').task_counts!.not_submitted);
    expect(rowOf(res.body, 'MS9').task_counts!.in_flight).toBe(rowOf(before, 'MS9').task_counts!.in_flight);
    // the review cell is kept (it still serves the tasks in flight), shown as not in use
    expect(cellOf(res.body, 'MS9', 2)).toMatchObject({ used: false });
    expect(cellOf(res.body, 'MS9', 2).assignees.map((x) => x.ref_id)).toEqual([r.user.id]);

    const get = async (who: Actor, id: string) => (await who.api.call('get', `/tasks/${id}`)).body;
    const act = (who: Actor, id: string, verb: string, version: number) => who.api.call('post', `/tasks/${id}/${verb}`, {}, { 'If-Match': `"${version}"` });

    // not submitted: two levels, the submission goes straight to the approver
    let t = await get(e, tNew);
    expect(t.levels_required).toBe(2);
    let out = await act(e, tNew, 'submit', t.version);
    expect(out.status).toBe(200);
    expect(out.body.task.state).toBe('in_approval');
    expect(out.body.task.levels_required).toBe(2);
    expect(out.body.skipped_levels).toEqual([]);
    expect(out.body.task.approval_path).toHaveLength(2);
    t = await get(a, tNew);
    out = await act(a, tNew, 'approve', t.version);
    expect(out.status).toBe(200);
    expect(out.body.task.state).toBe('approved');

    // in flight: three levels, the reviewer is still asked, then the approver
    t = await get(r, tOld);
    expect(t.levels_required).toBe(3);
    expect(t.approval_path).toHaveLength(3);
    out = await act(r, tOld, 'review', t.version);
    expect(out.status).toBe(200);
    expect(out.body.task.state).toBe('in_approval');
    expect(out.body.task.levels_required).toBe(3);
    t = await get(a, tOld);
    out = await act(a, tOld, 'approve', t.version);
    expect(out.status).toBe(200);
    expect(out.body.task.state).toBe('approved');
  });
});

describe('permissions of every write', () => {
  it('refuses a person without the right (no grant, a read-only grant, a grant of the wrong module)', async () => {
    const admin = await adminApi(app, db);
    const m0 = await getMatrix(admin.api);
    const tag = etag(m0);
    const body = { reason: 'Not allowed', cells: [{ stage_code: 'warehouse', level: 1, rule: 'any_one', assignees: holders((await person()).id) }] };
    const nobody = await actor(app, db, { grants: [['sites', 'view']] });
    const viewer = await actor(app, db, { grants: [['admin.matrix', 'view']] });
    const wrong = await actor(app, db, { grants: [['workflow_versions', 'edit'], ['admin.workflow', 'edit']] });
    for (const who of [nobody, viewer, wrong]) {
      const res = await patchMatrix(who.api, tag, body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('action_forbidden');
    }
    expect(etag(await getMatrix(admin.api))).toBe(tag);
    expect(await db.query(`SELECT 1 FROM audit_log WHERE action LIKE 'matrix\\_%' AND actor_id = ANY($1::uuid[])`, [[nobody.user.id, viewer.user.id, wrong.user.id]]).then((r) => r.rowCount)).toBe(0);
    // a level count is refused the same way
    const lv = await patchMatrix(viewer.api, tag, { reason: 'Not allowed either', stage_levels: [{ stage_code: 'warehouse', approval_levels: 1 }] });
    expect(lv.status).toBe(403);
  });

  it('a delegate of matrix.edit for all regions may edit, but needs step-up; one for some regions edits only those regions', async () => {
    const all = await delegateOf();
    const noStep = await delegateOf(undefined, false);
    const t = await person();
    const m0 = await getMatrix(all);
    expect(m0.status).toBe(200);
    const tag = etag(m0);

    const denied = await patchMatrix(noStep, tag, { reason: 'No step-up', cells: [{ stage_code: 'warehouse', level: 1, rule: 'any_one', assignees: holders(t.id) }] });
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('step_up_required');
    const done = await patchMatrix(all, tag, { reason: 'Delegate edits all regions', cells: [{ stage_code: 'warehouse', level: 1, rule: 'any_one', assignees: holders(t.id) }] });
    expect(done.status).toBe(200);
    const onBehalf = await db.query(`SELECT on_behalf_of FROM audit_log WHERE action = 'matrix_cell_update' AND after ->> 'row' = 'warehouse' ORDER BY id DESC LIMIT 1`);
    expect(onBehalf.rows[0].on_behalf_of).toBeTruthy(); // "X on behalf of System Admin"

    const tripoli = await delegateOf([1]);
    const tag2 = etag(done);
    // a cell for every region, a level count, and a cell of another region are refused
    for (const body of [
      { reason: 'Global cell', cells: [{ stage_code: 'warehouse', level: 1, rule: 'any_one', assignees: holders(t.id) }] },
      { reason: 'Level count', stage_levels: [{ stage_code: 'warehouse', approval_levels: 2 }] },
      { reason: 'Other region', cells: [{ stage_code: 'warehouse', level: 1, region_id: 2, rule: 'any_one', assignees: holders(t.id) }] },
    ]) {
      const res = await patchMatrix(tripoli, tag2, body);
      expect(res.status, body.reason).toBe(403);
      expect(res.body.code).toBe('action_forbidden');
    }
    const mine = await patchMatrix(tripoli, tag2, { reason: 'Tripoli only', cells: [{ stage_code: 'warehouse', level: 1, region_id: 1, rule: 'any_one', assignees: holders(t.id) }] });
    expect(mine.status).toBe(200);
    expect(rowOf(mine.body, 'warehouse').cells.every((c) => c.region_id === null)).toBe(true);
    expect(await db.query(`SELECT 1 FROM matrix_cells WHERE register_key = 'warehouse' AND region_id = 1`).then((r) => r.rowCount)).toBe(1);
    expect(await db.query(`SELECT 1 FROM matrix_cells WHERE register_key = 'warehouse' AND region_id = 2`).then((r) => r.rowCount)).toBe(0);
  });

  it('the database refuses a direct write by the application role and a call of matrix_save by a person without the right', async () => {
    const admin = await makeAdmin(db);
    const plain = await person();
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.region_ids', '*', true)`, [admin.id]);
      await expect(c.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('risks', 1, 'any_one', 3, false, now())`)).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.region_ids', '*', true)`, [admin.id]);
      await expect(c.query(`UPDATE register_definitions SET approval_levels = 1 WHERE register_key = 'risks'`)).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.region_ids', '*', true)`, [plain.id]);
      await expect(c.query(`SELECT matrix_save(1, NULL, '[]'::jsonb, $1::jsonb, 'direct call')`, [JSON.stringify([{ code: 'risks', level: 1, rule: 'any_one', assignees: [userHolder(plain.id)] }])]))
        .rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect(await db.query(`SELECT 1 FROM matrix_cells WHERE register_key = 'risks' AND region_id = 3`).then((r) => r.rowCount)).toBe(0);
  });
});

describe('the seed of the register rows', () => {
  it('adds rows and cells that are missing and never touches what exists (safe to run before or after another migration)', async () => {
    const calc = await superDbCalc();
    try {
      const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '0020_matrix_admin', 'migration.sql'), 'utf8');
      const from = sql.indexOf('INSERT INTO register_definitions');
      const to = sql.indexOf('-- 4. Helpers');
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      const seed = sql.slice(from, to);

      // 0019 seeded the Q56 entry cells of procurement, gecol and hlc and nothing for permits_hse: the seed of 0020 leaves the four built registers alone
      const built = (await calc.query(`SELECT string_agg(c.register_key || ':' || c.level || ':' || coalesce(r.code, '-'), ',' ORDER BY c.register_key COLLATE "C", c.level) AS s
        FROM matrix_cells c LEFT JOIN matrix_cell_assignees a ON a.cell_id = c.id LEFT JOIN roles r ON r.id = a.ref_id
        WHERE c.register_key IN ('procurement', 'gecol', 'hlc', 'permits_hse')`)).rows[0].s as string;
      expect(built).toBe('gecol:1:GECOL_TEAM,hlc:1:HLC_TEAM,procurement:1:PROC_TEAM');

      await calc.query(`DELETE FROM matrix_cells WHERE register_key = 'deliverables'`);
      await calc.query(`DELETE FROM register_definitions WHERE register_key = 'deliverables'`);
      await calc.query(`DELETE FROM matrix_cell_assignees WHERE cell_id IN (SELECT id FROM matrix_cells WHERE register_key = 'warehouse' AND level = 1)`);
      await calc.query(`UPDATE register_definitions SET approval_levels = 2, name_en = 'Quality (edited by the admin)' WHERE register_key = 'quality'`);
      await calc.query(`DELETE FROM matrix_cell_assignees WHERE cell_id IN (SELECT id FROM matrix_cells WHERE register_key = 'procurement' AND level = 1)`);
      await calc.query(seed);

      const rows = await calc.query(`SELECT count(*)::int AS n FROM register_definitions WHERE register_key = ANY($1::text[])`, [[...REGISTER_CODES, 'dismantle']]);
      expect(rows.rows[0].n).toBe(17);
      const back = await calc.query(`SELECT count(*)::int AS n FROM matrix_cells c JOIN matrix_cell_assignees a ON a.cell_id = c.id WHERE c.register_key = 'deliverables'`);
      expect(back.rows[0].n).toBeGreaterThanOrEqual(3);
      const kept = await calc.query(`SELECT (SELECT count(*)::int FROM matrix_cell_assignees a JOIN matrix_cells c ON c.id = a.cell_id WHERE c.register_key = 'warehouse' AND c.level = 1) AS emptied,
        (SELECT approval_levels FROM register_definitions WHERE register_key = 'quality') AS levels, (SELECT name_en FROM register_definitions WHERE register_key = 'quality') AS name,
        (SELECT count(*)::int FROM matrix_cell_assignees a JOIN matrix_cells c ON c.id = a.cell_id WHERE c.register_key = 'procurement' AND c.level = 1) AS proc`);
      expect(kept.rows[0]).toEqual({ emptied: 0, levels: 2, name: 'Quality (edited by the admin)', proc: 0 });
      // the catalogue rows of the registers that exist since 0019 are not rewritten
      const def = await calc.query(`SELECT enabled FROM register_definitions WHERE register_key IN ('procurement', 'gecol', 'hlc', 'permits_hse') ORDER BY register_key COLLATE "C"`);
      expect(def.rows.map((r) => r.enabled)).toEqual([true, true, true, true]);
      // a second run changes nothing
      const n1 = (await calc.query('SELECT count(*)::int AS n FROM matrix_cells')).rows[0].n;
      await calc.query(seed);
      expect((await calc.query('SELECT count(*)::int AS n FROM matrix_cells')).rows[0].n).toBe(n1);
      expect((await calc.query('SELECT count(*)::int AS n FROM register_definitions')).rows[0].n).toBe(17);
    } finally {
      await calc.end();
    }
  });
});
