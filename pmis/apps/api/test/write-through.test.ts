import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G, patch, post, recPath, regCell, team } from './reg-helpers';
import { actor, makeTask } from './wf-helpers';

/**
 * Migration 0029 / contract 0.4.9: write-through edits from the Site Register task grid (spec registers-and-streams.md 2.7, Q73, Q99).
 * The grid shows register_fields read from the source register; the edit goes to the register's own endpoints. Region 1 is used for the
 * As-Built and Dismantle cells by this suite only; region 2 is the "other region" of the permission cases.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 1;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

/** A team of the register where the grid user is the only entry holder, and a site with the task open. */
async function setup(key: string, module: string, taskCode: string) {
  const t = await team(app, db, key, module, R);
  const editor = await actor(app, db, { level: 'entry', grants: [...G('sites', 'view'), ...G(module, 'view', 'create', 'edit')], regions: [R], modules: null });
  await regCell(db, key, R, 'entry', { user: [editor.user.id] });
  await makeTask(db, t.site, taskCode, 'entry');
  return { t: { ...t, entry: editor }, editor, site: t.site };
}

const fieldsOf = async (api: { call: (m: 'get', p: string) => Promise<any> }, siteId: string, taskCode: string): Promise<any[] | undefined> => {
  const res = await api.call('get', `/sites/${siteId}/tasks`);
  expect(res.status).toBe(200);
  const task = res.body.stages.flatMap((s: any) => s.tasks).find((x: any) => x.task_code === taskCode);
  return task?.register_fields;
};

describe('BU on B13 and EF on D15 are As-Built fields (Q99)', () => {
  it('shows BU with a pointer to the source; since Q113 (migration 0062) it is filled by the CW part submission, never typed, and the approval path is unchanged', async () => {
    const { t, editor, site } = await setup('as_built', 'as_built', 'B13');
    let f = (await fieldsOf(editor.api, site.id, 'B13')) as any[];
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ code: 'cw_as_built_submitted', master_column: 'BU', type: 'list', value: null, editable: false, edit_via: 'none',
      source: { register_key: 'as_built', record_type: 'cw_part', record_id: null, field: 'data.cw_as_built_submitted', site_id: site.id } });
    expect(f[0].options.map((o: { value: string }) => o.value)).toEqual(['Yes', 'N/A']);
    const typed = await editor.api.call('post', recPath('as_built'), { site_id: site.id, record_type: 'cw_part', data: { cw_as_built_submitted: 'N/A' } });
    expect(typed.status).toBe(422);
    expect(typed.body.errors[0]).toMatchObject({ path: '/data/cw_as_built_submitted', code: 'field_read_only' });

    // the CW part is entered in the register; BU shows the part's state
    const created = await editor.api.call('post', recPath('as_built'), { site_id: site.id, record_type: 'cw_part', data: { q_tower: 24 } });
    expect(created.status).toBe(201);
    f = (await fieldsOf(editor.api, site.id, 'B13')) as any[];
    expect(f[0]).toMatchObject({ value: null, edit_via: 'none', source: { record_id: created.body.id, record_state: 'entry', record_version: created.body.version } });
    // the task itself keeps no copy
    expect((await db.query(`SELECT values FROM task_instances WHERE site_id = $1`, [site.id])).rows[0].values ?? {}).not.toHaveProperty('cw_as_built_submitted');

    // L1 Data Entry submits: BU = Yes from the submission; L2 Data Reviewer & Approver approves
    const sub = await post(editor.api, 'as_built', created.body.id, 'submit', created.body.version);
    expect(sub.status).toBe(200);
    f = (await fieldsOf(editor.api, site.id, 'B13')) as any[];
    expect(f[0]).toMatchObject({ value: 'Yes', editable: false, edit_via: 'none', source: { record_state: 'in_approval' } });
    await t.approve.api.stepUp(t.approve.user.password);
    const res = await post(t.approve.api, 'as_built', created.body.id, 'approve', sub.body.version);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('approved');
    f = (await fieldsOf(editor.api, site.id, 'B13')) as any[];
    expect(f[0]).toMatchObject({ value: 'Yes', edit_via: 'none', source: { record_state: 'approved' } });
    expect((await db.query(`SELECT state, data FROM register_records WHERE id = $1`, [created.body.id])).rows[0]).toMatchObject({ state: 'approved', data: { cw_as_built_submitted: 'Yes' } });
  });

  it('EF (D15) is the As-Built Date, a past date only', async () => {
    const { editor, site } = await setup('as_built', 'as_built', 'D15');
    const f = (await fieldsOf(editor.api, site.id, 'D15')) as any[];
    expect(f[0]).toMatchObject({ code: 'as_built_date', master_column: 'EF', type: 'date', edit_via: 'create' });
    const future = await editor.api.call('post', recPath('as_built'), { site_id: site.id, data: { as_built_date: '2999-01-01' } });
    expect(future.status).toBe(422);
    const ok = await editor.api.call('post', recPath('as_built'), { site_id: site.id, data: { as_built_date: '2026-03-01' } });
    expect(ok.status).toBe(201);
    expect(((await fieldsOf(editor.api, site.id, 'D15')) as any[])[0].value).toBe('2026-03-01');
  });
});

describe('FO and FT on E2 are the contractor of the Dismantle parts (Q52, Q99)', () => {
  it('lists one field per part, reads the party of the part and writes it through the Dismantle record', async () => {
    const { editor, site } = await setup('dismantle', 'dismantle', 'E2');
    const party = (await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, 'other'::"ExternalPartyType") RETURNING id`, [`WT Contractor ${site.code}`])).rows[0].id as string;
    let f = (await fieldsOf(editor.api, site.id, 'E2')) as any[];
    expect(f.map((x) => [x.master_column, x.source.record_type, x.type, x.edit_via])).toEqual([['FO', 'cw', 'party', 'create'], ['FT', 'te', 'party', 'create']]);

    const cw = await editor.api.call('post', recPath('dismantle'), { site_id: site.id, record_type: 'cw', data: { rfd_date: '2026-02-01' }, external_party_id: party });
    expect(cw.status).toBe(201);
    f = (await fieldsOf(editor.api, site.id, 'E2')) as any[];
    expect(f[0]).toMatchObject({ value: `WT Contractor ${site.code}`, edit_via: 'patch', source: { record_id: cw.body.id, field: 'external_party_id' } });
    expect(f[1]).toMatchObject({ value: null, edit_via: 'create' }); // the TE part has no record: the CW record is not shown as its FT

    const clear = await patch(editor.api, 'dismantle', cw.body.id, cw.body.version, { external_party_id: null });
    expect(clear.status).toBe(200);
    expect(((await fieldsOf(editor.api, site.id, 'E2')) as any[])[0].value).toBeNull();
    expect((await db.query(`SELECT external_party_id FROM register_records WHERE id = $1`, [cw.body.id])).rows[0].external_party_id).toBeNull();
  });
});

describe('permissions are the register\'s', () => {
  it('leaves the field out without view on the register, makes it read-only without edit, and refuses a write outside the grant or the region', async () => {
    const { editor, site } = await setup('as_built', 'as_built', 'D15');
    const rec = await editor.api.call('post', recPath('as_built'), { site_id: site.id, record_type: 'te_part', data: { as_built_date: '2026-03-01' } });
    expect(rec.status).toBe(201);

    // sites.view only: no as_built grant, the register fields are not shown
    const noReg = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R], modules: null });
    expect(await fieldsOf(noReg.api, site.id, 'D15')).toBeUndefined();

    // view without edit: the value shows, nothing is editable, the register refuses the write (403)
    const viewer = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('as_built', 'view')], regions: [R], modules: null });
    const vf = (await fieldsOf(viewer.api, site.id, 'D15')) as any[];
    expect(vf[0]).toMatchObject({ value: '2026-03-01', editable: false, edit_via: 'none' });
    const denied = await patch(viewer.api, 'as_built', rec.body.id, rec.body.version, { data: { as_built_date: '2026-03-02' } });
    expect(denied.status).toBe(403);
    expect((await viewer.api.call('post', recPath('as_built'), { site_id: site.id, data: {} })).status).toBe(403);

    // edit rights in another region only: the site and its record are not reachable
    const other = await actor(app, db, { level: 'entry', grants: [...G('sites', 'view'), ...G('as_built', 'view', 'edit', 'create')], regions: [2], modules: null });
    expect((await other.api.call('get', `/sites/${site.id}/tasks`)).status).toBe(404);
    expect([403, 404]).toContain((await patch(other.api, 'as_built', rec.body.id, rec.body.version, { data: { as_built_date: '2026-03-02' } })).status);
    expect((await db.query(`SELECT data FROM register_records WHERE id = $1`, [rec.body.id])).rows[0].data.as_built_date).toBe('2026-03-01');

    // edit grant but not an entry holder of the Matrix row: the register refuses
    const notHolder = await actor(app, db, { level: 'entry', grants: [...G('sites', 'view'), ...G('as_built', 'view', 'edit', 'create')], regions: [R], modules: null });
    const nf = (await fieldsOf(notHolder.api, site.id, 'D15')) as any[];
    expect(nf[0].editable).toBe(false);
    expect((await patch(notHolder.api, 'as_built', rec.body.id, rec.body.version, { data: { as_built_date: '2026-03-02' } })).status).toBe(403);
  });
});
