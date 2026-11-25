import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, makeSite, makeTask, Site } from './wf-helpers';

/**
 * Migration 0121 (contract 0.15.35, CHANGELOG 160): P1 Master. The source of each Master cell (GET /site-master/sites/{site_id}/sources), the kind of
 * source of each column in the menus, and a source for the columns that were always blank. Synthetic sites and records only.
 */
const TAG = `MS${randomBytes(3).toString('hex').toUpperCase()}`;
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

type Api = Awaited<ReturnType<typeof actor>>['api'];
interface Cell {
  ord: number; letter: string; kind: string; value: string | null; hidden: boolean; origin: string | null;
  record_id?: string; record_version?: number; register_key?: string; task_id?: string; task_code?: string; baseline_version?: number; field?: string;
}

const site = (region = 1, over: { scenario?: string; cluster?: string } = {}): Promise<Site> => makeSite(db, region, { prefix: TAG, ...over });
const moduleOf = async (key: string): Promise<string> => (await db.query(`SELECT module_key FROM register_definitions WHERE register_key = $1`, [key])).rows[0].module_key as string;
const REGS = ['permits_hse', 'procurement', 'as_built', 'change_control', 'readiness_handover', 'dismantle'];
const fullReader = async (regions = [1]) => actor(app, db, { regions, grants: [['sites', 'view'], ...(await Promise.all(REGS.map(async (k) => [await moduleOf(k), 'view'] as [string, string])))] });
const rowValues = async (api: Api, codes: string[], menu = 'master'): Promise<Map<string, Record<string, string | null>>> => {
  const res = await api.call('get', `/site-master/${menu}/rows?site_code=${codes.join(',')}&limit=200`);
  expect(res.status).toBe(200);
  return new Map(res.body.rows.map((r: { site_code: string; values: Record<string, string | null> }) => [r.site_code, r.values]));
};
const sources = async (api: Api, s: Site, menu?: string): Promise<Map<string, Cell>> => {
  const res = await api.call('get', `/site-master/sites/${s.id}/sources${menu ? `?menu=${menu}` : ''}`);
  expect(res.status).toBe(200);
  expect(res.body.site_code).toBe(s.code);
  return new Map((res.body.cells as Cell[]).map((c) => [c.letter, c]));
};
/** A register record version of the site (approved unless told otherwise); returns its id. */
const record = async (s: Site, key: string, type: string | null, data: Record<string, unknown>, state = 'approved'): Promise<string> =>
  (await db.query(
    `INSERT INTO register_records (entity_id, version_no, register_key, record_type, site_id, region_id, state, is_current, data, approved_at, current_level)
     VALUES (gen_random_uuid(), 1, $1, $2, $3, $4, $5, true, $6::jsonb, now(), 3) RETURNING id`,
    [key, type, s.id, s.region, state, JSON.stringify(data)])).rows[0].id as string;
const setTask = async (id: string, set: string, args: unknown[] = []): Promise<void> => {
  await db.query(`UPDATE task_instances SET ${set} WHERE id = $1`, [id, ...args]);
};

describe('the kind of source of each Master column', () => {
  it('flags the Dismantle planned and RN dates as not tracked in the menus, and the newly sourced columns with their kind', async () => {
    const a = await fullReader();
    const res = await a.api.call('get', '/site-master/sections');
    expect(res.status).toBe(200);
    const master = res.body.items.find((m: { key: string }) => m.key === 'master');
    const kind = new Map(master.columns.map((c: { letter: string; source_kind: string }) => [c.letter, c.source_kind]));
    for (const l of ['FP', 'FR', 'FU', 'FW']) expect(kind.get(l)).toBe('not_tracked');
    for (const l of ['U', 'AV', 'BO', 'BY', 'CT', 'DO', 'EK', 'ER', 'EX', 'FL']) expect(kind.get(l)).toBe('baseline');
    for (const l of ['CZ', 'DG', 'DH', 'DI', 'EN', 'EQ', 'FA', 'FB', 'FF', 'FG']) expect(kind.get(l)).toBe('derived');
    for (const l of ['CB', 'CE', 'EW', 'FK', 'FN', 'FQ', 'FS', 'FV']) expect(kind.get(l)).toBe('register');
    expect(kind.get('AR')).toBe('task');
    expect(kind.get('V')).toBe('milestone');
    expect(kind.get('B')).toBe('site');
    // no column is left without a kind
    expect([...kind.values()].every((k) => typeof k === 'string')).toBe(true);
    const rows = await a.api.call('get', '/site-master/dismantle/rows?limit=1');
    expect(rows.body.menu.columns.find((c: { letter: string }) => c.letter === 'FP').source_kind).toBe('not_tracked');
  });
});

describe('the columns that were always blank now have a source', () => {
  it('baseline, B5 report dates, TE access, vendor team, DLP dates, readiness dates and Dismantle dates, each pointing to its record', async () => {
    const s = await site();
    // baselines: an older approved version and a newer one; the newer wins, a draft version never counts
    const v1 = 700000 + Math.floor(Math.random() * 100000);
    const old = (await db.query(`INSERT INTO baseline_versions (version, label, status, approved_at) VALUES ($1, 'ms test old', 'approved', now()) RETURNING id`, [v1])).rows[0].id;
    const cur = (await db.query(`INSERT INTO baseline_versions (version, label, status, approved_at) VALUES ($1, 'ms test new', 'approved', now()) RETURNING id`, [v1 + 1])).rows[0].id;
    const draft = (await db.query(`INSERT INTO baseline_versions (version, label, status) VALUES ($1, 'ms test draft', 'draft') RETURNING id`, [v1 + 2])).rows[0].id;
    await db.query(`INSERT INTO baseline_entries (version_id, site_id, region_id, milestone_code, baseline_date) VALUES
      ($1, $4, 1, 'MS1', '2026-01-10'), ($2, $4, 1, 'MS1', '2026-01-20'), ($2, $4, 1, 'MS4', '2026-04-01'), ($2, $4, 1, 'MS10', '2027-06-30'),
      ($3, $4, 1, 'MS1', '2026-02-28')`, [old, cur, draft, s.id]);
    // B5: STA / ST analysis report submitted and approved
    const b5 = await makeTask(db, s, 'B5', 'approved');
    await setTask(b5, `submitted_date = DATE '2026-02-03', approved_date = DATE '2026-02-05'`);
    // TE access permit (the CW one stays in AL)
    const permitRec = await record(s, 'permits_hse', null, { permit_type: 'Access - TE' });
    await db.query(`INSERT INTO permit_records (site_id, region_id, permit_type, status, valid_from, valid_to, register_record_id, record_version) VALUES
      ($1, 1, 'Access - TE', 'Approved', DATE '2026-03-09', DATE '2034-12-31', $2, 1), ($1, 1, 'Access - TE', 'Approved', DATE '2026-03-20', DATE '2034-12-31', NULL, NULL),
      ($1, 1, 'Access - CW', 'Approved', DATE '2026-01-01', DATE '2034-12-31', NULL, NULL)`, [s.id, permitRec]);
    // TE Installation order with a team; a rejected earlier one does not count
    const party = (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'te_vendor', true) RETURNING id`, [`${TAG}-vendor`])).rows[0].id;
    const team = (await db.query(`INSERT INTO external_teams (party_id, name) VALUES ($1, $2) RETURNING id`, [party, `${TAG} TE team`])).rows[0].id;
    const teamRej = (await db.query(`INSERT INTO external_teams (party_id, name) VALUES ($1, $2) RETURNING id`, [party, `${TAG} rejected team`])).rows[0].id;
    const ordRec = await record(s, 'procurement', null, { scope: 'TE Installation' });
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, team_id, po_wo_date, register_record_id, record_version) VALUES
      ($1, 1, 'TE Installation', 'Rejected', $2, $3, DATE '2026-01-01', NULL, NULL), ($1, 1, 'TE Installation', 'Active', $2, $4, DATE '2026-02-01', $5, 1)`,
    [s.id, party, teamRej, team, ordRec]);
    // CW PAC and TE PAC dates for the DLP columns
    const b13 = await makeTask(db, s, 'B13', 'approved', { actualDate: '2026-02-01' });
    await makeTask(db, s, 'MS7', 'approved', { actualDate: '2026-03-15' });
    // readiness: the HOTO package valid date is the later of the two dates
    const rdy = await record(s, 'readiness_handover', null, { hoto_package_actual_date: '2026-06-01', access_keys_handover_date: '2026-06-03', obligations_closure_date: '2026-09-30' });
    await db.query(`INSERT INTO readiness_handover (site_id, region_id, hoto_package_date, obligations_closure_date, register_record_id, record_version) VALUES ($1, 1, DATE '2026-06-01', DATE '2026-09-30', $2, 1)`, [s.id, rdy]);
    // Dismantle: the CW part has an RFD and a work end date; the TE part is still a draft with an RFD only
    const cwPart = await record(s, 'dismantle', 'cw', { rfd_date: '2026-07-01', work_start_date: '2026-07-05', work_end_date: '2026-07-09' });
    const tePart = await record(s, 'dismantle', 'te', { rfd_date: '2026-07-02' }, 'entry');

    const a = await fullReader();
    const v = (await rowValues(a.api, [s.code])).get(s.code)!;
    expect(v['21']).toBe('2026-01-20');      // U: the newer approved version
    expect(v['77']).toBe('2026-04-01');      // BY
    expect(v['168']).toBe('2027-06-30');     // FL
    expect(v['48']).toBeNull();              // AV: no baseline entry
    expect(v['44']).toBe('2026-02-03');      // AR
    expect(v['45']).toBe('2026-02-05');      // AS
    expect(v['80']).toBe('2026-03-09');      // CB: the earliest approved Access - TE
    expect(v['38']).toBe('2026-01-01');      // AL unchanged
    expect(v['83']).toBe(`${TAG} TE team`);  // CE
    expect(v['157']).toBe('2026-02-01');     // FA = BV
    expect(v['158']).toBe('2026-05-02');     // FB = FA + 90 days
    expect(v['162']).toBe('2026-03-15');     // FF = EL
    expect(v['163']).toBe('2027-03-15');     // FG = EDATE(FF, 12)
    expect(v['153']).toBe('2026-06-03');     // EW
    expect(v['167']).toBe('2026-09-30');     // FK
    expect(v['170']).toBe('2026-07-01');     // FN
    expect(v['173']).toBe('2026-07-09');     // FQ
    expect(v['175']).toBe('2026-07-02');     // FS
    expect(v['172']).toBeNull();             // FP not tracked
    expect(v['113']).toBe('0');              // DI: no rollback
    expect(v['147']).toBe('Missing Cluster ID');

    const src = await sources(a.api, s);
    expect(src.get('U')).toMatchObject({ kind: 'baseline', value: '2026-01-20', baseline_version: v1 + 1, field: 'MS1', origin: 'approved_record' });
    expect(src.get('AR')).toMatchObject({ kind: 'task', task_id: b5, task_code: 'B5', field: 'submitted_date', origin: 'workflow' });
    expect(src.get('CB')).toMatchObject({ kind: 'register', record_id: permitRec, record_version: 1, register_key: 'permits_hse', origin: 'approved_record' });
    expect(src.get('CE')).toMatchObject({ kind: 'register', record_id: ordRec, register_key: 'procurement' });
    expect(src.get('FA')).toMatchObject({ kind: 'derived', task_id: b13, task_code: 'B13', origin: 'calculated' });
    expect(src.get('EW')).toMatchObject({ kind: 'register', record_id: rdy, register_key: 'readiness_handover', value: '2026-06-03' });
    expect(src.get('FN')).toMatchObject({ kind: 'register', record_id: cwPart, field: 'rfd_date', origin: 'approved_record' });
    expect(src.get('FS')).toMatchObject({ kind: 'register', record_id: tePart, origin: 'pending_record' });
    expect(src.get('FP')).toMatchObject({ kind: 'not_tracked', value: null, hidden: false, origin: null });
    expect(src.get('FP')!.record_id).toBeUndefined();
    expect(src.get('B')).toMatchObject({ kind: 'site', value: s.code, field: 'site_code', origin: 'manual' });
    expect(src.get('DI')).toMatchObject({ kind: 'derived', value: '0', origin: 'calculated' });
    expect(src.get('A')).toMatchObject({ kind: 'derived', origin: 'calculated' });
    // a menu limits the cells to its columns
    const om = await sources(a.api, s, 'om');
    expect(om.has('FA')).toBe(true);
    expect(om.has('FN')).toBe(false);
  });

  it('RSL deviation, outage duration, legacy dismantle due and rollback count follow the workbook formulas', async () => {
    const s = await site(1, { scenario: 'cold_swap' });
    const d8 = await makeTask(db, s, 'D8', 'approved');
    await setTask(d8, `"values" = '{"measured_rsl": "-45.5"}'::jsonb`);
    const ab = await record(s, 'as_built', 'te_part', { rsl: '-44', configuration: 'WL/MW' });
    const d10 = await makeTask(db, s, 'D10', 'approved');
    await setTask(d10, `"values" = '{"window_start": "2026-03-01", "window_end": "2026-03-08"}'::jsonb`);
    const ms6 = await makeTask(db, s, 'MS6', 'approved', { actualDate: '2026-04-01' });
    const requester = (await db.query(`SELECT id FROM users LIMIT 1`)).rows[0].id;
    for (const [code, status] of [['A', 'approved'], ['B', 'applied'], ['C', 'requested']] as const) {
      await db.query(`INSERT INTO change_requests (change_code, site_id, region_id, kind, status, change_type, requested_by) VALUES ($1, $2, 1, 'scope_change', $3::"ChangeStatus", 'Cutover Rollback', $4)`,
        [`${TAG}-RB-${code}`, s.id, status, requester]);
    }
    const expectWd = (await db.query(`SELECT cal_workdays_between(DATE '2026-03-01', DATE '2026-03-08')::text AS w,
      cal_add_workdays(DATE '2026-04-01', coalesce((SELECT max_working_days FROM sla_rules WHERE code = 'S-5' AND is_active ORDER BY effective_from DESC LIMIT 1), 0))::text AS due`)).rows[0];

    const a = await fullReader();
    const v = (await rowValues(a.api, [s.code])).get(s.code)!;
    expect(v['104']).toBe('-1.5');           // CZ = CY - As-Built RSL
    expect(v['111']).toBe(expectWd.w);       // DG
    expect(v['112']).toBe(expectWd.due);     // DH
    expect(v['113']).toBe('2');              // DI: approved and applied, not requested
    const src = await sources(a.api, s);
    expect(src.get('CZ')).toMatchObject({ kind: 'derived', record_id: ab, register_key: 'as_built', origin: 'calculated' });
    expect(src.get('DG')).toMatchObject({ kind: 'derived', task_id: d10 });
    expect(src.get('DH')).toMatchObject({ kind: 'derived', task_id: ms6 });
    expect(src.get('DP')).toMatchObject({ kind: 'milestone', task_id: ms6, task_code: 'MS6', origin: 'workflow' });

    // the end before the start: Date Error; a new build site has no Legacy Dismantle Due
    await setTask(d10, `"values" = '{"window_start": "2026-03-08", "window_end": "2026-03-01"}'::jsonb`);
    const nb = await site();
    await makeTask(db, nb, 'MS6', 'approved', { actualDate: '2026-04-01' });
    const v2 = await rowValues(a.api, [s.code, nb.code]);
    expect(v2.get(s.code)!['111']).toBe('Date Error');
    expect(v2.get(nb.code)!['112']).toBeNull();
  });

  it('EN is the cluster and EQ validates the KPI source of the cluster', async () => {
    const code = `${TAG}-CL-${randomBytes(2).toString('hex')}`;
    const cl = (await db.query(`INSERT INTO clusters (cluster_code, name, region_id) VALUES ($1, 'ms cluster', 1) RETURNING id`, [code])).rows[0].id;
    const s1 = await site(1, { cluster: cl });
    const s2 = await site(1, { cluster: cl });
    const a = await fullReader();
    let v = await rowValues(a.api, [s1.code, s2.code]);
    expect(v.get(s1.code)!['144']).toBe(code);
    expect(v.get(s1.code)!['147']).toBe('No Source');
    await makeTask(db, s1, 'F2', 'approved', { actualDate: '2026-05-05' });
    v = await rowValues(a.api, [s1.code, s2.code]);
    expect(v.get(s1.code)!['147']).toBe('Valid');
    expect(v.get(s2.code)!['147']).toBe('Valid');
    await makeTask(db, s2, 'F2', 'approved', { actualDate: '2026-05-06' });
    v = await rowValues(a.api, [s1.code]);
    expect(v.get(s1.code)!['147']).toBe('Multiple Sources');
  });
});

describe('access: the source obeys the region and the register view of the value', () => {
  it('a reader of another region gets 404 and no id; a reader without the register view gets the kind only', async () => {
    const s = await site(1);
    const cwPart = await record(s, 'dismantle', 'cw', { rfd_date: '2026-07-01' });
    const other = await fullReader([2]);
    const res = await other.api.call('get', `/site-master/sites/${s.id}/sources`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(cwPart);
    const bad = await other.api.call('get', `/site-master/sites/not-a-uuid/sources`);
    expect(bad.status).toBe(404);

    const blind = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });
    const src = await sources(blind.api, s);
    expect(src.get('FN')).toMatchObject({ kind: 'register', hidden: true, value: null, register_key: 'dismantle' });
    expect(src.get('FN')!.record_id).toBeUndefined();
    expect(JSON.stringify([...src.values()])).not.toContain(cwPart);
    // the same caller sees the value of a site field and its source
    expect(src.get('B')).toMatchObject({ kind: 'site', value: s.code, hidden: false });
    // the rows page hides the same value
    expect((await rowValues(blind.api, [s.code])).get(s.code)!['170']).toBeNull();

    const full = await fullReader([1]);
    expect((await sources(full.api, s)).get('FN')).toMatchObject({ record_id: cwPart, hidden: false });
    const menu = await full.api.call('get', `/site-master/sites/${s.id}/sources?menu=nope`);
    expect(menu.status).toBe(422);
  });
});

describe('a not-tracked column filled by a hidden site custom field', () => {
  it('is hidden in the sources, and sorting on it does not follow the hidden values', async () => {
    const a = await site(1);
    const b = await site(1);
    const ord = (await db.query(`SELECT ord FROM master_columns WHERE letter = 'FP'`)).rows[0].ord as number;
    const code = `msfp_${TAG.toLowerCase()}`;
    const f = await db.query(`INSERT INTO field_definitions (entity_type, code, label_en, data_type, master_export_column) VALUES ('site', $1, 'FP planned', 'text', 'FP') RETURNING id`, [code]);
    try {
      await db.query(`UPDATE sites SET custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object($1::text, $2::text) WHERE id = $3`, [code, 'zzz', a.id]);
      await db.query(`UPDATE sites SET custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object($1::text, $2::text) WHERE id = $3`, [code, 'aaa', b.id]);
      const reader = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });
      await db.query(`INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'hidden')`, [f.rows[0].id, reader.roleId]);
      const lead = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });

      expect((await sources(lead.api, a)).get('FP')).toMatchObject({ kind: 'custom_field', value: 'zzz', hidden: false });
      const hid = (await sources(reader.api, a)).get('FP')!;
      expect(hid).toMatchObject({ kind: 'custom_field', hidden: true, value: null });

      const order = async (api: Api, dir: string): Promise<string[]> => {
        const res = await api.call('get', `/site-master/master/rows?site_code=${a.code},${b.code}&sort=ord:${ord}&dir=${dir}&limit=200`);
        expect(res.status).toBe(200);
        return res.body.rows.map((r: { site_code: string }) => r.site_code);
      };
      // the lead's order follows the values; the reader's order is the same both ways (no oracle)
      expect(await order(lead.api, 'asc')).toEqual([b.code, a.code]);
      expect(await order(lead.api, 'desc')).toEqual([a.code, b.code]);
      expect(await order(reader.api, 'asc')).toEqual(await order(reader.api, 'desc'));
    } finally {
      await db.query(`UPDATE field_definitions SET is_active = false, master_export_column = NULL WHERE id = $1`, [f.rows[0].id]);
    }
  });
});
