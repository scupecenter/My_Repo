import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF, docFlow, slotOf, upload, type DocFlow } from './doc-helpers';
import { delegate, startApp, superDbDocs } from './helpers';
import { G } from './reg-helpers';
import { type Actor, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * W5 of plan 2026-11-23-next-ui-cleanup (migration 0151, contract 0.15.69): Library > Forms and Archive on the documents database (the seeded Document
 * Library is active there). Who generates (L1 of the task, or "Documents: generate" for the region), the task rule, numbering, the rendered and escaped
 * file, audited downloads, void, the Archive cards and list with the lifecycle, the zip limit, the form templates and the Archive setting.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let flow: DocFlow;
let TPL: string;
const R = 7; // Sebha: the documents suites of the other files use other regions
const CODE = `W5-SSR-${Date.now() % 100000}`;
const HTML = '<html><body><h1>Survey {{doc.ref_no}}</h1><p class="site">{{site.id}} {{site.name}}</p><p>{{site.region_name}} {{fields.owner}}</p>'
  + '{{#if site.region_is.SEBHA}}<b>south</b>{{else}}<b>other</b>{{/if}}<p>{{task.code}} {{generated_by.name}}</p></body></html>';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
  admin = await plainAdmin(app, db);
  flow = await docFlow(app, db, 'A2', { region: R });
  await db.query(`UPDATE sites SET name = $2 WHERE id = $1`, [flow.site.id, 'Hill <script>alert(1)</script> & Co']);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const codes = (res: { body: any }): string[] => (res.body.errors ?? []).map((e: { path: string; code: string }) => `${e.path}:${e.code}`).sort();
const text = async (api: Actor['api'], path: string) => api.call('get', path).buffer(true).parse((res, cb) => {
  let s = '';
  res.on('data', (c: Buffer) => { s += c.toString('utf8'); });
  res.on('end', () => cb(null, s));
});
const audit = async (action: string, id: string) => (await db.query('SELECT actor_id, after, site_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, id])).rows;

describe('W5: form templates (Settings > Documents > Form templates)', () => {
  it('only the configuration right manages templates; the body is closed and checked; unsafe HTML is refused', async () => {
    const plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R], modules: null });
    expect((await plain.api.call('get', '/library/form-templates')).status).toBe(403);
    const good = { code: CODE, name_en: 'Site survey report', name_ar: 'تقرير المسح', doc_code: 'A2', trigger_task_code: 'A2', numbering_pattern: 'SSR-{YYYY}-{SEQ:4}', html: HTML, bindings: { owner: 'site.tower_owner' }, reason: 'W5 test form' };
    expect((await plain.api.call('post', '/library/form-templates', good)).status).toBe(403);
    const bad = await admin.api.call('post', '/library/form-templates', { ...good, code: 'x', doc_code: 'NOPE', trigger_task_code: 'ZZ9', numbering_pattern: 'SSR-{YYYY}', html: '<p onclick="x()">hello world, a form</p>', bindings: { owner: 'secret.thing' }, extra: 1 });
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual(['/bindings/owner:invalid_path', '/code:invalid', '/doc_code:unknown_document', '/extra:unknown_key', '/html:unsafe_html', '/numbering_pattern:sequence_token', '/trigger_task_code:unknown_task']);
    expect((await admin.api.call('post', '/library/form-templates', { ...good, reason: undefined })).status).toBe(422);
    const c = await admin.api.call('post', '/library/form-templates', good);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: CODE, version: 1, status: 'draft', doc_code: 'A2', trigger_task_code: 'A2' });
    expect(c.body.placeholders).toEqual(expect.arrayContaining(['doc.ref_no', 'site.id', 'site.region_is.SEBHA']));
    TPL = c.body.id;
    // a draft is not offered in Library > Forms
    expect((await flow.e.api.call('get', '/library/forms')).body.items.some((x: { id: string }) => x.id === TPL)).toBe(false);
    const ap = await admin.api.call('post', `/library/form-templates/${TPL}/approve`, { reason: 'Approved by the owner' });
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('approved');
    expect((await db.query('SELECT pattern, form_code FROM doc_sequences WHERE key = $1', [CODE])).rows[0]).toEqual({ pattern: 'SSR-{YYYY}-{SEQ:4}', form_code: CODE });
    expect((await admin.api.call('post', `/library/form-templates/${TPL}/approve`, { reason: 'Again' })).status).toBe(409);
    expect(await audit('library_form_template_approve', TPL)).toHaveLength(1);
    const h = await admin.api.call('get', `/library/form-templates/${TPL}/html`);
    expect(h.body.html).toBe(HTML);
    const forms = await flow.e.api.call('get', '/library/forms');
    expect(forms.status).toBe(200);
    expect(forms.body.can_configure).toBe(false);
    expect(forms.body.items.find((x: { id: string }) => x.id === TPL)).toMatchObject({ kind: 'html', code: CODE, version: 1, doc_code: 'A2', trigger_task_code: 'A2', numbering_pattern: 'SSR-{YYYY}-{SEQ:4}' });
  });

  it('the tables are written only through their doors', async () => {
    let refused = false;
    try { await db.query(`SET ROLE pmis_app; UPDATE library_form_templates SET html = 'x'`); } catch { refused = true; }
    await db.query('RESET ROLE');
    expect(refused).toBe(true);
    refused = false;
    try { await db.query(`SET ROLE pmis_app; SELECT html FROM library_generated_docs LIMIT 1`); } catch { refused = true; }
    await db.query('RESET ROLE');
    expect(refused).toBe(true);
  });
});

describe('W5: generate a filled document (Library > Forms)', () => {
  it('the L1 holder previews and generates; the site data is escaped; the number follows the sequence; it is audited', async () => {
    const p = await flow.e.api.call('post', `/library/forms/${TPL}/preview`, { site_id: flow.site.id });
    expect(p.status).toBe(200);
    expect(p.body.html).toContain('Survey PREVIEW');
    expect(p.body.html).toContain(flow.site.code);
    expect(p.body.html).toContain('Hill &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(p.body.html).not.toContain('<script>');
    expect(p.body.html).toContain('<b>south</b>');
    expect(p.body.task_id).toBe(flow.taskId);
    expect(p.body.warnings).toContain('fields.owner');
    const g1 = await flow.e.api.call('post', `/library/forms/${TPL}/generate`, { site_id: flow.site.id, remarks: 'first copy' });
    expect(g1.status).toBe(201);
    const year = new Date().getFullYear();
    expect(g1.body).toMatchObject({ status: 'generated', site_code: flow.site.code, task_code: 'A2', doc_code: 'A2', template_version: 1 });
    expect(g1.body.number).toMatch(new RegExp(`^SSR-${year}-\\d{4}$`));
    const g2 = await flow.e.api.call('post', `/library/forms/${TPL}/generate`, { site_id: flow.site.id });
    const n = (x: string) => Number(x.slice(-4));
    expect(n(g2.body.number)).toBe(n(g1.body.number) + 1);
    const rows = await audit('library_document_generate', g1.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: flow.e.user.id, site_id: flow.site.id });
    // the stored file is the filled form with its number
    const f = await text(flow.e.api, `/library/generated/${g1.body.id}/download?purpose=print`);
    expect(f.status).toBe(200);
    expect(f.headers['content-security-policy']).toContain("default-src 'none'");
    expect(f.headers['content-disposition']).toMatch(/^inline/);
    expect(f.body).toContain(`Survey ${g1.body.number}`);
    expect((await audit('library_document_download', g1.body.id)).map((r) => r.after.purpose)).toEqual(['print']);
    // void keeps the number issued; the next one is new
    const v = await flow.e.api.call('post', `/library/generated/${g2.body.id}/void`, { reason: 'Wrong site name' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    expect((await flow.e.api.call('post', `/library/generated/${g2.body.id}/void`, { reason: 'Again' })).status).toBe(409);
    const g3 = await flow.e.api.call('post', `/library/forms/${TPL}/generate`, { site_id: flow.site.id });
    expect(n(g3.body.number)).toBe(n(g2.body.number) + 1);
  });

  it('who may generate: not a viewer, not the L2 holder; "Documents: generate" for the region does; another region does not see the site', async () => {
    const viewer = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R], modules: null });
    const r1 = await viewer.api.call('post', `/library/forms/${TPL}/generate`, { site_id: flow.site.id });
    expect(r1.status).toBe(403);
    expect(r1.body.code).toBe('not_eligible_holder');
    expect((await flow.a.api.call('post', `/library/forms/${TPL}/preview`, { site_id: flow.site.id })).status).toBe(403);
    const gen = await actor(app, db, { level: 'view', grants: [['sites', 'view'], ['library.forms', 'create']], regions: [R], modules: null });
    expect((await gen.api.call('post', `/library/forms/${TPL}/generate`, { site_id: flow.site.id })).status).toBe(201);
    const other = await actor(app, db, { level: 'view', grants: [['sites', 'view'], ['library.forms', 'create']], regions: [4], modules: null });
    expect((await other.api.call('post', `/library/forms/${TPL}/generate`, { site_id: flow.site.id })).status).toBe(404);
    // a delegate of library.forms create for the region (the grid path through delegation)
    const del = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R], modules: null });
    await delegate(db, del.user.id, [['library.forms', 'create']], [R]);
    expect((await del.api.call('post', `/library/forms/${TPL}/preview`, { site_id: flow.site.id })).status).toBe(200);
  });

  it('the document is due only when its task opens; a site without the task does not take it', async () => {
    const site = await makeSite(db, R);
    await makeTask(db, site, 'A2', 'locked');
    const r = await admin.api.call('post', `/library/forms/${TPL}/generate`, { site_id: site.id });
    expect(r.status).toBe(409);
    const none = await makeSite(db, R);
    expect((await admin.api.call('post', `/library/forms/${TPL}/generate`, { site_id: none.id })).status).toBe(409);
    // the configuration right may still preview it (to check a template)
    expect((await admin.api.call('post', `/library/forms/${TPL}/preview`, { site_id: site.id })).status).toBe(200);
  });

  it('download: the region download right, the generator or the L1 holder; others in the region are refused; outside it is 404', async () => {
    const g = await flow.e.api.call('post', `/library/forms/${TPL}/generate`, { site_id: flow.site.id });
    const viewer = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R], modules: null });
    expect((await viewer.api.call('get', `/library/generated/${g.body.id}/download`)).status).toBe(403);
    const dl = await actor(app, db, { level: 'view', grants: [['sites', 'view'], ['sites.documents', 'download_documents']], regions: [R], modules: null });
    const ok = await text(dl.api, `/library/generated/${g.body.id}/download`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9_.-]+\.html"$/);
    const out = await actor(app, db, { level: 'view', grants: [['sites', 'view'], ['sites.documents', 'download_documents']], regions: [4], modules: null });
    expect((await out.api.call('get', `/library/generated/${g.body.id}/download`)).status).toBe(404);
  });
});

describe('W5: the Archive (cards, list, lifecycle, zip)', () => {
  it('the list shows the lifecycle of the site document: generated, then signed and uploaded; the card counts it', async () => {
    const site = flow.site.id;
    let r = await flow.e.api.call('get', `/library/archive/rows?doc_code=A2&site_id=${site}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ status: 'generated', site_code: flow.site.code, doc_code: 'A2', task_code: 'A2', region_id: R, form_id: TPL });
    expect(r.body.items[0].doc_number).toMatch(/^SSR-/);
    expect(r.body.counts).toEqual({ total: 1, filtered: 1 });
    const slot = await slotOf(flow.e.api, flow.taskId, 'A2');
    expect((await upload(flow.e.api, flow.taskId, slot.id, PDF, 'signed.pdf')).status).toBe(201);
    r = await flow.e.api.call('get', `/library/archive/rows?doc_code=A2&site_id=${site}`);
    expect(r.body.items[0]).toMatchObject({ status: 'signed_uploaded', version: 1, file_name: 'signed.pdf', file_count: 1 });
    expect(r.body.items[0].uploaded_by).toMatchObject({ id: flow.e.user.id });
    // a filter tree on the status and the search by Site ID
    const tree = JSON.stringify({ op: 'and', items: [{ field: 'status', operator: 'is', value: 'approved' }] });
    expect((await flow.e.api.call('get', `/library/archive/rows?site_id=${site}&filter=${encodeURIComponent(tree)}`)).body.counts.filtered).toBe(0);
    const s = await flow.e.api.call('get', `/library/archive/rows?doc_code=A2&q=${encodeURIComponent(`${flow.site.code} NOPE-1`)}`);
    expect(s.body.items.map((x: { site_code: string }) => x.site_code)).toEqual([flow.site.code]);
    expect(s.body.search).toMatchObject({ pasted: 2, found: 1, not_found: ['NOPE-1'] });
    const cards = await flow.e.api.call('get', '/library/archive');
    expect(cards.status).toBe(200);
    const all = cards.body.groups.flatMap((g: { key: string; cards: { doc_code: string }[] }) => g.cards.map((c) => ({ ...c, group: g.key })));
    const a2 = all.find((c: { doc_code: string }) => c.doc_code === 'A2');
    expect(a2.group).toBe('DESIGN_ACQ');
    expect(a2.counts.waiting_review).toBeGreaterThanOrEqual(1);
    // another region sees none of these rows
    const out = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null });
    expect((await out.api.call('get', `/library/archive/rows?site_id=${site}`)).body.counts).toEqual({ total: 0, filtered: 0 });
    // a user without the Documents screen
    const none = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [R], modules: null });
    expect((await none.api.call('get', '/library/archive')).status).toBe(403);
  });

  it('a superseded version is a row of its own on request; the zip takes the filtered files and keeps the limit', async () => {
    const slot = await slotOf(flow.e.api, flow.taskId, 'A2');
    const first = slot.files.find((f) => f.is_current)!;
    expect((await upload(flow.e.api, flow.taskId, slot.id, PDF, 'signed-v2.pdf', { replaces: first.file_group_id })).status).toBe(201);
    const r = await flow.e.api.call('get', `/library/archive/rows?doc_code=A2&site_id=${flow.site.id}&include_superseded=true`);
    expect(r.body.items.map((x: { status: string; version: number }) => `${x.status}:${x.version}`)).toEqual(['signed_uploaded:2', 'superseded:1']);
    const z = await flow.e.api.call('post', '/library/archive/zip', { doc_code: 'A2', site_id: flow.site.id, include_superseded: true });
    expect(z.status).toBe(202);
    expect(z.body).toMatchObject({ kind: 'zip_export', status: 'queued' });
    const start = (await db.query("SELECT after FROM audit_log WHERE action = 'document_zip_start' AND entity_id = $1", [z.body.id])).rows[0];
    expect(start.after.file_count).toBe(2);
    expect((await flow.e.api.call('post', '/library/archive/zip', { doc_code: 'A2', site_id: flow.site.id, status: 'approved' })).body.errors[0].code).toBe('no_files');
    // the limit of Settings > Documents > Archive
    const cur = await admin.api.call('get', '/settings/library-archive');
    const set = await admin.api.call('put', '/settings/library-archive', { hidden: [], order: [], default_columns: cur.body.default_columns, zip_limit: 1, reason: 'Small zips' }, { 'If-Match': String(cur.headers.etag) });
    expect(set.status).toBe(200);
    const over = await flow.e.api.call('post', '/library/archive/zip', { doc_code: 'A2', site_id: flow.site.id, include_superseded: true });
    expect(over.status).toBe(422);
    expect(over.body.errors[0].code).toBe('too_many_files');
    const back = await admin.api.call('put', '/settings/library-archive', { hidden: [], order: [], default_columns: cur.body.default_columns, zip_limit: 500, reason: 'Back' }, { 'If-Match': String(set.headers.etag) });
    expect(back.status).toBe(200);
  });

  it('Settings > Documents > Archive: rights, closed body, If-Match, audit; a hidden card is hidden but the admin still sees it', async () => {
    const cur = await flow.e.api.call('get', '/settings/library-archive');
    expect(cur.status).toBe(200);
    expect(cur.body).toMatchObject({ hidden: [], zip_limit: 500 });
    const body = { hidden: ['A2'], order: ['A2'], default_columns: ['site', 'status'], zip_limit: 100, reason: 'Hide A2' };
    expect((await flow.e.api.call('put', '/settings/library-archive', body, { 'If-Match': String(cur.headers.etag) })).status).toBe(403);
    const bad = await admin.api.call('put', '/settings/library-archive', { hidden: ['NOPE'], order: ['A2', 'A2'], default_columns: ['x'], zip_limit: 0, more: 1, reason: 'Bad' }, { 'If-Match': String(cur.headers.etag) });
    expect(codes(bad)).toEqual(['/default_columns:unknown_column', '/hidden:unknown_document', '/more:unknown_key', '/order:duplicate', '/zip_limit:out_of_range']);
    expect((await admin.api.call('put', '/settings/library-archive', body)).status).toBe(428);
    const ok = await admin.api.call('put', '/settings/library-archive', body, { 'If-Match': String(cur.headers.etag) });
    expect(ok.status).toBe(200);
    expect((await admin.api.call('put', '/settings/library-archive', body, { 'If-Match': String(cur.headers.etag) })).status).toBe(412);
    const a = (await db.query("SELECT before, after, reason FROM audit_log WHERE action = 'library_archive_update' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(a).toMatchObject({ reason: 'Hide A2', after: { hidden: ['A2'], zip_limit: 100 } });
    const codesOf = (res: { body: any }) => res.body.groups.flatMap((g: { cards: { doc_code: string; hidden: boolean }[] }) => g.cards.map((c) => `${c.doc_code}:${c.hidden}`));
    expect(codesOf(await flow.e.api.call('get', '/library/archive'))).not.toContain('A2:false');
    expect(codesOf(await admin.api.call('get', '/library/archive'))).toContain('A2:true');
    const back = await admin.api.call('put', '/settings/library-archive', { hidden: [], order: [], default_columns: cur.body.default_columns, zip_limit: 500, reason: 'Back' }, { 'If-Match': String(ok.headers.etag) });
    expect(back.status).toBe(200);
  });

  it('saved views and the filter builder know the screen library-archive', async () => {
    const f = await flow.e.api.call('get', '/saved-views/filter-fields?screen_key=library-archive');
    expect(f.status).toBe(200);
    expect(f.body.items.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['site_code', 'region_id', 'status', 'doc_number', 'uploaded_at']));
    const v = await flow.e.api.call('post', '/saved-views', { screen_key: 'library-archive', name: 'W5 approved', filters: { status: 'approved' } });
    expect(v.status).toBe(201);
  });
});
