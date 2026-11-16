import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, makeSite, makeTask, plainAdmin, Site } from './wf-helpers';

/** F3 (migration 0117, contract 0.15.31): the AND/OR filter builder of saved views, compiled on the server, and views shared with a region. */
const TAG = randomBytes(3).toString('hex').toUpperCase();
let app: NestExpressApplication;
let db: PgClient;

const LEAD: [string, string][] = [['sites', 'view'], ['issues', 'view'], ['views', 'create']];
const SITES: [string, string][] = [['sites', 'view']];
type Tree = { op: 'and' | 'or'; items: unknown[] };
const q = (tree: Tree): string => `filter=${encodeURIComponent(JSON.stringify(tree))}`;
const codes = (body: { items: { site_code: string }[] }): string[] => body.items.map((s) => s.site_code).sort();
const mine = (tree: Tree): Tree => ({ op: 'and', items: [{ field: 'site_code', operator: 'contains', value: TAG }, tree] });

let tri1: Site, tri2: Site, zaw: Site, ben: Site;
beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  tri1 = await makeSite(db, 1, { prefix: `F3${TAG}A`, scenario: 'new_build' });
  tri2 = await makeSite(db, 1, { prefix: `F3${TAG}B`, scenario: 'expansion', status: 'on_hold' });
  zaw = await makeSite(db, 4, { prefix: `F3${TAG}C`, scenario: 'expansion' });
  ben = await makeSite(db, 5, { prefix: `F3${TAG}D`, scenario: 'hot_swap' });
  await db.query(`UPDATE sites SET tower_height_m = 30, rf_survey_date = cal_today() - 3 WHERE id = $1`, [tri1.id]);
  await db.query(`UPDATE sites SET tower_height_m = 45, rf_survey_date = cal_today() - 40 WHERE id = $1`, [tri2.id]);
  await db.query(`UPDATE sites SET tower_height_m = 60 WHERE id = ANY($1::uuid[])`, [[zaw.id, ben.id]]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('compile and results', () => {
  it('AND / OR groups on GET /sites, numbers, relative dates and empty', async () => {
    const a = await actor(app, db, { grants: SITES });
    // site_code contains TAG AND (region is Tripoli OR scenario is expansion) -> tri1, tri2, zaw
    let r = await a.api.call('get', `/sites?limit=50&${q(mine({ op: 'or', items: [{ field: 'region_id', operator: 'is', value: '1' }, { field: 'delivery_scenario', operator: 'is', value: 'expansion' }] }))}`);
    expect(r.status).toBe(200);
    expect(codes(r.body)).toEqual([tri1.code, tri2.code, zaw.code].sort());
    // AND inside: region Tripoli AND scenario expansion -> tri2 only
    r = await a.api.call('get', `/sites?${q(mine({ op: 'and', items: [{ field: 'region_id', operator: 'in', value: ['1'] }, { field: 'delivery_scenario', operator: 'is', value: 'expansion' }] }))}`);
    expect(codes(r.body)).toEqual([tri2.code]);
    // root OR: tower height between 40 and 50, or scenario hot swap (and the tag in a group)
    r = await a.api.call('get', `/sites?${q({ op: 'and', items: [{ field: 'site_code', operator: 'contains', value: TAG },
      { op: 'or', items: [{ field: 'tower_height_m', operator: 'between', value: [40, 50] }, { field: 'delivery_scenario', operator: 'is', value: 'hot_swap' }] }] })}`);
    expect(codes(r.body)).toEqual([tri2.code, ben.code].sort());
    // relative date: surveyed in the last 7 days; and "before today - 30"
    r = await a.api.call('get', `/sites?${q(mine({ op: 'and', items: [{ field: 'rf_survey_date', operator: 'in_last_days', value: 7 }] }))}`);
    expect(codes(r.body)).toEqual([tri1.code]);
    r = await a.api.call('get', `/sites?${q(mine({ op: 'and', items: [{ field: 'rf_survey_date', operator: 'before', value: { rel: 'today', offset: -30 } }] }))}`);
    expect(codes(r.body)).toEqual([tri2.code]);
    r = await a.api.call('get', `/sites?${q(mine({ op: 'and', items: [{ field: 'rf_survey_date', operator: 'empty' }] }))}`);
    expect(codes(r.body)).toEqual([zaw.code, ben.code].sort());
    // is_not keeps the rows whose value is something else; not_in too
    r = await a.api.call('get', `/sites?${q(mine({ op: 'and', items: [{ field: 'overall_status', operator: 'is_not', value: 'on_hold' }, { field: 'region_id', operator: 'not_in', value: ['5'] }] }))}`);
    expect(codes(r.body)).toEqual([tri1.code, zaw.code].sort());
  });

  it('the same filter on GET /site360/{menu}/rows, on a register and on the task list of a site', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view'], ['issues', 'view']] });
    const r = await a.api.call('get', `/site360/master/rows?limit=50&${q(mine({ op: 'or', items: [{ field: 'region_id', operator: 'is', value: '4' }, { field: 'delivery_scenario', operator: 'is', value: 'hot_swap' }] }))}`);
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: { site_code: string }) => x.site_code).sort()).toEqual([zaw.code, ben.code].sort());

    for (const [site, status, ago] of [[tri1, 'Open', 2], [tri1, 'Closed', 2], [tri2, 'Open', 20]] as const) {
      await db.query(`INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, current_level)
        VALUES (gen_random_uuid(), 1, 'issues', $1, $2, 'entry', true, jsonb_build_object('pending_issue', $3::text, 'raised_date', (cal_today() - $4::int)::text, 'issue_status', $5::text), 1)`,
        [site.id, site.region, `F3 issue ${TAG}`, ago, status]);
    }
    const f = { op: 'and', items: [{ field: 'f:pending_issue', operator: 'contains', value: TAG }, { field: 'f:issue_status', operator: 'is', value: 'Open' }, { field: 'f:raised_date', operator: 'in_last_days', value: 10 }] };
    const reg = await a.api.call('get', `/registers/issues/records?${q(f as Tree)}`);
    expect(reg.status).toBe(200);
    expect(reg.body.items.map((x: { site_code: string }) => x.site_code)).toEqual([tri1.code]);
    // a choice field refuses a value that is not one of its options
    const bad = await a.api.call('get', `/registers/issues/records?${q({ op: 'and', items: [{ field: 'f:issue_status', operator: 'is', value: 'Maybe' }] })}`);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/filter/items/0/value', code: 'invalid_value' });

    await makeTask(db, tri1, 'A1', 'approved', { actualDate: '2026-01-10' });
    await makeTask(db, tri1, 'A2', 'open', { dueDate: '2026-01-05' });
    const tasks = await a.api.call('get', `/sites/${tri1.id}/tasks?${q({ op: 'or', items: [{ field: 'state', operator: 'is', value: 'approved' }, { field: 'late', operator: 'is', value: true }] })}`);
    expect(tasks.status).toBe(200);
    const got = tasks.body.stages.flatMap((s: { tasks: { task_code: string }[] }) => s.tasks.map((t) => t.task_code)).sort();
    expect(got).toEqual(['A1', 'A2']);
  });
});

describe('the whitelist and the limits', () => {
  it('unknown or non-whitelisted fields, wrong operators, depth and size are refused with 422', async () => {
    const a = await actor(app, db, { grants: SITES });
    const call = (tree: unknown) => a.api.call('get', `/sites?filter=${encodeURIComponent(JSON.stringify(tree))}`);
    let r = await call({ op: 'and', items: [{ field: 'password_hash', operator: 'is', value: 'x' }] });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ path: '/filter/items/0/field', code: 'unknown_field' });
    r = await call({ op: 'and', items: [{ field: 'c:no_such_field', operator: 'is', value: 'x' }] });
    expect(r.body.errors[0].code).toBe('unknown_field');
    r = await call({ op: 'and', items: [{ field: 'site_code; DROP TABLE sites', operator: 'is', value: 'x' }] });
    expect(r.status).toBe(422);
    r = await call({ op: 'and', items: [{ field: 'tower_height_m', operator: 'contains', value: '3' }] });
    expect(r.body.errors[0]).toMatchObject({ path: '/filter/items/0/operator', code: 'invalid_operator' });
    r = await call({ op: 'and', items: [{ field: 'tower_height_m', operator: 'gt', value: 'abc' }] });
    expect(r.body.errors[0].code).toBe('invalid_value');
    r = await call({ op: 'and', items: [{ op: 'or', items: [{ op: 'and', items: [] }] }] });
    expect(r.body.errors[0].code).toBe('too_deep');
    r = await call({ op: 'and', items: Array.from({ length: 21 }, () => ({ field: 'site_code', operator: 'is', value: 'x' })) });
    expect(r.status).toBe(422);
    r = await call({ op: 'and', items: Array.from({ length: 11 }, () => ({ op: 'or', items: Array.from({ length: 5 }, () => ({ field: 'name', operator: 'is', value: 'x' })) })) });
    expect(r.body.errors[0].code).toBe('too_many');
    r = await call({ op: 'xor', items: [] });
    expect(r.status).toBe(422);
    expect((await a.api.call('get', '/sites?filter=%7Bnot-json')).status).toBe(422);
    expect((await a.api.call('get', `/sites?filter=${'x'.repeat(8100)}`)).status).toBe(422);
  });

  it('values are parameters: quotes, comment marks and wildcards never change the query', async () => {
    const a = await actor(app, db, { grants: SITES });
    for (const v of [`${TAG}' OR '1'='1`, `x'); DELETE FROM sites; --`, `%`, `_`, `\\`]) {
      const r = await a.api.call('get', `/sites?${q({ op: 'or', items: [{ field: 'site_code', operator: 'is', value: v }, { field: 'name', operator: 'contains', value: v }] })}`);
      expect(r.status).toBe(200);
      expect(r.body.items).toEqual([]);
    }
    const left = await db.query('SELECT count(*)::int AS n FROM sites WHERE site_code LIKE $1', [`%${TAG}%`]);
    expect(left.rows[0].n).toBe(4);
  });

  it('GET /saved-views/filter-fields lists the whitelist with operators; a list without a builder or a module the caller cannot open is refused', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view'], ['issues', 'view']] });
    const r = await a.api.call('get', '/saved-views/filter-fields?screen_key=sites');
    expect(r.status).toBe(200);
    const region = r.body.items.find((f: { key: string }) => f.key === 'region_id');
    expect(region).toMatchObject({ type: 'enum', operators: ['is', 'is_not', 'in', 'not_in', 'empty', 'not_empty'] });
    expect(region.options).toHaveLength(7);
    expect(r.body.items.some((f: { key: string }) => f.key === 'ms:MS1')).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/SELECT|s\.site_code/);
    expect(r.body.limits).toMatchObject({ max_depth: 2, max_items_per_group: 20, max_conditions: 50 });
    const reg = await a.api.call('get', '/saved-views/filter-fields?screen_key=register-issues');
    expect(reg.body.items.find((f: { key: string }) => f.key === 'f:issue_status')).toMatchObject({ type: 'enum' });
    expect((await a.api.call('get', '/saved-views/filter-fields?screen_key=audit-log')).status).toBe(422);
    const none = await actor(app, db, { grants: [['issues', 'view']] });
    expect((await none.api.call('get', '/saved-views/filter-fields?screen_key=sites')).status).toBe(403);
  });

  it('a saved view with a tree is checked on save: shape, fields and values', async () => {
    const a = await actor(app, db, { grants: SITES });
    const save = (advanced: unknown) => a.api.call('post', '/saved-views', { screen_key: 'sites', name: `T ${TAG} ${randomBytes(2).toString('hex')}`, filters: { advanced } });
    expect((await save({ op: 'and', items: [{ field: 'nope', operator: 'is', value: 'x' }] })).body.errors[0]).toMatchObject({ path: '/filters/advanced/items/0/field', code: 'unknown_field' });
    expect((await save({ op: 'and', items: [{ op: 'or', items: [{ op: 'and', items: [] }] }] })).status).toBe(422);
    const ok = await save({ op: 'or', items: [{ field: 'region_id', operator: 'in', value: ['1', '4'] }, { op: 'and', items: [{ field: 'tower_height_m', operator: 'gte', value: 50 }] }] });
    expect(ok.status).toBe(201);
    expect(ok.body.filters.advanced.items).toHaveLength(2);
    // the database repeats the limits for anything stored
    await expect(db.query(`SELECT sv_check_tree('{"op":"and","items":[{"op":"or","items":[{"op":"and","items":[]}]}]}'::jsonb)`)).rejects.toThrow(/too_deep/);
    // imports of the old local views never carry a tree
    const imp = await a.api.call('post', '/saved-views/import', { screen_key: 'sites', items: [{ local_id: 'x1', name: 'Old', filters: { advanced: { op: 'and', items: [] } } }] });
    expect(imp.status).toBe(422);
  });
});

describe('hidden fields and sharing', () => {
  it('a field a field rule hides is not filterable by that reader and is stripped from a view shared with them', async () => {
    const lead = await actor(app, db, { grants: LEAD });
    const reader = await actor(app, db, { grants: SITES });
    const code = `f3secret_${TAG.toLowerCase()}`;
    const f = await db.query(`INSERT INTO field_definitions (entity_type, code, label_en, data_type, in_list_filters) VALUES ('site', $1, 'Secret', 'text', true) RETURNING id`, [code]);
    await db.query(`INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'hidden')`, [f.rows[0].id, reader.roleId]);
    await db.query(`UPDATE sites SET custom = custom || jsonb_build_object($1::text, 'gold') WHERE id = $2`, [code, tri1.id]);
    const tree = mine({ op: 'and', items: [{ field: `c:${code}`, operator: 'is', value: 'gold' }] });
    // the lead sees the field and the row
    const seen = await lead.api.call('get', `/sites?${q(tree)}`);
    expect(codes(seen.body)).toEqual([tri1.code]);
    expect((await lead.api.call('get', '/saved-views/filter-fields?screen_key=sites')).body.items.some((x: { key: string }) => x.key === `c:${code}`)).toBe(true);
    // the reader may not filter on it: the answer is the one of an unknown field
    const refused = await reader.api.call('get', `/sites?${q(tree)}`);
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ code: 'unknown_field' });
    expect((await reader.api.call('get', '/saved-views/filter-fields?screen_key=sites')).body.items.some((x: { key: string }) => x.key === `c:${code}`)).toBe(false);
    // a view shared with the reader comes back without the condition (and its value)
    const v = await lead.api.call('post', '/saved-views', { screen_key: 'sites', name: `Gold ${TAG}`, filters: { advanced: tree }, audience: { user_ids: [reader.user.id] } });
    expect(v.status).toBe(201);
    const got = await reader.api.call('get', `/saved-views/${v.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.stripped_columns).toBe(1);
    expect(JSON.stringify(got.body.filters)).not.toContain(code);
    expect(JSON.stringify(got.body.filters)).not.toContain('gold');
    expect(got.body.filters.advanced.items).toHaveLength(1); // the site_code condition stays; the emptied group is gone
  });

  it('a view shared with a region reaches the readers of that region only; a region-limited lead shares only their regions', async () => {
    const lead = await actor(app, db, { grants: LEAD, regions: [1] });
    const inTri = await actor(app, db, { grants: SITES, regions: [1] });
    const inZaw = await actor(app, db, { grants: SITES, regions: [4] });
    const allRegions = await actor(app, db, { grants: SITES });
    const noModule = await actor(app, db, { grants: [['issues', 'view']], regions: [1] });
    const tree = mine({ op: 'or', items: [{ field: 'delivery_scenario', operator: 'is', value: 'expansion' }] });
    expect((await lead.api.call('post', '/saved-views', { screen_key: 'sites', name: `Z ${TAG}`, audience: { region_ids: [4] } })).status).toBe(403);
    // a tree that pins another region is refused for a shared view (as the simple region filter is)
    const pinned = await lead.api.call('post', '/saved-views', { screen_key: 'sites', name: `P ${TAG}`, filters: { advanced: { op: 'and', items: [{ field: 'region_id', operator: 'in', value: ['1', '4'] }] } }, audience: { region_ids: [1] } });
    expect(pinned.status).toBe(422);
    expect(pinned.body.errors[0]).toMatchObject({ code: 'out_of_scope' });
    const v = await lead.api.call('post', '/saved-views', { screen_key: 'sites', name: `Tri ${TAG}`, filters: { advanced: tree }, audience: { region_ids: [1] } });
    expect(v.status).toBe(201);
    expect(v.body.audience.regions).toEqual([expect.objectContaining({ id: 1 })]);
    const id = v.body.id as string;
    for (const who of [inTri, allRegions]) expect((await who.api.call('get', `/saved-views/${id}`)).status).toBe(200);
    for (const who of [inZaw, noModule]) {
      expect((await who.api.call('get', `/saved-views/${id}`)).status).toBe(404);
      expect((await who.api.call('get', '/saved-views?screen_key=sites')).body.items.map((x: { id: string }) => x.id)).not.toContain(id);
    }
    // recipients see the rows their own rights allow: the same tree gives Tripoli rows to one reader, all rows to another
    expect(codes((await inTri.api.call('get', `/sites?${q(tree)}`)).body)).toEqual([tri2.code]);
    expect(codes((await allRegions.api.call('get', `/sites?${q(tree)}`)).body)).toEqual([tri2.code, zaw.code].sort());
    expect(codes((await inZaw.api.call('get', `/sites?${q(tree)}`)).body)).toEqual([zaw.code]);
  });

  it('recipients read only: they cannot edit, reshare or deactivate; the owner and a System Admin (with a reason) can; every change is audited', async () => {
    const lead = await actor(app, db, { grants: LEAD });
    const reader = await actor(app, db, { grants: [...SITES, ['views', 'create']] });
    const admin = await plainAdmin(app, db);
    const tree = mine({ op: 'and', items: [{ field: 'region_id', operator: 'is', value: '1' }] });
    const v = await lead.api.call('post', '/saved-views', { screen_key: 'sites', name: `Shared ${TAG}`, filters: { advanced: tree }, audience: { region_ids: [1, 4], role_ids: [reader.roleId] } });
    expect(v.status).toBe(201);
    const id = v.body.id as string;
    const seen = await reader.api.call('get', `/saved-views/${id}`);
    expect(seen.body).toMatchObject({ is_owner: false, can_edit: false, can_share: false, audience: null });
    expect((await reader.api.call('patch', `/saved-views/${id}`, { filters: { advanced: { op: 'and', items: [] } } }, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await reader.api.call('patch', `/saved-views/${id}`, { audience: { region_ids: [] } }, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await reader.api.call('post', `/saved-views/${id}/deactivate`, {}, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await reader.api.call('post', `/saved-views/${id}/transfer`, { owner_id: reader.user.id, reason: 'take it' }, { 'If-Match': '"1"' })).status).toBe(403);
    // the owner edits; a System Admin edits with a reason
    const p = await lead.api.call('patch', `/saved-views/${id}`, { audience: { region_ids: [4] } }, { 'If-Match': '"1"' });
    expect(p.status).toBe(200);
    expect(p.body.audience.regions.map((r: { id: number }) => r.id)).toEqual([4]);
    expect((await admin.api.call('patch', `/saved-views/${id}`, { name: `Shared2 ${TAG}` }, { 'If-Match': '"2"' })).status).toBe(422);
    expect((await admin.api.call('patch', `/saved-views/${id}`, { name: `Shared2 ${TAG}`, reason: 'tidy' }, { 'If-Match': '"2"' })).status).toBe(200);
    const audit = await db.query(`SELECT action, actor_id::text AS actor, after FROM audit_log WHERE entity_type = 'saved_view' AND entity_id = $1 ORDER BY id`, [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['saved_view.create', 'saved_view.edit', 'saved_view.edit']);
    expect(audit.rows[0].after.audience.regions.map((r: { id: number }) => r.id)).toEqual([1, 4]);
    expect(audit.rows[0].after.filters.advanced).toEqual(tree);
    expect(audit.rows[1].after.audience.regions.map((r: { id: number }) => r.id)).toEqual([4]);
    expect(audit.rows[2].actor).toBe(admin.user.id);
    // pmis_app cannot write the region audience directly
    const direct = await db.query(`SELECT has_table_privilege('pmis_app', 'saved_view_region_targets', 'INSERT') AS i, has_table_privilege('pmis_app', 'saved_view_region_targets', 'SELECT') AS s`);
    expect(direct.rows[0]).toEqual({ i: false, s: true });
  });
});
