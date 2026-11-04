import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G, Team, approveFlex, post, recPath, team } from './reg-helpers';
import { day, downloadTemplate, fillTemplate, load, uploadFile } from './tpl-helpers';
import { actor, makeSite, plainAdmin, type Actor } from './wf-helpers';

/**
 * Migration 0057 (work package P5): the list catalogue (Q104), the new field types, Meetings (Q12, Q111) and the RF Height note (D108b).
 * Region 6 is used by this suite. The global Meetings cells are shared with registers-catalog and templates-import: the same advisory lock as registers-catalog.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 6;
const U = randomBytes(3).toString('hex');
let admin: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
});
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770101)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770101)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

async function globalCell(key: string, level: number, userId: string): Promise<void> {
  await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id IS NULL', [key, level]);
  const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ($1, $2, 'any_one'::"MatrixRule", NULL, true, now()) RETURNING id`, [key, level]);
  await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user'::"AssigneeKind", $2)`, [c.rows[0].id, userId]);
}

/** A team of a register without a site (global rows): L1 and L2 on the global cells, plus template rights for the entry holder. */
async function globalTeam(key = 'meetings', module = key): Promise<Team> {
  const entry = await actor(app, db, { level: 'entry', grants: [...G(module, 'view', 'create', 'edit'), ...G('templates', 'view', 'import', 'download_documents')], regions: [R], modules: null });
  const approve = await actor(app, db, { level: 'approve', grants: G(module, 'view', 'approve'), regions: [R], modules: null });
  await globalCell(key, 1, entry.user.id);
  await globalCell(key, 3, approve.user.id);
  return { entry, review: approve, approve, site: undefined as never, region: R, key };
}
const meetingsTeam = (): Promise<Team> => globalTeam();

const lists = (api: Actor['api']) => api.call('get', '/list-catalogues?include_inactive=true');

describe('Q104: the list catalogue', () => {
  it('seeds every register list with stable codes: the agreed lists confirmed, the others pending, the old values kept', async () => {
    const res = await lists(admin.api);
    expect(res.status).toBe(200);
    const by = (c: string) => res.body.items.find((x: { code: string }) => x.code === c);
    const spec = by('TeamSpecialization');
    expect(spec).toMatchObject({ status: 'confirmed', critical: true, allow_other: false });
    expect(spec.values.filter((v: { is_active: boolean }) => v.is_active).map((v: { code: string }) => v.code))
      .toEqual(['Tower RT', 'Tower GF', 'Adaption', 'TE', 'Dismantle', 'GECOL', 'Fiber', 'Survey']);
    expect(spec.values.find((v: { code: string }) => v.code === 'CW')).toMatchObject({ is_active: false, groups: ['CW'] });
    expect(by('StaffStatus')).toMatchObject({ status: 'confirmed' });
    expect(by('CompletionStatus').values.map((v: { code: string }) => v.code)).toEqual(['Done', 'Pending', 'N/A']);
    expect(by('Severity')).toMatchObject({ status: 'pending', critical: true });
    expect(by('RiskStatus')).toMatchObject({ status: 'pending', allow_other: true });
    expect(by('ProcScope').used_by).toEqual([{ register_key: 'procurement', field_code: 'scope' }]);
    expect(by('ActionStatus').used_by).toEqual([{ register_key: 'meetings', field_code: 'action_items_list', column: 'status' }]);
    // every list field of a register reads a catalogue
    const free = await q(db, `SELECT register_key, code FROM register_fields WHERE field_type = 'list' AND list_catalogue IS NULL AND NOT derived AND (options IS NULL OR jsonb_typeof(options) = 'array')`);
    expect(free).toEqual([]);
  });

  it('is written only by an admin of fields, with a reason, If-Match and audit; codes never change and never repeat', async () => {
    const plain = await actor(app, db, { level: 'entry', grants: G('meetings', 'view'), regions: [R], modules: null });
    const code = `P5Test${U}`;
    expect((await plain.api.call('post', '/list-catalogues', { code, name_en: 'Probe list', reason: 'test' })).status).toBe(403);
    expect((await admin.api.call('post', '/list-catalogues', { code, name_en: 'Probe list' })).status).toBe(422);
    const bad = await admin.api.call('post', '/list-catalogues', { code, name_en: 'Probe list', critical: true, allow_other: true, reason: 'Probe of P5' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ code: 'critical_closed' });
    const created = await admin.api.call('post', '/list-catalogues', { code, name_en: 'Probe list', critical: true, reason: 'Probe of P5' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code, status: 'pending', critical: true, values: [], version: 1 });
    // a list without a value cannot be confirmed
    const confirm = await admin.api.call('patch', `/list-catalogues/${code}`, { status: 'confirmed', reason: 'Owner agreed' }, { 'If-Match': '"1"' });
    expect(confirm.status).toBe(422);
    expect(confirm.body.errors[0]).toMatchObject({ path: '/status', code: 'no_values' });
    const a = await admin.api.call('post', `/list-catalogues/${code}/values`, { code: 'Alpha', label_ar: 'ألفا', aliases: ['A1'], reason: 'Probe of P5' });
    expect(a.status).toBe(201);
    // a label or an alias names one value only
    const dup = await admin.api.call('post', `/list-catalogues/${code}/values`, { code: 'Beta', aliases: ['a1'], reason: 'Probe of P5' });
    expect(dup.status).toBe(422);
    expect(dup.body.errors[0]).toMatchObject({ path: '/aliases', code: 'duplicate' });
    expect((await admin.api.call('post', `/list-catalogues/${code}/values`, { code: 'Alpha', reason: 'Probe of P5' })).status).toBe(409);
    const alpha = a.body.values[0];
    // the code of a value is fixed
    expect((await admin.api.call('patch', `/list-catalogues/${code}/values/${alpha.id}`, { code: 'Gamma', reason: 'rename' }, { 'If-Match': '"1"' })).status).toBe(422);
    // a critical list keeps its last active value
    const last = await admin.api.call('patch', `/list-catalogues/${code}/values/${alpha.id}`, { is_active: false, reason: 'Probe of P5' }, { 'If-Match': `"${alpha.version}"` });
    expect(last.status).toBe(422);
    expect(last.body.errors[0]).toMatchObject({ code: 'last_active_value' });
    const relabel = await admin.api.call('patch', `/list-catalogues/${code}/values/${alpha.id}`, { label_en: 'Alpha one', reason: 'Probe of P5' }, { 'If-Match': `"${alpha.version}"` });
    expect(relabel.status).toBe(200);
    expect(relabel.body.values[0]).toMatchObject({ code: 'Alpha', label_en: 'Alpha one', version: 2 });
    // stale If-Match
    expect((await admin.api.call('patch', `/list-catalogues/${code}/values/${alpha.id}`, { label_en: 'x', reason: 'Probe of P5' }, { 'If-Match': '"1"' })).status).toBe(412);
    const cur = (await admin.api.call('get', `/list-catalogues/${code}`)).body;
    const ok = await admin.api.call('patch', `/list-catalogues/${code}`, { status: 'confirmed', reason: 'Owner agreed' }, { 'If-Match': `"${cur.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('confirmed');
    const audit = await q<{ action: string; reason: string; before: unknown }>(db, `SELECT action, reason, before FROM audit_log WHERE entity_type = 'list_catalogue' AND entity_id LIKE $1 ORDER BY id`, [`${code}%`]);
    expect(audit.map((x) => x.action)).toEqual(['list_catalogue_create', 'list_value_create', 'list_value_update', 'list_catalogue_update']);
    expect(audit[2]!.before).toMatchObject({ label_en: 'Alpha' });
    // pmis_app cannot write the tables
    await expect(db.query('SET ROLE pmis_app; UPDATE list_values SET is_active = false; RESET ROLE')).rejects.toMatchObject({ code: '42501' });
    await db.query('RESET ROLE');
  });

  it('accepts a label or an alias for the code, keeps another value of an open list with the warning list_other, and refuses one of a critical list', async () => {
    const t = await team(app, db, 'issues', 'issues', R);
    const ok = await t.entry.api.call('post', recPath('issues'), { site_id: t.site.id, data: { pending_issue: 'x', raised_date: '2026-01-05', issue_status: 'in progress', owner_user: t.entry.user.id } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.issue_status).toBe('In Progress');
    const bad = await t.entry.api.call('post', recPath('issues'), { site_id: t.site.id, data: { pending_issue: 'x', raised_date: '2026-01-05', issue_status: 'Parked' } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/data/issue_status', code: 'not_in_list' });
    const rt = await team(app, db, 'rf_design', 'rf_design', R);
    const other = await rt.entry.api.call('post', recPath('rf_design'), { site_id: rt.site.id, data: { tower_type: 'Lattice 4-leg', site_type: 'core' } });
    expect(other.status).toBe(201);
    expect(other.body.data).toMatchObject({ tower_type: 'Lattice 4-leg', site_type: 'Core' });
    expect(other.body.warnings).toEqual([expect.objectContaining({ path: '/data/tower_type', code: 'list_other' })]);
    // the definition gives the list and its Arabic labels
    const defs = (await rt.entry.api.call('get', '/registers')).body.items.find((d: { register_key: string }) => d.register_key === 'rf_design');
    const tt = defs.fields.find((f: { code: string }) => f.code === 'tower_type');
    expect(tt).toMatchObject({ type: 'list', list: { code: 'TowerType', status: 'pending', allow_other: true, critical: false } });
  });

  it('refuses at submit a value that is deactivated, unless the previous version had it', async () => {
    const t = await globalTeam('contractors');
    await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, 'cw_contractor')`, [`P5 Co ${U}`]);
    const res = await t.entry.api.call('post', recPath('contractors'), { record_type: 'team', data: { team_name: `T-${U}`, contractor: `P5 Co ${U}`, specialization: 'CW' } });
    expect(res.status).toBe(201);
    const sub = await post(t.entry.api, 'contractors', res.body.id, 'submit', res.body.version);
    expect(sub.status).toBe(422);
    // since 0061 (P4b) the specialization catalogue gives the specific reason: CW is a functional group, not a value
    expect(sub.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/data/specialization', code: 'unknown_specialization' })]));
  });

  it('blocks the final approval while a critical list of the register has no active value', async () => {
    await db.query('BEGIN');
    try {
      await db.query(`UPDATE list_values SET is_active = false WHERE catalogue_code = 'Severity'`);
      const site = await makeSite(db, R, { prefix: 'P5' });
      const r = await db.query(`INSERT INTO register_records (entity_id, register_key, record_type, site_id, region_id, state, current_level, data)
        VALUES (gen_random_uuid(), 'quality', 'qc', $1, $2, 'in_approval', 2, '{"record_code": "P5-X"}') RETURNING id`, [site.id, R]);
      await expect(db.query(`UPDATE register_records SET state = 'approved' WHERE id = $1`, [r.rows[0].id])).rejects.toThrow(/list_not_configured.*Severity/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

describe('Q12 and Q111: Meetings with structured fields', () => {
  it('has the structured fields, keeps the old text read-only, and the RF Height note sits beside the number (D108b)', async () => {
    const defs = (await admin.api.call('get', '/registers')).body.items;
    const m = defs.find((d: { register_key: string }) => d.register_key === 'meetings');
    const f = (c: string) => m.fields.find((x: { code: string }) => x.code === c);
    expect(f('meeting_date')).toMatchObject({ required: true, label_ar: 'التاريخ' });
    expect(f('title')).toMatchObject({ required: true });
    expect(f('organiser')).toMatchObject({ type: 'user', required: false });
    expect(f('attendee_users')).toMatchObject({ type: 'multi_user' });
    expect(f('linked_site_ids')).toMatchObject({ type: 'multi_site' });
    expect(f('minutes_file')).toMatchObject({ type: 'file' });
    expect(f('action_items_list').type).toBe('child_list');
    expect(f('action_items_list').columns.map((c: { code: string }) => c.code)).toEqual(['description', 'owner', 'due_date', 'status', 'closed_date', 'task_id']);
    expect(f('action_items_list').columns[3]).toMatchObject({ type: 'list', list: { code: 'ActionStatus' } });
    for (const c of ['attendees', 'linked_sites', 'minutes_ref', 'action_items']) expect(f(c)).toMatchObject({ read_only: true });
    const ab = defs.find((d: { register_key: string }) => d.register_key === 'as_built');
    expect(ab.fields.find((x: { code: string }) => x.code === 'rf_height')).toMatchObject({ type: 'number' });
    expect(ab.fields.find((x: { code: string }) => x.code === 'rf_height_note')).toMatchObject({ type: 'text', required: false });
  });

  it('checks people, sites and action rows, gives each row a stable id, resolves the ids, and wants a real minutes file at submit', async () => {
    const t = await meetingsTeam();
    const site = await makeSite(db, R, { prefix: 'P5M' });
    const foreign = await makeSite(db, 1, { prefix: 'P5F' });
    const base = { meeting_date: '2026-01-08', title: `P5 ${U}`, meeting_type: 'Weekly progress' };
    // a person by employee ID, a site by code; a site of another region is unknown to this caller
    const badSite = await t.entry.api.call('post', recPath('meetings'), { data: { ...base, linked_site_ids: [foreign.code] } });
    expect(badSite.status).toBe(422);
    expect(badSite.body.errors[0]).toMatchObject({ path: '/data/linked_site_ids/0', code: 'unknown_site' });
    // a closed action needs its closed date
    const action = { description: 'Send the LLD', owner: t.entry.user.employeeId, due_date: '2026-01-20', status: 'Done' };
    const noClose = await t.entry.api.call('post', recPath('meetings'), { data: { ...base, action_items_list: [action] } });
    expect(noClose.status).toBe(422);
    expect(noClose.body.errors[0]).toMatchObject({ path: '/data/action_items_list/0/closed_date', code: 'required' });
    const res = await t.entry.api.call('post', recPath('meetings'), {
      data: { ...base, organiser: t.entry.user.id, attendee_users: [t.entry.user.employeeId, t.approve.user.email, t.entry.user.id], linked_site_ids: [site.code],
        action_items_list: [{ ...action, status: 'open' }] },
    });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d.attendee_users).toEqual([t.entry.user.id, t.approve.user.id]);
    expect(d.linked_site_ids).toEqual([site.id]);
    expect(d.action_items_list[0]).toMatchObject({ description: 'Send the LLD', owner: t.entry.user.id, status: 'Open' });
    const rowId = d.action_items_list[0].id as string;
    expect(rowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.refs.users[t.approve.user.id]).toMatchObject({ display_name: t.approve.user.name });
    expect(res.body.refs.sites[site.id]).toBe(site.code);
    expect(res.body.warnings).toEqual([expect.objectContaining({ path: '/data/meeting_type', code: 'list_other' })]);
    // the row keeps its id when the record is saved again
    const again = await t.entry.api.call('patch', recPath('meetings', res.body.id), { data: { action_items_list: d.action_items_list } }, { 'If-Match': `"${res.body.version}"` });
    expect(again.status).toBe(200);
    expect(again.body.data.action_items_list[0].id).toBe(rowId);
    // a typed reference is not an upload
    const fake = randomUUID();
    const withFake = await t.entry.api.call('patch', recPath('meetings', res.body.id), { data: { minutes_file: fake } }, { 'If-Match': `"${again.body.version}"` });
    expect(withFake.status).toBe(200);
    const refused = await post(t.entry.api, 'meetings', res.body.id, 'submit', withFake.body.version);
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ path: '/data/minutes_file', code: 'file_not_attached' });
    // a file of a document slot of the record (the slot of a global record comes with Q228; here it is planted by the migration role)
    const dt = await db.query(`INSERT INTO document_types (code, name_en, updated_at) VALUES ($1, 'Minutes', now()) RETURNING id`, [`P5MIN${U}`]);
    const slot = await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id, status, register_entity_id, register_key) VALUES ($1, $2, $3, 'uploaded', $4, 'meetings') RETURNING id`,
      [site.id, R, dt.rows[0].id, res.body.entity_id]);
    const file = await db.query(`INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, size_bytes, sha256, uploaded_by)
      VALUES ($1, gen_random_uuid(), 'minutes.pdf', 'minutes.pdf', $2, 'application/pdf', 10, 'x', $3) RETURNING id`, [slot.rows[0].id, `p5/${U}`, t.entry.user.id]);
    const real = await t.entry.api.call('patch', recPath('meetings', res.body.id), { data: { minutes_file: file.rows[0].id } }, { 'If-Match': `"${withFake.body.version}"` });
    expect(real.body.refs.files[file.rows[0].id]).toBe('minutes.pdf');
    const done = await approveFlex(t, res.body.id, real.body.version);
    expect(done.state).toBe('approved');
  });

  it('converts the old text once, after review, without duplicating an action; the proposal saves nothing', async () => {
    const t = await meetingsTeam();
    const site = await makeSite(db, R, { prefix: 'P5L' });
    const res = await t.entry.api.call('post', recPath('meetings'), { data: { meeting_date: '2026-01-09', title: `Old ${U}`, action_items_list: [{ description: 'Order the cabinet', owner: t.entry.user.id, due_date: '2026-02-01', status: 'Open' }] } });
    expect(res.status).toBe(201);
    // the old free text, as 0025 stored it
    await db.query(`UPDATE register_records SET data = data || $2::jsonb WHERE id = $1`, [res.body.id, JSON.stringify({
      attendees: `${t.entry.user.name}, ${t.approve.user.employeeId}, Mr Unknown`, linked_sites: `${site.code}; NOPE-1`, minutes_ref: 'MoM-12 in the share',
      action_items: '- Order the cabinet\n2) Book the crane',
    })]);
    const prop = await t.entry.api.call('get', recPath('meetings', res.body.id, '/legacy-conversion'));
    expect(prop.status).toBe(200);
    expect(prop.body).toMatchObject({ converted: false, minutes_note: 'MoM-12 in the share', unmatched: { attendees: ['Mr Unknown'], sites: ['NOPE-1'] } });
    expect(prop.body.attendees.map((a: { user_id: string }) => a.user_id)).toEqual([t.entry.user.id, t.approve.user.id]);
    expect(prop.body.sites).toEqual([expect.objectContaining({ site_id: site.id, site_code: site.code })]);
    expect(prop.body.action_items).toEqual([{ description: 'Order the cabinet', status: 'Open' }, { description: 'Book the crane', status: 'Open' }]);
    const cur = (await t.entry.api.call('get', recPath('meetings', res.body.id))).body;
    expect(cur.version).toBe(res.body.version);   // nothing saved
    const values = {
      attendee_users: prop.body.attendees.map((a: { user_id: string }) => a.user_id),
      linked_site_ids: prop.body.sites.map((s: { site_id: string }) => s.site_id),
      action_items_list: prop.body.action_items.map((a: { description: string; status: string }) => ({ ...a, owner: t.entry.user.id, due_date: '2026-02-10' })),
    };
    expect((await t.entry.api.call('post', recPath('meetings', res.body.id, '/legacy-conversion'), { values }, { 'If-Match': `"${cur.version}"` })).status).toBe(422);   // no reason
    const conv = await t.entry.api.call('post', recPath('meetings', res.body.id, '/legacy-conversion'), { values, reason: 'Reviewed the old text' }, { 'If-Match': `"${cur.version}"` });
    expect(conv.status).toBe(200);
    expect(conv.body.data.attendee_users).toEqual([t.entry.user.id, t.approve.user.id]);
    expect(conv.body.data.linked_site_ids).toEqual([site.id]);
    expect(conv.body.data.action_items_list.map((a: { description: string }) => a.description)).toEqual(['Order the cabinet', 'Book the crane']);
    expect(conv.body.data).toMatchObject({ attendees: expect.any(String), legacy_converted_by: t.entry.user.id });
    const twice = await t.entry.api.call('post', recPath('meetings', res.body.id, '/legacy-conversion'), { values, reason: 'Again' }, { 'If-Match': `"${conv.body.version}"` });
    expect(twice.status).toBe(409);
    const audit = await q<{ before: Record<string, unknown>; reason: string }>(db, `SELECT before, reason FROM audit_log WHERE action = 'meeting_legacy_convert' AND entity_id = $1`, [res.body.entity_id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ minutes_ref: 'MoM-12 in the share' });
    // the old text cannot be typed any more
    const typed = await t.entry.api.call('patch', recPath('meetings', res.body.id), { data: { attendees: 'x' } }, { 'If-Match': `"${conv.body.version}"` });
    expect(typed.status).toBe(422);
    expect(typed.body.errors[0]).toMatchObject({ path: '/data/attendees', code: 'field_read_only' });
    // another register has no conversion
    expect((await t.entry.api.call('get', recPath('risks', res.body.id, '/legacy-conversion'))).status).toBe(404);
  });

  it('round-trips the new types through the approved template (multi values separated by ";")', async () => {
    const t = await meetingsTeam();
    const site = await makeSite(db, R, { prefix: 'P5T' });
    const dl = await downloadTemplate(t.entry.api, 'TPL-MTG');
    expect(dl.status).toBe(200);
    const ws = (await load(dl.buffer)).getWorksheet('Data')!;
    const headers = ws.getRow(1).values as string[];
    expect(headers).toEqual(expect.arrayContaining(['Date', 'Title', 'Organiser', 'Attendees', 'Linked sites', 'Action items']));
    const title = `Tpl ${U}`;
    const up = await uploadFile(t.entry.api, await fillTemplate(dl.buffer, [{ Date: day('2026-02-03'), Title: title, Attendees: `${t.entry.user.employeeId}; ${t.approve.user.email}`, 'Linked sites': site.code }]));
    expect(up.status).toBe(202);
    expect(up.body.counts).toMatchObject({ create: 1, error: 0 });
    const sub = await t.entry.api.call('post', `/import-batches/${up.body.id}/submit`, undefined, { 'If-Match': '"1"' });
    expect(sub.body.outcome).toMatchObject({ submitted: 1, failed: [] });
    const rec = await q<{ data: Record<string, unknown> }>(db, `SELECT data FROM register_records WHERE register_key = 'meetings' AND data ->> 'title' = $1`, [title]);
    expect(rec[0]!.data).toMatchObject({ attendee_users: [t.entry.user.id, t.approve.user.id], linked_site_ids: [site.id] });
    // the pre-filled copy shows the codes a person types
    const pre = await downloadTemplate(t.entry.api, 'TPL-MTG', '?prefill=true');
    const pws = (await load(pre.buffer)).getWorksheet('Data')!;
    const head = pws.getRow(1).values as string[];
    let found = false;
    pws.eachRow((row, n) => {
      if (n === 1 || row.getCell(head.indexOf('Title')).value !== title) return;
      found = true;
      expect(row.getCell(head.indexOf('Attendees')).value).toBe(`${t.entry.user.employeeId}; ${t.approve.user.employeeId}`);
      expect(row.getCell(head.indexOf('Linked sites')).value).toBe(site.code);
    });
    expect(found).toBe(true);
    // an unknown person is a cell error
    const bad = await uploadFile(t.entry.api, await fillTemplate(dl.buffer, [{ Date: day('2026-02-04'), Title: `Bad ${U}`, Attendees: 'nobody@example.test' }]));
    const rows = (await t.entry.api.call('get', `/import-batches/${bad.body.id}/rows`)).body.items;
    expect(rows[0].errors[0]).toMatchObject({ field: expect.stringMatching(/^attendee_users/), code: 'unknown_user' });
  });
});

