import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delegate, loggedIn, makeUser, startApp, superDbDocs, type Api } from './helpers';
import { PDF, PNG, EXE, docFlow, slotOf, slots, submit, upload } from './doc-helpers';
import { actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * The Document Library (admin): CRUD, versions, deactivation, publish scope, blank forms, permissions, the seed. Runs on the fifth database.
 * The open-task suites use the task codes F1 and F2 in region 6 only, so the other document suites do not meet them.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Api;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
  admin = (await plainAdmin(app, db, true)).api;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
let n = 0;
const code = (p: string): string => `${p}${(Date.now() % 100000).toString(36).toUpperCase()}${n++}`;
const ifm = (res: { headers: Record<string, unknown> }) => ({ 'If-Match': String(res.headers.etag) });
const base = (c: string, tasks: string[], over: Record<string, unknown> = {}) => ({
  code: c, kind: 'scanned_document', name_en: `Test doc ${c}`, placements: tasks.map((t) => ({ target: 'task', ref: t })), reason: 'test', ...over,
});
const create = (api: Api, body: Record<string, unknown>) => api.call('post', '/document-library', body);
const publish = (api: Api, id: string, etag: Record<string, string>, apply: 'new_only' | 'open_too', reason = 'test publish') =>
  api.call('post', `/document-library/${id}/publish`, { reason, effective_from: '2026-11-02', apply_to: apply }, etag);
async function made(api: Api, body: Record<string, unknown>, apply: 'new_only' | 'open_too' = 'new_only'): Promise<{ id: string; code: string }> {
  const c = await create(api, body);
  expect(c.status).toBe(201);
  const p = await publish(api, c.body.id, ifm(c), apply);
  expect(p.status).toBe(200);
  return { id: c.body.id as string, code: body.code as string };
}
const get = async (id: string) => (await admin.call('get', `/document-library/${id}`));

describe('the seed library', () => {
  it('publishes stages 1 to 3 as listed in CLAUDE.md, with the defaults', async () => {
    const r = await admin.call('get', '/document-library?limit=200');
    expect(r.status).toBe(200);
    const by = new Map<string, Record<string, unknown>>((r.body.items as { code: string }[]).map((i) => [i.code, i]));
    for (const c of ['A1', 'A2', 'A3', 'A3_CAA', 'A4', 'B1', 'B2', 'B3', 'B4', 'B6', 'B7', 'B7_DN', 'B9']) {
      expect(by.get(c), c).toMatchObject({ published_version: 1, has_unpublished_changes: false, needs_review: false, is_active: true });
    }
    expect(by.get('A2')).toMatchObject({ kind: 'scanned_document', formats: ['pdf', 'jpg', 'jpeg', 'png'], max_size_mb: 20, min_files: 1, max_files: null, mandatory: true, placements: [{ target: 'task', ref: 'A2' }] });
    expect(by.get('A3_CAA')!.condition_rule).toEqual({ is_yes: 'site.custom.near_airport' });
    expect(by.get('B1')).toMatchObject({ kind: 'email', mandatory: true });
    expect(by.get('B1')!.formats).toEqual(expect.arrayContaining(['eml', 'msg', 'pdf']));
    expect(by.get('B7_DN')).toMatchObject({ kind: 'generated_form', form_kind: 'dn' });
    expect(by.get('B9')).toMatchObject({ kind: 'photo', placements: [{ target: 'task', ref: 'B8' }, { target: 'task', ref: 'B9' }] });
    // B11 has no document
    expect([...by.values()].some((i) => (i.placements as { ref: string }[]).some((p) => p.ref === 'B11'))).toBe(false);
  });

  it('seeds stages 4 to 10 as drafts to review, on no task until published', async () => {
    const r = await admin.call('get', '/document-library?limit=200');
    const drafts = (r.body.items as { code: string; needs_review: boolean; published_version: number; has_unpublished_changes: boolean }[]).filter((i) => i.needs_review);
    expect(drafts.length).toBeGreaterThanOrEqual(35);
    expect(drafts.every((d) => d.published_version === 0 && d.has_unpublished_changes)).toBe(true);
    expect(drafts.map((d) => d.code)).toEqual(expect.arrayContaining(['B13_PAC', 'D16_PAC', 'D17_HOTO', 'B15_FAC', 'Z1_CLOSURE']));
    // a D16 task opens with no document slot
    const f = await docFlow(app, db, 'D16', { region: 6 });
    expect(await slots(f.e.api, f.taskId)).toEqual([]);
    // publishing a reviewed draft puts it on the tasks that open from then on and clears the review flag
    const d = await admin.call('get', `/document-library?placement_ref=D16&limit=200`);
    const pac = (d.body.items as { id: string; code: string }[]).find((i) => i.code === 'D16_PAC')!;
    const g = await get(pac.id);
    const p = await publish(admin, pac.id, ifm(g), 'new_only', 'reviewed by the product owner');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ published_version: 1, affected_open_tasks: 0 });
    expect(await slots(f.e.api, f.taskId)).toEqual([]); // the open task keeps its set
    const f2 = await docFlow(app, db, 'D16', { region: 6, entry: f.e, approve: f.a });
    expect((await slots(f.e.api, f2.taskId)).map((s) => s.doc_code)).toEqual(['D16_PAC']);
    expect((await get(pac.id)).body).toMatchObject({ needs_review: false, published_version: 1, has_unpublished_changes: false });
  });
});

describe('CRUD, validation and versioning', () => {
  it('creates a draft that reaches no task until it is published', async () => {
    const c = code('TDRAFT');
    const r = await create(admin, base(c, ['F2'], { name_ar: 'مستند اختبار', mandatory: true }));
    expect(r.status).toBe(201);
    expect(r.headers.etag).toBeDefined();
    expect(r.body).toMatchObject({ code: c, published_version: 0, has_unpublished_changes: true, is_active: true, name_ar: 'مستند اختبار', formats: ['pdf', 'jpg', 'jpeg', 'png'], max_size_mb: 20, min_files: 1, max_files: null, kind: 'scanned_document' });
    const f = await docFlow(app, db, 'F2', { region: 6 });
    expect((await slots(f.e.api, f.taskId)).map((s) => s.doc_code)).not.toContain(c);
    expect((await admin.call('get', `/document-library/${r.body.id}/versions`)).body.items).toEqual([]);
    expect((await admin.call('get', `/document-library?placement_ref=F2&limit=200`)).body.items.some((i: { code: string }) => i.code === c)).toBe(true);
    expect((await q('SELECT 1 FROM audit_log WHERE action = $1 AND entity_id = $2 AND reason = $3', ['document_type_create', r.body.id, 'test'])).length).toBe(1);
  });

  it('validates the definition with field errors', async () => {
    const bad = async (over: Record<string, unknown>, status: number, path?: string) => {
      const r = await create(admin, base(code('TBAD'), ['F2'], over));
      expect(r.status, JSON.stringify(over)).toBe(status);
      if (path) expect(r.body.errors.map((e: { path: string }) => e.path), JSON.stringify(r.body)).toContain(path);
    };
    await bad({ code: 'lower' }, 422, '/code');
    await bad({ name_en: 'x' }, 422, '/name_en');
    await bad({ placements: [] }, 422, '/placements');
    await bad({ placements: [{ target: 'task', ref: 'NOPE99' }] }, 422, '/placements/0');
    await bad({ placements: [{ target: 'register', ref: 'nope_register' }] }, 422, '/placements/0');
    await bad({ formats: ['pdf', 'exe'] }, 422, '/formats');
    await bad({ formats: ['html'] }, 422, '/formats');
    await bad({ formats: ['zip'] }, 422, '/formats');
    await bad({ formats: ['xlsm'] }, 422, '/formats');
    await bad({ max_size_mb: 0 }, 422);
    await bad({ max_size_mb: 500 }, 422);
    await bad({ min_files: 3, max_files: 2 }, 422, '/max_files');
    await bad({ kind: 'generated_form' }, 422, '/form_kind');
    await bad({ kind: 'photo', form_kind: 'dn' }, 422, '/form_kind');
    await bad({ unknown_field: 1 }, 422);
    await bad({ reason: 'x' }, 422);
    const ok = await create(admin, base(code('TOK'), ['F2'], { kind: 'generated_form', form_kind: 'pac', formats: ['pdf'], max_size_mb: 5, min_files: 1, max_files: 2, condition_rule: { is_yes: 'site.custom.x' }, photo_rules: null, expiry_tracked: true }));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: 'generated_form', form_kind: 'pac', max_files: 2, expiry_tracked: true, condition_rule: { is_yes: 'site.custom.x' } });
    const dup = await create(admin, base(ok.body.code, ['F2']));
    expect(dup.status).toBe(409);
  });

  it('edits the draft with If-Match, and publishing writes immutable versions with the reason and scope', async () => {
    const c = code('TVER');
    const r = await create(admin, base(c, ['F2'], { mandatory: false }));
    const noMatch = await admin.call('patch', `/document-library/${r.body.id}`, { name_en: 'Renamed', reason: 'rename' });
    expect(noMatch.status).toBe(428);
    const patched = await admin.call('patch', `/document-library/${r.body.id}`, { name_en: 'Renamed', max_files: 3, reason: 'rename and limit' }, ifm(r));
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name_en: 'Renamed', max_files: 3, published_version: 0 });
    expect(Number(String(patched.headers.etag).replace(/"/g, ''))).toBeGreaterThan(Number(String(r.headers.etag).replace(/"/g, '')));
    const stale = await admin.call('patch', `/document-library/${r.body.id}`, { name_en: 'Again', reason: 'again' }, ifm(r));
    expect(stale.status).toBe(412);
    expect((await admin.call('patch', `/document-library/${r.body.id}`, { reason: 'nothing' }, ifm(patched))).status).toBe(422);
    expect((await admin.call('patch', `/document-library/${r.body.id}`, { code: 'OTHER', reason: 'no' }, ifm(patched))).status).toBe(422);

    const p1 = await publish(admin, r.body.id, ifm(patched), 'new_only', 'first release');
    expect(p1.body).toMatchObject({ published_version: 1, affected_open_tasks: 0 });
    const g1 = await get(r.body.id);
    expect(g1.body).toMatchObject({ published_version: 1, has_unpublished_changes: false, name_en: 'Renamed', mandatory: false });
    const e2 = await admin.call('patch', `/document-library/${r.body.id}`, { mandatory: true, name_en: 'Renamed twice', reason: 'now mandatory' }, ifm(g1));
    expect(e2.body.has_unpublished_changes).toBe(true);
    // before the publish nothing changed for tasks: the live definition is still version 1
    expect((await q<{ is_mandatory: boolean; name_en: string }>('SELECT is_mandatory, name_en FROM document_types WHERE id = $1', [r.body.id]))[0]).toEqual({ is_mandatory: false, name_en: 'Renamed' });
    const p2 = await publish(admin, r.body.id, ifm(e2), 'new_only', 'make it mandatory');
    expect(p2.body.published_version).toBe(2);
    const v = await admin.call('get', `/document-library/${r.body.id}/versions`);
    expect(v.body.items.map((x: { version_no: number }) => x.version_no)).toEqual([2, 1]);
    expect(v.body.items[0]).toMatchObject({ apply_to: 'new_only', reason: 'make it mandatory', spec: { mandatory: true, name_en: 'Renamed twice' } });
    expect(v.body.items[1].spec).toMatchObject({ mandatory: false, name_en: 'Renamed' });
    expect(v.body.items[0].published_by.id).toBeDefined();
    // versions never change and are never deleted
    await expect(db.query('UPDATE document_type_versions SET reason = $2 WHERE doc_type_id = $1', [r.body.id, 'x'])).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM document_type_versions WHERE doc_type_id = $1', [r.body.id])).rejects.toThrow(/immutable/);
    const audit = await q<{ before: { published_version: number }; after: { apply_to: string; published_version: number } }>(`SELECT before, after FROM audit_log WHERE action = 'document_type_publish' AND entity_id = $1 ORDER BY id`, [r.body.id]);
    expect(audit).toHaveLength(2);
    expect(audit[1]!.after).toMatchObject({ apply_to: 'new_only', published_version: 2 });
    expect(audit[1]!.before).toMatchObject({ published_version: 1 });
    // nothing to publish now
    expect((await publish(admin, r.body.id, ifm(await get(r.body.id)), 'new_only')).status).toBe(422);
  });

  it('deactivates and never deletes', async () => {
    const d = await made(admin, base(code('TDEA'), ['F2']));
    const g = await get(d.id);
    const off = await admin.call('patch', `/document-library/${d.id}`, { is_active: false, reason: 'no longer needed' }, ifm(g));
    expect(off.body).toMatchObject({ is_active: false, has_unpublished_changes: true });
    expect((await admin.call('delete', `/document-library/${d.id}`)).status).toBe(404);
    await publish(admin, d.id, ifm(off), 'new_only', 'retire');
    const inactive = await admin.call('get', `/document-library?placement_ref=F2&limit=200`);
    expect(inactive.body.items.some((i: { code: string }) => i.code === d.code)).toBe(false);
    const all = await admin.call('get', `/document-library?placement_ref=F2&include_inactive=true&limit=200`);
    expect(all.body.items.find((i: { code: string }) => i.code === d.code)).toMatchObject({ is_active: false, published_version: 2 });
    expect((await q('SELECT 1 FROM document_types WHERE id = $1', [d.id])).length).toBe(1);
    await expect(db.query('DELETE FROM document_types WHERE id = $1', [d.id])).rejects.toThrow();
  });

  it('filters the list and pages it', async () => {
    const r = await admin.call('get', '/document-library?kind=photo&include_inactive=true&limit=200');
    expect(r.body.items.every((i: { kind: string }) => i.kind === 'photo')).toBe(true);
    expect(r.body.items.map((i: { code: string }) => i.code)).toContain('B9');
    const p1 = await admin.call('get', '/document-library?limit=2');
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.page.next_cursor).not.toBeNull();
    const p2 = await admin.call('get', `/document-library?limit=2&cursor=${p1.body.page.next_cursor}`);
    expect(p2.body.items[0].code > p1.body.items[1].code).toBe(true);
    expect((await admin.call('get', '/document-library?kind=nope')).status).toBe(422);
    expect((await admin.call('get', '/document-library/not-a-uuid')).status).toBe(404);
  });
});

describe('who may write the library', () => {
  it('refuses everyone without the right, answers an admin delegate, and requires step-up to publish', async () => {
    const plain = await actor(app, db, { level: 'entry', regions: [6], grants: [['sites', 'view'], ['sites', 'edit']] });
    const target = await made(admin, base(code('TPERM'), ['F2']));
    const g = await get(target.id);
    expect((await create(plain.api, base(code('TNO'), ['F2']))).status).toBe(403);
    expect((await plain.api.call('patch', `/document-library/${target.id}`, { name_en: 'Hacked', reason: 'test' }, ifm(g))).status).toBe(403);
    expect((await plain.api.call('post', `/document-library/${target.id}/publish`, { reason: 'test', effective_from: '2026-11-02', apply_to: 'new_only' }, ifm(g))).status).toBe(403);
    expect((await plain.api.call('post', `/document-library/${target.id}/blank-form`, undefined, ifm(g)).attach('file', PDF, 'f.pdf')).status).toBe(403);
    expect((await plain.api.call('get', '/document-library')).status).toBe(403);
    expect((await plain.api.call('get', `/document-library/${target.id}/versions`)).status).toBe(403);
    expect((await q('SELECT name_en FROM document_types WHERE id = $1', [target.id]))[0]!.name_en).not.toBe('Hacked');

    // a delegate of documents.edit (create, edit, delete on document_types) writes; the database checks the delegation itself
    const user = await makeUser(db, { assigned: true });
    await delegate(db, user.id, [['document_types', 'create'], ['document_types', 'edit'], ['document_types', 'delete']]);
    const del = await loggedIn(app, user);
    const c = await create(del, base(code('TDEL'), ['F2']));
    expect(c.status).toBe(201);
    expect((await del.call('get', `/document-library/${c.body.id}`)).status).toBe(200);
    // publish needs a fresh step-up
    const noStep = await publish(del, c.body.id, ifm(c), 'new_only');
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect((await del.stepUp(user.password)).status).toBe(200);
    expect((await publish(del, c.body.id, ifm(c), 'new_only')).status).toBe(200);
    // the audit shows the delegate and the reason
    const audit = await q<{ actor_id: string; reason: string }>(`SELECT actor_id, reason FROM audit_log WHERE action = 'document_type_publish' AND entity_id = $1`, [c.body.id]);
    expect(audit[0]).toMatchObject({ actor_id: user.id, reason: 'test publish' });
    // a delegate of something else does not
    const other = await makeUser(db, { assigned: true });
    await delegate(db, other.id, [['calendars', 'edit']]);
    expect((await create(await loggedIn(app, other), base(code('TOTH'), ['F2']))).status).toBe(403);
  });
});

describe('publish: new tasks only, or also open tasks', () => {
  it('keeps the slot set of open tasks on new_only, adds and retires slots on open_too, and never touches approved tasks or tasks in review', async () => {
    const x = await made(admin, base(code('TX'), ['F1']));
    const f = await docFlow(app, db, 'F1', { region: 6 });
    const t1 = f.taskId;
    expect((await slots(f.e.api, t1)).map((s) => s.doc_code)).toEqual([x.code]);
    // an approved task and a task in approval, built before the publishes below
    const approvedTask = await makeTask(db, await makeSite(db, 6), 'F1', 'approved');
    const reviewTask = await makeTask(db, await makeSite(db, 6), 'F1', 'in_approval');

    // new_only: a new mandatory document is not on the open task, and does not block its submission
    const y = await made(admin, base(code('TY'), ['F1']), 'new_only');
    expect((await slots(f.e.api, t1)).map((s) => s.doc_code)).toEqual([x.code]);
    const f2 = await docFlow(app, db, 'F1', { region: 6, entry: f.e, approve: f.a });
    expect((await slots(f.e.api, f2.taskId)).map((s) => s.doc_code).sort()).toEqual([x.code, y.code].sort());
    await upload(f.e.api, t1, (await slotOf(f.e.api, t1, x.code)).id, PDF, 'x.pdf');
    expect((await f.e.api.call('get', `/tasks/${t1}`)).body.missing_for_submit).toEqual([]);

    // open_too: the open tasks get it; approved tasks and tasks in review do not change
    const zc = code('TZ');
    const z = await create(admin, base(zc, ['F1'], { formats: ['pdf', 'png'] }));
    const open = await q<{ n: string }>(`SELECT count(*) AS n FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE td.code = 'F1' AND t.state IN ('open', 'entry')`);
    expect((await get(z.body.id)).body.open_task_count).toBe(Number(open[0]!.n));
    const pz = await publish(admin, z.body.id, ifm(z), 'open_too', 'apply to open tasks');
    expect(pz.body.affected_open_tasks).toBe(Number(open[0]!.n));
    expect(pz.body.affected_open_tasks).toBeGreaterThanOrEqual(2);
    const s1 = await slots(f.e.api, t1);
    expect(s1.map((s) => s.doc_code).sort()).toEqual([x.code, zc].sort());
    expect(s1.find((s) => s.doc_code === zc)).toMatchObject({ status: 'missing', mandatory: true });
    expect((await f.e.api.call('get', `/tasks/${t1}`)).body.missing_for_submit).toEqual([zc]);
    expect((await slots(f.e.api, f2.taskId)).map((s) => s.doc_code)).toContain(zc);
    expect(await slots(f.a.api, approvedTask)).toEqual([]);
    expect(await slots(f.a.api, reviewTask)).toEqual([]);
    expect((await f.e.api.call('get', `/tasks/${approvedTask}`)).body.state).toBe('approved');

    // changed rules apply to the next upload of the open task
    const g = await get(z.body.id);
    const narrower = await admin.call('patch', `/document-library/${z.body.id}`, { formats: ['png'], max_size_mb: 2, reason: 'PNG only' }, ifm(g));
    expect((await slotOf(f.e.api, t1, zc)).formats).toEqual(['pdf', 'png']); // not yet published
    await publish(admin, z.body.id, ifm(narrower), 'open_too', 'PNG only');
    const zs = await slotOf(f.e.api, t1, zc);
    expect(zs).toMatchObject({ formats: ['png'], max_size_mb: 2 });
    expect((await upload(f.e.api, t1, zs.id, PDF, 'z.pdf')).body.reason).toBe('format_not_allowed');
    expect((await upload(f.e.api, t1, zs.id, PNG, 'z.png')).status).toBe(201);

    // deactivating with open_too: the slot is not required, the file is kept
    const gx = await get(x.id);
    const off = await admin.call('patch', `/document-library/${x.id}`, { is_active: false, reason: 'retired' }, ifm(gx));
    await publish(admin, x.id, ifm(off), 'open_too', 'retired');
    const xs = await slotOf(f.e.api, t1, x.code);
    expect(xs.status).toBe('not_required');
    expect(xs.files).toHaveLength(1);
    expect((await f.e.api.call('get', `/tasks/${t1}`)).body.missing_for_submit).toEqual([]);
    expect((await submit(f.e, t1)).status).toBe(200);
  });

  it('a deactivation published for new tasks only leaves the open task as it is', async () => {
    const x = await made(admin, base(code('TKEEP'), ['F1']));
    const f = await docFlow(app, db, 'F1', { region: 6 });
    expect((await slots(f.e.api, f.taskId)).map((s) => s.doc_code)).toContain(x.code);
    const g = await get(x.id);
    const off = await admin.call('patch', `/document-library/${x.id}`, { is_active: false, reason: 'retire for new tasks' }, ifm(g));
    const p = await publish(admin, x.id, ifm(off), 'new_only', 'retire for new tasks');
    expect(p.body.affected_open_tasks).toBe(0);
    expect((await slotOf(f.e.api, f.taskId, x.code)).status).toBe('missing');
    const f2 = await docFlow(app, db, 'F1', { region: 6, entry: f.e, approve: f.a });
    expect((await slots(f.e.api, f2.taskId)).map((s) => s.doc_code)).not.toContain(x.code);
  });
});

describe('the blank form', () => {
  it('is saved to the draft, live on publish, downloadable (audited) and refuses programs', async () => {
    const d = await created();
    expect((await admin.call('get', `/document-library/${d.id}/blank-form`)).status).toBe(404);
    const exe = await admin.call('post', `/document-library/${d.id}/blank-form`, undefined, ifm(d.res)).attach('file', EXE, 'form.pdf');
    expect(exe.status).toBe(422);
    expect(exe.body.reason).toBe('executable');
    const up = await admin.call('post', `/document-library/${d.id}/blank-form`, undefined, ifm(d.res)).attach('file', PDF, 'Blank form.pdf').field('reason', 'official blank');
    expect(up.status).toBe(200);
    expect(up.body.blank_form_file_id).toBeTruthy();
    expect(up.body.has_unpublished_changes).toBe(true);
    expect((await q<{ blank_form_file_id: string | null }>('SELECT blank_form_file_id FROM document_types WHERE id = $1', [d.id]))[0]!.blank_form_file_id).toBeNull();
    expect((await publish(admin, d.id, ifm(up), 'new_only')).status).toBe(200);
    const r = await admin.call('get', `/document-library/${d.id}/blank-form`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+_BLANK-FORM\.pdf"$/);
    expect((r.body as Buffer).equals(PDF)).toBe(true);
    expect((await q('SELECT 1 FROM audit_log WHERE action = $1 AND entity_id = $2', ['document_blank_form_download', d.id])).length).toBe(1);
    // the slot of a task that opens now offers it, and a person with the download right gets it by its id
    const f = await docFlow(app, db, 'F2', { region: 6 });
    const s = await slotOf(f.e.api, f.taskId, d.code);
    expect(s.blank_form_file_id).toBe(up.body.blank_form_file_id);
    expect((await f.e.api.call('get', `/files/${s.blank_form_file_id}/download`)).status).toBe(200);
    // an upload of the same file as a real slot file is a different thing: it needs its own slot
    expect((await upload(f.e.api, f.taskId, s.id, PDF, 'filled.pdf')).status).toBe(201);
  });
});

async function created(): Promise<{ id: string; code: string; res: { headers: Record<string, unknown> } }> {
  const c = code('TBLANK');
  const res = await create(admin, base(c, ['F2']));
  expect(res.status).toBe(201);
  return { id: res.body.id as string, code: c, res };
}
