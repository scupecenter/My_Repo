import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, startApp, superDbDocs } from './helpers';
import { PDF, PNG, jpegWithExif } from './doc-helpers';
import { G, PROC, post, recPath, regCell } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, setCell } from './wf-helpers';

/**
 * Migration 0047 (contract 0.11.1), on the documents database (the seeded Document Library is active):
 *   Q130  the site field near_airport judges the A3 civil aviation permit; the site's Procurement delivery judges B1;
 *   Q131  document slots on register records (keyed on the logical record): the submit gate, the slot statuses with submit, rejection, approval and a
 *         new version, upload / withdraw / versions / download and audit, and the record-type placement;
 *   Q132  QC snag photos: photo rules, the EXIF date against the raise time with one day of tolerance, unknown capture date, L2 approval closes the
 *         snag, a rejection returns it with a note, B5 self-approval, and the PAC block of the snag's stream.
 * Region 6 belongs to this suite. Dates are relative to the database clock; nothing depends on the weekday.
 */
let app: NestExpressApplication;
let db: PgClient;
let adminApiCall: Awaited<ReturnType<typeof adminApi>>['api'];
const R = 6;
const U = randomBytes(3).toString('hex').toUpperCase();
const REGDOC = `TREG${U}`;
const DL: [string, string] = ['sites.documents', 'download_documents'];

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
  adminApiCall = (await adminApi(app, db)).api;
  // a mandatory document placed on the Quality register, record type NCR only (Q131)
  const c = await adminApiCall.call('post', '/document-library', {
    code: REGDOC, kind: 'scanned_document', name_en: 'NCR close-out report', placements: [{ target: 'register', ref: 'quality', record_type: 'ncr' }],
    formats: ['pdf', 'png'], max_size_mb: 5, min_files: 1, max_files: 1, reason: 'test setup',
  });
  expect(c.status).toBe(201);
  const p = await adminApiCall.call('post', `/document-library/${c.body.id}/publish`, { reason: 'test setup', effective_from: '2026-01-01', apply_to: 'new_only' }, { 'If-Match': String(c.headers.etag) });
  expect(p.status).toBe(200);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
/** An approved Procurement order of a site (version 1, in force), written as a fixture by the superuser. */
const approvedProc = async (siteId: string, data: Record<string, unknown>): Promise<void> => {
  await db.query(`INSERT INTO register_records (entity_id, version_no, is_current, register_key, site_id, region_id, state, current_level, levels_required, data, approved_at)
    SELECT gen_random_uuid(), 1, true, 'procurement', s.id, s.region_id, 'approved', 2, 2, $2::jsonb, now() FROM sites s WHERE s.id = $1`, [siteId, JSON.stringify(data)]);
};
const taskSlots = async (a: Actor, taskId: string) => (await a.api.call('get', `/tasks/${taskId}/slots`)).body.items as { id: string; doc_code: string; status: string; mandatory: boolean; conditional: boolean; determination_pending: boolean }[];
const slotOfTask = async (a: Actor, taskId: string, code: string) => (await taskSlots(a, taskId)).find((s) => s.doc_code === code);
/** EXIF wall-clock text ("YYYY:MM:DD HH:MM:SS") of a moment, as a camera without a time zone would write it. */
const exifText = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');

// ---------------------------------------------------------------------------------------------------------------------------------------- Q130
describe('Q130: conditional documents judge themselves', () => {
  it('near_airport is a site field shown on the site; setting it makes the A3 civil aviation permit mandatory, clearing it removes it again; audited', async () => {
    const e = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['sites', 'edit'], DL] });
    const site = await makeSite(db, R, { prefix: 'Q130' });
    const taskId = await makeTask(db, site, 'A3', 'entry');
    await setCell(db, 'A3', R, 'entry', { user: [e.user.id] });

    const detail = await e.api.call('get', `/sites/${site.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.custom_fields).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'near_airport', type: 'bool', label_ar: 'قريب من مطار', can_edit: true })]));
    expect((await slotOfTask(e, taskId, 'A3_CAA'))).toMatchObject({ status: 'not_required', conditional: true });

    // the If-Match of the site is required and must be current
    expect((await e.api.call('patch', `/sites/${site.id}`, { custom: { near_airport: true } })).status).toBe(428);
    expect((await e.api.call('patch', `/sites/${site.id}`, { custom: { near_airport: true } }, { 'If-Match': '"1"' })).status).toBe(412);
    // the value is checked like every custom field, and an unknown field is refused
    const bad = await e.api.call('patch', `/sites/${site.id}`, { custom: { near_airport: 'maybe', no_such_field: 1 } }, { 'If-Match': String(detail.headers.etag) });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((x: { path: string; code: string }) => `${x.path}:${x.code}`).sort()).toEqual(['/custom/near_airport:invalid', '/custom/no_such_field:unknown_field']);

    // Q225 (migration 0062): near_airport changes the permits, so the direct edit is refused; the approved Change Control applies it (register-feeds.test.ts)
    const yes = await e.api.call('patch', `/sites/${site.id}`, { custom: { near_airport: true }, reason: 'site survey: airport 2 km' }, { 'If-Match': String(detail.headers.etag) });
    expect(yes.status).toBe(422);
    expect(yes.body.errors[0]).toMatchObject({ path: '/custom/near_airport', code: 'approval_required' });
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'site_custom_update' AND entity_id = $1`, [site.id]))).toHaveLength(0);
    await db.query(`UPDATE sites SET custom = custom || '{"near_airport": true}'::jsonb WHERE id = $1`, [site.id]);   // as an approved change does
    expect(await slotOfTask(e, taskId, 'A3_CAA')).toMatchObject({ status: 'missing', mandatory: true });
    expect((await e.api.call('get', `/tasks/${taskId}`)).body.missing_for_submit).toContain('A3_CAA');
    await db.query(`UPDATE sites SET custom = custom || '{"near_airport": false}'::jsonb WHERE id = $1`, [site.id]);
    expect(await slotOfTask(e, taskId, 'A3_CAA')).toMatchObject({ status: 'not_required' });
  });

  it('only a caller with sites edit in the region may set it (403), and a site of another region is not found (404)', async () => {
    const viewer = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view']] });
    const other = await actor(app, db, { level: 'entry', regions: [1], grants: [['sites', 'view'], ['sites', 'edit']] });
    const site = await makeSite(db, R, { prefix: 'Q130' });
    const d = await viewer.api.call('get', `/sites/${site.id}`);
    expect(d.body.custom_fields.find((f: { code: string }) => f.code === 'near_airport').can_edit).toBe(false);
    const denied = await viewer.api.call('patch', `/sites/${site.id}`, { custom: { near_airport: true } }, { 'If-Match': String(d.headers.etag) });
    expect(denied.status).toBe(403);
    expect((await other.api.call('patch', `/sites/${site.id}`, { custom: { near_airport: true } }, { 'If-Match': String(d.headers.etag) })).status).toBe(404);
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'site_custom_update' AND entity_id = $1`, [site.id]))).toHaveLength(0);
  });

  it('B1 reads the delivery of the site\'s approved Procurement orders (Q226): outsourced adds the PR e-mail slot, in-house leaves it not required, no approved order is pending', async () => {
    const e = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['sites', 'edit'], ...G('procurement', 'view', 'create', 'edit')] });
    await regCell(db, 'procurement', R, 'entry', { user: [e.user.id] });
    const out = await makeSite(db, R, { prefix: 'Q130B' });
    const inh = await makeSite(db, R, { prefix: 'Q130B' });
    const tOut = await makeTask(db, out, 'B1', 'entry');
    const tIn = await makeTask(db, inh, 'B1', 'entry');
    await setCell(db, 'B1', R, 'entry', { user: [e.user.id] });
    // no Procurement order yet: the rule cannot judge; the slot waits as "pending determination" (Q226), not as a confirmed "not required"
    expect(await slotOfTask(e, tOut, 'B1')).toMatchObject({ status: 'not_required', conditional: true, determination_pending: true });
    // a draft order never decides (only the approved version in force)
    expect((await e.api.call('post', recPath('procurement'), { site_id: out.id, data: { ...PROC, delivery: 'Outsourced' } })).status).toBe(201);
    expect(await slotOfTask(e, tOut, 'B1')).toMatchObject({ status: 'not_required', determination_pending: true });
    await approvedProc(out.id, { ...PROC, delivery: 'Outsourced' });
    await approvedProc(inh.id, { scope: 'CW', delivery: 'In-House', po_wo_no: 'WO-1', po_wo_date: '2026-01-05', order_status: 'Open' });
    expect(await slotOfTask(e, tOut, 'B1')).toMatchObject({ status: 'missing', mandatory: true, determination_pending: false });
    expect(await slotOfTask(e, tIn, 'B1')).toMatchObject({ status: 'not_required', determination_pending: false });
    // the manual "this document applies" stays possible on the in-house site
    const declared = await e.api.call('post', `/tasks/${tIn}/slots`, { doc_code: 'B1' });
    expect(declared.status).toBe(201);
    expect(declared.body.status).toBe('missing');
    // an approved order of a scope that is not a B1 source (TE Installation) does not decide B1: still pending
    const te = await makeSite(db, R, { prefix: 'Q130B' });
    const tTe = await makeTask(db, te, 'B1', 'entry');
    await approvedProc(te.id, { ...PROC, scope: 'TE Installation', delivery: 'Outsourced' });
    expect(await slotOfTask(e, tTe, 'B1')).toMatchObject({ status: 'not_required', determination_pending: true });
    // a mixed answer (one order in-house, one without a delivery) is pending too, never "the latest order"
    const mixed = await makeSite(db, R, { prefix: 'Q130B' });
    const tMix = await makeTask(db, mixed, 'B1', 'entry');
    await approvedProc(mixed.id, { scope: 'CW', delivery: 'In-House', po_wo_no: 'WO-2', po_wo_date: '2026-01-05', order_status: 'Open' });
    await approvedProc(mixed.id, { scope: 'Tower Erection', pr_no: 'PR-9', pr_date: '2026-01-05', order_status: 'Open' });
    expect(await slotOfTask(e, tMix, 'B1')).toMatchObject({ determination_pending: true });
    // a pending determination blocks the approval of the task (database gate), unless Data Entry declared that the document applies
    const blocked = await db.query(`UPDATE task_instances SET state = 'approved' WHERE id = $1`, [tTe]).then(() => 'ok', (err: Error) => err.message);
    expect(blocked).toContain('document_rule_pending');
    expect((await e.api.call('post', `/tasks/${tTe}/slots`, { doc_code: 'B1' })).status).toBe(201);
    expect(await slotOfTask(e, tTe, 'B1')).toMatchObject({ status: 'missing', determination_pending: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------- Q131
interface Rec { id: string; entity_id: string; version: number; state: string; allowed_actions: string[] }
interface RSlot { id: string; doc_code: string; status: string; mandatory: boolean; can_upload: boolean; reject_reason: string | null; files: { id: string; file_group_id: string; version: number; is_current: boolean; approved_date: string | null; download_name: string }[] }

async function qualityTeam(): Promise<{ e: Actor; a: Actor; site: { id: string; code: string; region: number } }> {
  const e = await actor(app, db, { level: 'entry', regions: [R], grants: [...G('quality', 'view', 'create', 'edit'), DL] });
  const a = await actor(app, db, { level: 'approve', regions: [R], grants: [...G('quality', 'view', 'approve'), DL, ['sites.documents', 'view']] });
  await regCell(db, 'quality', R, 'entry', { user: [e.user.id] });
  await regCell(db, 'quality', R, 'approve', { user: [a.user.id] });
  return { e, a, site: await makeSite(db, R, { prefix: 'Q131' }) };
}
let codeSeq = 0;
const newQuality = async (who: Actor, siteId: string, type: string): Promise<Rec> => {
  const r = await who.api.call('post', recPath('quality'), { site_id: siteId, record_type: type, data: { record_code: `${type.toUpperCase()}-${U}-${++codeSeq}`, description: 'Rebar cover too thin', severity: 'Major' } });
  if (r.status !== 201) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Rec;
};
const recSlots = async (who: Actor, id: string) => (await who.api.call('get', recPath('quality', id, '/slots'))).body as { items: RSlot[]; task_id: string | null; missing_for_submit: string[] };
const recUpload = (who: Actor, id: string, slotId: string, buf: Buffer, name: string, replaces?: string) => {
  const t = who.api.call('post', recPath('quality', id, `/slots/${slotId}/files`)).attach('file', buf, { filename: name, contentType: 'application/octet-stream' });
  if (replaces) t.field('replaces_file_group_id', replaces);
  return t;
};
const getRec = async (who: Actor, id: string): Promise<Rec> => (await who.api.call('get', recPath('quality', id))).body as Rec;

describe('Q131: document slots on register records', () => {
  it('builds the slot from a register placement of the record type only, and the database refuses Submit while the mandatory slot is missing', async () => {
    const { e, site } = await qualityTeam();
    const ncr = await newQuality(e, site.id, 'ncr');
    const qc = await newQuality(e, site.id, 'qc');
    const s = await recSlots(e, ncr.id);
    expect(s.items.map((x) => x.doc_code)).toEqual([REGDOC]);
    expect(s.items[0]).toMatchObject({ status: 'missing', mandatory: true, can_upload: true });
    expect(s.missing_for_submit).toEqual([REGDOC]);
    expect(s.task_id).toBeNull();
    expect((await recSlots(e, qc.id)).items).toEqual([]);
    const blocked = await post(e.api, 'quality', ncr.id, 'submit', ncr.version);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('mandatory_slots_missing');
    expect(blocked.body.missing).toEqual([REGDOC]);
    expect((await getRec(e, ncr.id)).state).toBe('entry');
    // the record without a placed document submits as before
    expect((await post(e.api, 'quality', qc.id, 'submit', qc.version)).status).toBe(200);
  });

  it('slot statuses move with the record: uploaded -> in review -> rejected with the reviewer\'s reason -> uploaded (new version) -> approved; download named and audited', async () => {
    const { e, a, site } = await qualityTeam();
    const ncr = await newQuality(e, site.id, 'ncr');
    let slot = (await recSlots(e, ncr.id)).items[0] as RSlot;
    // the L2 holder may not upload at L1, and a wrong format is refused before anything is stored
    expect((await recUpload(a, ncr.id, slot.id, PDF, 'report.pdf')).status).toBe(403);
    const exe = await recUpload(e, ncr.id, slot.id, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)]), 'report.pdf');
    expect(exe.status).toBe(422);
    expect(exe.body.code).toBe('file_rejected');
    const up = await recUpload(e, ncr.id, slot.id, PDF, 'ncr-close.pdf');
    expect(up.status).toBe(201);
    expect(up.body.download_name).toMatch(new RegExp(`^${site.code}_QUALITY_${REGDOC}_DRAFT-\\d{8}\\.pdf$`));
    slot = (await recSlots(e, ncr.id)).items[0] as RSlot;
    expect(slot.status).toBe('uploaded');
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'document_file_upload' AND entity_type = 'register_record' AND entity_id = $1`, [ncr.id]))).toHaveLength(1);

    const sub = await post(e.api, 'quality', ncr.id, 'submit', ncr.version);
    expect(sub.status).toBe(200);
    expect(sub.body.state).toBe('in_approval');
    expect((await recSlots(a, ncr.id)).items[0]).toMatchObject({ status: 'in_review', can_upload: false });

    // L2 rejects and names the slot (RejectRequest.rejected_slots), as for a task
    const rej = await post(a.api, 'quality', ncr.id, 'reject', sub.body.version, { note: 'wrong report', rejected_slots: [{ slot_id: slot.id, reason: 'not signed' }] });
    expect(rej.status).toBe(200);
    expect(rej.body.state).toBe('entry');
    slot = (await recSlots(e, ncr.id)).items[0] as RSlot;
    expect(slot).toMatchObject({ status: 'rejected', reject_reason: 'not signed', can_upload: true });
    expect((await recSlots(e, ncr.id)).missing_for_submit).toEqual([REGDOC]);
    expect((await post(e.api, 'quality', ncr.id, 'submit', rej.body.version)).body.code).toBe('mandatory_slots_missing');

    // a new version of the file (the slot holds one file); the old one stays downloadable
    const first = slot.files[0]!;
    const v2 = await recUpload(e, ncr.id, slot.id, PNG, 'ncr-signed.png', first.file_group_id);
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    slot = (await recSlots(e, ncr.id)).items[0] as RSlot;
    expect(slot.status).toBe('uploaded');
    expect(slot.files.map((f) => [f.version, f.is_current])).toEqual([[1, false], [2, true]]);

    const sub2 = await post(e.api, 'quality', ncr.id, 'submit', (await getRec(e, ncr.id)).version);
    expect(sub2.status).toBe(200);
    await a.api.stepUp(a.user.password);
    const ok = await post(a.api, 'quality', ncr.id, 'approve', sub2.body.version);
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('approved');
    slot = (await recSlots(a, ncr.id)).items[0] as RSlot;
    expect(slot.status).toBe('approved');
    const cur = slot.files.find((f) => f.is_current)!;
    const today = (await q<{ d: string }>(`SELECT current_date::text AS d`))[0]!.d;
    expect(cur.approved_date).toBe(today);
    expect(cur.download_name).toBe(`${site.code}_QUALITY_${REGDOC}_${today.replace(/-/g, '')}.png`);

    const dl = await a.api.call('get', `/files/${cur.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain(cur.download_name);
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'document_file_download' AND entity_id = $1`, [cur.id]))).toHaveLength(1);
    // the Documents list shows the record's file with its register
    const list = await a.api.call('get', `/documents?site_id=${site.id}`);
    expect(list.body.items).toEqual([expect.objectContaining({ doc_code: REGDOC, register_key: 'quality', register_entity_id: ncr.entity_id, task_id: null })]);
    // the Documents grant alone does not reach a register's files: without the Quality module the file is neither listed nor downloadable
    const docsOnly = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['sites.documents', 'view'], DL] });
    expect((await docsOnly.api.call('get', `/documents?site_id=${site.id}`)).body.items).toEqual([]);
    expect((await docsOnly.api.call('get', `/files/${cur.id}/download`)).status).toBe(404);
  });

  it('withdraw before submit sends the slot back to missing; a new version of an approved record reopens the slot with its file (keyed on the logical record)', async () => {
    const { e, a, site } = await qualityTeam();
    const ncr = await newQuality(e, site.id, 'ncr');
    const slotId = (await recSlots(e, ncr.id)).items[0]!.id;
    const f = await recUpload(e, ncr.id, slotId, PDF, 'a.pdf');
    const w = await e.api.call('delete', recPath('quality', ncr.id, `/slots/${slotId}/files/${f.body.id}`));
    expect(w.status).toBe(200);
    expect(w.body.status).toBe('missing');
    expect((await recUpload(e, ncr.id, slotId, PDF, 'b.pdf')).status).toBe(201);
    const sub = await post(e.api, 'quality', ncr.id, 'submit', (await getRec(e, ncr.id)).version);
    await a.api.stepUp(a.user.password);
    const ok = await post(a.api, 'quality', ncr.id, 'approve', sub.body.version);
    expect(ok.body.state).toBe('approved');
    // an approved record takes no file
    expect((await recUpload(e, ncr.id, slotId, PDF, 'c.pdf')).status).toBe(409);

    const nv = await e.api.call('post', recPath('quality', ncr.id, '/versions'), {}, { 'If-Match': `"${ok.body.version}"` });
    expect(nv.status).toBe(201);
    const s2 = await recSlots(e, nv.body.id);
    expect(s2.items.map((x) => [x.id, x.status])).toEqual([[slotId, 'uploaded']]);
    expect(s2.missing_for_submit).toEqual([]);
    const sub2 = await post(e.api, 'quality', nv.body.id, 'submit', nv.body.version);
    expect(sub2.status).toBe(200);
    expect((await recSlots(a, nv.body.id)).items[0]!.status).toBe('in_review');
  });

  it('the library refuses a record type the register does not have', async () => {
    const c = await adminApiCall.call('post', '/document-library', {
      code: `TBAD${U}`, kind: 'scanned_document', name_en: 'Bad placement', placements: [{ target: 'register', ref: 'quality', record_type: 'audit' }], formats: ['pdf'], max_size_mb: 5, reason: 'test',
    });
    expect(c.status).toBe(422);
    expect(c.body.errors).toEqual([expect.objectContaining({ path: '/placements/0/record_type', code: 'unknown_record_type' })]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------- Q132
interface SnagDto {
  id: string; state: string; version: number; raised_at: string; allowed_actions: string[]; return_count: number; last_return_note: string | null; self_approval: boolean;
  photos: { id: string; file_id: string; shot_type: string | null; unknown_capture_date: boolean; captured_at: string | null; status: string; reject_reason: string | null }[];
  photos_missing: { code: string }[];
}
let snagType = '';
const photo = (who: Actor, id: string, buf: Buffer, shot: string | null, name = 'fix.jpg') => {
  const t = who.api.call('post', `/snags/${id}/photos`).attach('file', buf, { filename: name, contentType: 'image/jpeg' });
  if (shot) t.field('shot_type', shot);
  return t;
};
const snag = async (who: Actor, id: string): Promise<SnagDto> => (await who.api.call('get', `/snags/${id}`)).body as SnagDto;
const act = (who: Actor, id: string, verb: string, version: number, body: unknown = {}) => who.api.call('post', `/snags/${id}/${verb}`, body, { 'If-Match': `"${version}"` });

async function snagTeam(): Promise<{ e: Actor; a: Actor; site: { id: string; code: string; region: number } }> {
  const e = await actor(app, db, { level: 'entry', regions: [R], grants: [...G('quality', 'view', 'create', 'edit'), ['sites', 'view'], ['sites', 'edit'], DL] });
  const a = await actor(app, db, { level: 'approve', regions: [R], grants: [...G('quality', 'view', 'create', 'approve'), DL] });
  await regCell(db, 'quality', R, 'entry', { user: [e.user.id] });
  await regCell(db, 'quality', R, 'approve', { user: [a.user.id] });
  if (!snagType) {
    const t = await adminApiCall.call('post', '/snag-types', {
      code: `TS${U}`, name_en: 'Concrete crack', name_ar: 'شرخ خرساني', photo_rules: { min_count: 2, shot_types: ['wide', 'close'], formats: ['JPG'], max_size_mb: 5 }, reason: 'test setup',
    });
    expect(t.status).toBe(201);
    expect(t.body.photo_rules).toEqual({ min_count: 2, shot_types: ['wide', 'close'], formats: ['JPG'], max_size_mb: 5 });
    snagType = t.body.id as string;
  }
  return { e, a, site: await makeSite(db, R, { prefix: 'Q132' }) };
}

describe('Q132: QC snag photos', () => {
  it('EXIF date before the raise is refused, within one day of tolerance accepted, after accepted, none accepted with the unknown-capture-date flag; format, shot type and count follow the type', async () => {
    const { e, a, site } = await snagTeam();
    const r = await a.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: snagType, scope: 'CW', title: 'Crack at plinth', severity: 'MAJOR' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: 'open', scope: 'CW', photos: [], photos_required: 2 });
    expect(r.body.allowed_actions).toEqual([]);
    const id = r.body.id as string;
    const raised = new Date(r.body.raised_at as string);
    expect((await snag(e, id)).allowed_actions).toEqual(['upload', 'edit']);

    const before = await photo(e, id, jpegWithExif(exifText(new Date(raised.getTime() - 3 * 86400000))), 'wide');
    expect(before.status).toBe(422);
    expect(before.body).toMatchObject({ code: 'file_rejected', reason: 'before_snag_raised' });
    // just past the day of tolerance is still refused
    expect((await photo(e, id, jpegWithExif(exifText(new Date(raised.getTime() - 86400000 - 3600000))), 'wide')).body.reason).toBe('before_snag_raised');
    // within the day of tolerance (EXIF has no time zone)
    const within = await photo(e, id, jpegWithExif(exifText(new Date(raised.getTime() - 12 * 3600000))), 'wide');
    expect(within.status).toBe(201);
    expect(within.body).toMatchObject({ shot_type: 'wide', unknown_capture_date: false, status: 'accepted' });

    // the type allows JPG only, the shot type must be one of the type's, and the count is not reached yet
    const png = await photo(e, id, PNG, 'close', 'fix.png');
    expect(png.status).toBe(422);
    expect(png.body.reason).toBe('format_not_allowed');
    const shot = await photo(e, id, jpegWithExif(null), 'aerial');
    expect(shot.status).toBe(422);
    expect(shot.body.errors[0].code).toBe('unknown_shot_type');
    let s = await snag(e, id);
    expect(s.state).toBe('open');
    expect(s.photos_missing.map((x) => x.code)).toEqual(['min_count', 'shot_type_missing']);
    const early = await act(e, id, 'submit', s.version);
    expect(early.status).toBe(422);

    const none = await photo(e, id, jpegWithExif(null), 'close');
    expect(none.status).toBe(201);
    expect(none.body).toMatchObject({ unknown_capture_date: true, captured_at: null });
    const after = await photo(e, id, jpegWithExif(exifText(new Date(raised.getTime() + 3600000))), 'close');
    expect(after.status).toBe(201);
    s = await snag(e, id);
    expect(s.state).toBe('fix_submitted');
    expect(s.photos).toHaveLength(3);
    expect(s.allowed_actions).toContain('submit');
    // the photo is downloadable through the same path and audited
    const dl = await a.api.call('get', `/files/${none.body.file_id}/download`);
    expect(dl.status).toBe(200);
    // a snag photo also needs the Quality module, not only the Documents download grant
    const docsOnly = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['sites.documents', 'view'], DL] });
    expect((await docsOnly.api.call('get', `/files/${none.body.file_id}/download`)).status).toBe(404);
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'document_file_download' AND entity_type = 'snag_photo' AND entity_id = $1`, [none.body.id]))).toHaveLength(1);
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'snag_photo_upload' AND entity_id = $1`, [id]))).toHaveLength(3);
  });

  it('an open CW snag blocks CW PAC; L2 rejects with a note (back to L1), L1 resubmits, L2 approval closes the snag and the PAC is no longer blocked', async () => {
    const { e, a, site } = await snagTeam();
    const pac = await makeTask(db, site, 'B13', 'entry', { actualDate: '2026-01-05' });
    await setCell(db, 'B13', R, 'entry', { user: [e.user.id] });
    // the inspector raises the snag; the L2 who approves the closure is somebody else (D230b)
    const inspector = await actor(app, db, { level: 'entry', regions: [R], grants: G('quality', 'view', 'create') });
    const id = (await inspector.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: snagType, task_id: pac, title: 'Paint missing on tower leg', severity: 'MAJOR' })).body.id as string;
    let s = await snag(a, id);
    expect(s).toMatchObject({ state: 'open' });
    expect((await a.api.call('get', `/snags/${id}`)).body.scope).toBe('CW'); // from the task (CW PAC)
    const sitePage = await e.api.call('get', `/sites/${site.id}`);
    expect(sitePage.body.counts.open_snags).toBe(1);
    const pacTask = (await e.api.call('get', `/tasks/${pac}`)).body;
    expect(pacTask.lock_reasons).toEqual([expect.objectContaining({ kind: 'open_snags', ref_code: 'CW', count: 1 })]);
    const blocked = await e.api.call('post', `/tasks/${pac}/submit`, {}, { 'If-Match': `"${pacTask.version}"` });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('open_snags');

    await photo(e, id, jpegWithExif(null), 'wide');
    await photo(e, id, jpegWithExif(null), 'close');
    s = await snag(e, id);
    const sub = await act(e, id, 'submit', s.version);
    expect(sub.status).toBe(200);
    expect(sub.body.state).toBe('in_review');
    expect(sub.body.ball_in_court).toMatchObject({ level: 2, level_kind: 'approve' });
    // in review still blocks; L1 cannot approve; review is not a step of a snag
    expect((await e.api.call('get', `/tasks/${pac}`)).body.lock_reasons).toHaveLength(1);
    expect((await act(e, id, 'approve', sub.body.version)).status).toBe(403);
    expect((await act(a, id, 'review', sub.body.version)).status).toBe(409);
    // no photo can be added while L2 reviews
    expect((await photo(e, id, jpegWithExif(null), 'wide')).status).toBe(409);

    expect((await act(a, id, 'reject', sub.body.version, {})).status).toBe(422);
    const rej = await act(a, id, 'reject', sub.body.version, { note: 'close-up is blurred', rejected_photos: [{ photo_id: sub.body.photos[1].id, reason: 'blurred' }] });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ state: 'open', return_count: 1, last_return_note: 'close-up is blurred' });
    expect(rej.body.photos.find((p: { id: string }) => p.id === sub.body.photos[1].id)).toMatchObject({ status: 'rejected', reject_reason: 'blurred' });
    expect(rej.body.ball_in_court.claimed_by.id).toBe(e.user.id);
    const note = await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'snag_rejected'`, [e.user.id]);
    expect(note).toHaveLength(1);

    await photo(e, id, jpegWithExif(null), 'close');
    s = await snag(e, id);
    expect(s.state).toBe('fix_submitted');
    const sub2 = await act(e, id, 'submit', s.version);
    expect(sub2.status).toBe(200);
    // approval needs step-up
    const fresh = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'approve'), stepUp: false });
    await regCell(db, 'quality', R, 'approve', { user: [a.user.id, fresh.user.id] });
    expect((await act(fresh, id, 'approve', sub2.body.version)).status).toBe(401);
    const ok = await act(a, id, 'approve', sub2.body.version);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'closed', self_approval: false });
    expect(ok.body.closed_at).not.toBeNull();
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'snag_close' AND entity_id = $1`, [id]))).toHaveLength(1);

    const t2 = (await e.api.call('get', `/tasks/${pac}`)).body;
    expect(t2.lock_reasons).toEqual([]);
    const free = await e.api.call('post', `/tasks/${pac}/submit`, {}, { 'If-Match': `"${t2.version}"` });
    expect(free.body.code).not.toBe('open_snags');
    expect((await e.api.call('get', `/sites/${site.id}`)).body.counts.open_snags).toBe(0);
  });

  it('D230b: a person who holds L1 and L2 cannot close a snag they fixed or raised (no self-approval for snags); a caller without the Quality module cannot raise one', async () => {
    const { site } = await snagTeam();
    const both = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'create', 'edit', 'approve') });
    const other = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'approve') });
    const outsider = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view']] });
    await regCell(db, 'quality_te', R, 'entry', { user: [both.user.id] });
    await regCell(db, 'quality_te', R, 'approve', { user: [both.user.id, other.user.id] });
    expect((await outsider.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: snagType, scope: 'TE', title: 'Loose cable tray', severity: 'MAJOR' })).status).toBe(403);
    const r = await both.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: snagType, scope: 'TE', title: 'Loose cable tray', severity: 'MAJOR' });
    expect(r.status).toBe(201);
    expect(r.body.ball_in_court.matrix_row).toBe('quality_te');
    expect((await both.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: snagType, title: 'No stream', severity: 'MAJOR' })).status).toBe(422);
    await photo(both, r.body.id, jpegWithExif(null), 'wide');
    await photo(both, r.body.id, jpegWithExif(null), 'close');
    const s = await snag(both, r.body.id);
    const sub = await act(both, r.body.id, 'submit', s.version);
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ state: 'in_review', self_approval: false, approval_blocked: 'self_approval_forbidden' });
    expect(sub.body.allowed_actions).not.toContain('approve');
    const self = await act(both, r.body.id, 'approve', sub.body.version);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_approval_forbidden');
    const ok = await act(other, r.body.id, 'approve', sub.body.version);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'closed', self_approval: false });
    expect(ok.body.approved_by.id).toBe(other.user.id);
    expect(ok.body.fixed_by.id).toBe(both.user.id);
    expect(ok.body.found_by.id).toBe(both.user.id);
    const list = await both.api.call('get', `/sites/${site.id}/snags?state=closed`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(r.body.id);
  });

  it('snag types: the photo rules are validated and a change is versioned and audited', async () => {
    await snagTeam();
    const bad = await adminApiCall.call('post', '/snag-types', { code: `TX${U}`, name_en: 'Bad', photo_rules: { formats: ['GIF'] }, reason: 'test' });
    expect(bad.status).toBe(422);
    const cur = (await adminApiCall.call('get', '/snag-types')).body.items.find((t: { id: string }) => t.id === snagType);
    const up = await adminApiCall.call('patch', `/snag-types/${snagType}`, { photo_rules: { min_count: 2, shot_types: ['wide', 'close'], formats: ['JPG', 'HEIC'], max_size_mb: 5 }, reason: 'HEIC from phones' }, { 'If-Match': `"${cur.version}"` });
    expect(up.status).toBe(200);
    expect(up.body.version).toBe(cur.version + 1);
    expect(up.body.photo_rules.formats).toEqual(['JPG', 'HEIC']);
    expect((await adminApiCall.call('patch', `/snag-types/${snagType}`, { is_active: true, reason: 'stale' }, { 'If-Match': `"${cur.version}"` })).status).toBe(412);
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'snag_type_update' AND entity_id = $1`, [snagType]))).toHaveLength(1);
  });
});
