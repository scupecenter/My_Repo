import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, startApp, superDbDocs } from './helpers';
import { DOC_GRANTS, EML, EXE, PDF, PNG, SVG_PLAIN, SVG_SCRIPT, XLSM, XLSX, ZIP_PATHS, docFlow, jpegWithExif, slotOf, slots, submit, upload } from './doc-helpers';
import { actor, makeSite, makeTask } from './wf-helpers';

/**
 * The document upload module on the fifth database (seeded Document Library active): slots, upload checks, the slot status flow with the task,
 * superseded versions, download names and audit, region scope, permissions. Dates come from the database ("today"), never from a weekday.
 */
let app: NestExpressApplication;
let db: PgClient;
let LIMITED: string; // a document type of 1 MB, PDF or PNG, one file, placed on A4 (published before the tasks of this file open)

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
  const { api } = await adminApi(app, db);
  const code = `TLIM${Date.now() % 100000}`;
  const c = await api.call('post', '/document-library', { code, kind: 'scanned_document', name_en: 'Limited test doc', placements: [{ target: 'task', ref: 'A4' }], formats: ['pdf', 'png'], max_size_mb: 1, min_files: 1, max_files: 1, reason: 'test setup' });
  expect(c.status).toBe(201);
  const p = await api.call('post', `/document-library/${c.body.id}/publish`, { reason: 'test setup', effective_from: '2026-01-01', apply_to: 'new_only' }, { 'If-Match': String(c.headers.etag) });
  expect(p.status).toBe(200);
  LIMITED = code;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
const today = async (): Promise<string> => (await q<{ d: string }>(`SELECT to_char(current_date, 'YYYYMMDD') AS d`))[0]!.d;
const bytes = (res: { body: unknown }): Buffer => res.body as Buffer;
const download = async (api: { call: (m: 'get', p: string) => import('supertest').Test }, fileId: string) =>
  api.call('get', `/files/${fileId}/download`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('the slots of a task', () => {
  it('builds the named slots from the seeded library when the task opens, and shows who may upload', async () => {
    const f = await docFlow(app, db, 'A2');
    const list = await slots(f.e.api, f.taskId);
    expect(list.map((s) => s.doc_code)).toEqual(['A2']);
    expect(list[0]).toMatchObject({ status: 'missing', mandatory: true, kind: 'scanned_document', formats: ['pdf', 'jpg', 'jpeg', 'png'], max_size_mb: 20, min_files: 1, max_files: null, can_upload: true });
    expect((await slots(f.a.api, f.taskId))[0]!.can_upload).toBe(false);
    // the same slots are part of the task detail
    const detail = (await f.e.api.call('get', `/tasks/${f.taskId}`)).body;
    expect(detail.slots.map((s: { doc_code: string }) => s.doc_code)).toEqual(['A2']);
    expect(detail.missing_for_submit).toEqual(['A2']);
  });

  it('a locked task has no slots until it opens (snapshot on open)', async () => {
    const f = await docFlow(app, db, 'A2', { state: 'locked' });
    expect(await slots(f.e.api, f.taskId)).toEqual([]);
    await db.query(`UPDATE task_instances SET state = 'open', current_level = 1 WHERE id = $1`, [f.taskId]);
    expect((await slots(f.e.api, f.taskId)).map((s) => s.doc_code)).toEqual(['A2']);
  });

  it('shows a conditional document only when its rule applies, and lets Data Entry declare one the PMIS cannot judge', async () => {
    // B5 (STA / ST analysis): the B4 report applies when the analysis type is STA or ST
    const f = await docFlow(app, db, 'B5');
    // nothing says the analysis is needed: the document is on the task as "not required" (Data Entry could declare it)
    expect((await slots(f.e.api, f.taskId)).map((s) => `${s.doc_code}:${s.status}`)).toEqual(['B4:not_required']);
    expect((await f.e.api.call('get', `/tasks/${f.taskId}`)).body.missing_for_submit).toEqual([]);
    await db.query(`UPDATE task_instances SET "values" = '{"analysis_type": "STA"}'::jsonb WHERE id = $1`, [f.taskId]);
    expect((await slots(f.e.api, f.taskId)).map((s) => `${s.doc_code}:${s.status}`)).toEqual(['B4:missing']);
    const t = (await f.e.api.call('get', `/tasks/${f.taskId}`)).body;
    expect(t.missing_for_submit).toEqual(['B4']);
    // the rule no longer holds and nothing was uploaded: the slot is not required any more
    await db.query(`UPDATE task_instances SET "values" = '{"analysis_type": "None"}'::jsonb WHERE id = $1`, [f.taskId]);
    expect((await slots(f.e.api, f.taskId))[0]!.status).toBe('not_required');
    expect((await f.e.api.call('get', `/tasks/${f.taskId}`)).body.missing_for_submit).toEqual([]);

    // A3: the civil aviation permit depends on a site field the PMIS does not hold: Data Entry says it applies
    const g = await docFlow(app, db, 'A3');
    expect((await slots(g.e.api, g.taskId)).map((s) => `${s.doc_code}:${s.status}`)).toEqual(['A3:missing', 'A3_CAA:not_required']);
    const add = await g.e.api.call('post', `/tasks/${g.taskId}/slots`, { doc_code: 'A3_CAA' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ doc_code: 'A3_CAA', status: 'missing', mandatory: true, conditional: true });
    expect((await g.e.api.call('post', `/tasks/${g.taskId}/slots`, { doc_code: 'A3_CAA' })).status).toBe(409);
    expect((await g.e.api.call('get', `/tasks/${g.taskId}`)).body.missing_for_submit.sort()).toEqual(['A3', 'A3_CAA']);
    // a document that is not placed on the task cannot be added
    expect((await g.e.api.call('post', `/tasks/${g.taskId}/slots`, { doc_code: 'A2' })).status).toBe(422);
    // another candidate: one SAR slot per candidate
    const h = await docFlow(app, db, 'A1');
    const cand = await h.e.api.call('post', `/tasks/${h.taskId}/slots`, { doc_code: 'A1', candidate_label: 'Candidate 2' });
    expect(cand.status).toBe(201);
    expect((await slots(h.e.api, h.taskId)).map((s) => s.candidate_label)).toEqual([null, 'Candidate 2']);
  });

  it('suggests the slot of a file from its name', async () => {
    const f = await docFlow(app, db, 'B7');
    const r = await f.e.api.call('post', `/tasks/${f.taskId}/slots/suggest`, { file_names: ['B7_DN_signed.pdf', 'Layout approval email.eml', 'holiday.png'] });
    expect(r.status).toBe(200);
    expect(r.body.items[0].suggestions[0].doc_code).toBe('B7_DN');
    expect(r.body.items[1].suggestions[0].doc_code).toBe('B7');
    expect(r.body.items[2].suggestions).toEqual([]);
    expect((await f.e.api.call('post', `/tasks/${f.taskId}/slots/suggest`, { file_names: [] })).status).toBe(422);
  });
});

describe('upload checks', () => {
  it('refuses a file over the limit (413), without storing anything', async () => {
    const f = await docFlow(app, db, 'A4');
    const s = await slotOf(f.e.api, f.taskId, LIMITED);
    expect(s).toMatchObject({ max_size_mb: 1, max_files: 1, formats: ['pdf', 'png'] });
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    const r = await upload(f.e.api, f.taskId, s.id, big, 'big.pdf');
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('file_too_large');
    expect((await slotOf(f.e.api, f.taskId, LIMITED)).files).toEqual([]);
  });

  it.each([
    ['a program renamed .pdf', EXE, 'invoice.pdf', 'executable'],
    ['an archive with paths', ZIP_PATHS, 'scan.pdf', 'archive'],
    ['a macro workbook', XLSM, 'sheet.pdf', 'macro'],
    ['an SVG with a script', SVG_SCRIPT, 'logo.png', 'script'],
    ['an empty file', Buffer.alloc(0), 'empty.pdf', 'empty'],
    ['an unknown text file', Buffer.from('just some notes\nnothing else'), 'notes.pdf', 'unknown_type'],
    ['a web page', Buffer.from('<!DOCTYPE html><html><body>hi</body></html>'), 'page.pdf', 'html'],
  ])('rejects %s by its bytes', async (_n, buf, name, reason) => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const r = await upload(f.e.api, f.taskId, s.id, buf, name, { type: 'application/pdf' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('file_rejected');
    expect(r.body.reason).toBe(reason);
    expect((await slotOf(f.e.api, f.taskId, 'A2')).status).toBe('missing');
  });

  it('checks the format list of the document by the content, not the name or the content type the client sends', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    // an e-mail file and a workbook are real types, but A2 takes PDF or images only
    const eml = await upload(f.e.api, f.taskId, s.id, EML, 'mail.pdf');
    expect(eml.status).toBe(422);
    expect(eml.body.reason).toBe('format_not_allowed');
    expect(eml.body.allowed).toEqual(['pdf', 'jpg', 'jpeg', 'png']);
    expect((await upload(f.e.api, f.taskId, s.id, XLSX, 'sheet.pdf')).body.reason).toBe('format_not_allowed');
    // a PNG named .pdf with a lying content type is stored as what it is
    const ok = await upload(f.e.api, f.taskId, s.id, PNG, 'scan.pdf', { type: 'application/pdf' });
    expect(ok.status).toBe(201);
    expect(ok.body.mime_type).toBe('image/png');
    expect(ok.body.original_name).toBe('scan.pdf');
    expect(ok.body.download_name).toMatch(/\.png$/);
  });

  it('keeps the file under a random key, with its SHA-256, size and sniffed type', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const r = await upload(f.e.api, f.taskId, s.id, PDF, 'TSSR Approved ../final.pdf');
    expect(r.status).toBe(201);
    const row = (await q<{ storage_key: string; sha256: string; size_bytes: string; mime_type: string; original_name: string }>('SELECT storage_key, sha256, size_bytes, mime_type, original_name FROM document_files WHERE id = $1', [r.body.id]))[0]!;
    expect(row.storage_key).toMatch(/^docs\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(row.storage_key).not.toContain('TSSR');
    expect(row.sha256).toBe(r.body.sha256);
    expect(r.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(row.size_bytes)).toBe(PDF.length);
    expect(row.mime_type).toBe('application/pdf');
    expect(row.original_name).toBe('final.pdf'); // the multipart parser keeps the base name only
    expect(r.body.download_name).not.toContain('/');
  });

  it('holds the file count of the document, and a new version replaces a file', async () => {
    const f = await docFlow(app, db, 'A4');
    const s = await slotOf(f.e.api, f.taskId, LIMITED);
    const one = await upload(f.e.api, f.taskId, s.id, PDF, 'one.pdf');
    expect(one.status).toBe(201);
    const two = await upload(f.e.api, f.taskId, s.id, PNG, 'two.png');
    expect(two.status).toBe(422);
    expect(two.body.reason).toBe('too_many_files');
    const v2 = await upload(f.e.api, f.taskId, s.id, PNG, 'two.png', { replaces: one.body.file_group_id });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, file_group_id: one.body.file_group_id });
    const bad = await upload(f.e.api, f.taskId, s.id, PNG, 'x.png', { replaces: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(422);
  });

  it('needs the file field', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const r = await f.e.api.call('post', `/tasks/${f.taskId}/slots/${s.id}/files`).field('replaces_file_group_id', '');
    expect(r.status).toBe(422);
    expect(r.body.errors[0].path).toBe('/file');
  });

  it('accepts an SVG only where the document lists svg, and never one with a script', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    expect((await upload(f.e.api, f.taskId, s.id, SVG_PLAIN, 'logo.svg')).body.reason).toBe('format_not_allowed');
  });
});

describe('who may upload', () => {
  it('refuses permission-denied cases: not the L1 holder, no edit grant, outside the regions', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    // the L2 holder is not a holder of L1
    const approver = await upload(f.a.api, f.taskId, s.id, PDF, 'a.pdf');
    expect(approver.status).toBe(403);
    expect(approver.body.code).toBe('not_eligible_holder');
    // a person who may only view
    const viewer = await actor(app, db, { level: 'view', regions: [5], grants: [['sites', 'view']] });
    const v = await upload(viewer.api, f.taskId, s.id, PDF, 'v.pdf');
    expect(v.status).toBe(403);
    expect((await viewer.api.call('post', `/tasks/${f.taskId}/slots`, { doc_code: 'A2', candidate_label: 'x' })).status).toBe(403);
    // another region: the task does not exist for them
    const other = await actor(app, db, { level: 'entry', regions: [4], grants: DOC_GRANTS });
    expect((await upload(other.api, f.taskId, s.id, PDF, 'o.pdf')).status).toBe(404);
    expect((await other.api.call('get', `/tasks/${f.taskId}/slots`)).status).toBe(404);
    expect((await other.api.call('post', `/tasks/${f.taskId}/slots`, { doc_code: 'A2', candidate_label: 'x' })).status).toBe(404);
    expect((await other.api.call('post', `/tasks/${f.taskId}/slots/suggest`, { file_names: ['a.pdf'] })).status).toBe(404);
    expect((await slotOf(f.e.api, f.taskId, 'A2')).files).toEqual([]);
    // not signed in
    const anon = await import('supertest').then((m) => m.default(app.getHttpServer()).get(`/api/v1/tasks/${f.taskId}/slots`));
    expect(anon.status).toBe(401);
  });

  it('refuses an upload while the task is in review, and withdrawal needs the L1 holder', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const up = await upload(f.e.api, f.taskId, s.id, PDF, 'a.pdf');
    expect((await f.a.api.call('delete', `/tasks/${f.taskId}/slots/${s.id}/files/${up.body.id}`)).status).toBe(403);
    expect((await submit(f.e, f.taskId)).status).toBe(200);
    const late = await upload(f.e.api, f.taskId, s.id, PDF, 'b.pdf');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('invalid_transition');
    expect((await f.e.api.call('delete', `/tasks/${f.taskId}/slots/${s.id}/files/${up.body.id}`)).status).toBe(409);
  });
});

describe('a mandatory slot blocks Submit; the slot follows the task', () => {
  it('walks missing, uploaded, in review, rejected with a reason, uploaded again, in review, approved', async () => {
    const f = await docFlow(app, db, 'A2');
    let s = await slotOf(f.e.api, f.taskId, 'A2');
    expect(s.status).toBe('missing');
    const blocked = await submit(f.e, f.taskId);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('mandatory_slots_missing');
    expect(blocked.body.missing).toEqual(['A2']);
    const t0 = (await f.e.api.call('get', `/tasks/${f.taskId}`)).body;
    expect(t0.allowed_actions.find((x: { action: string }) => x.action === 'submit').disabled_reason).toContain('A2');

    const v1 = await upload(f.e.api, f.taskId, s.id, PDF, 'tssr.pdf');
    expect(v1.status).toBe(201);
    s = await slotOf(f.e.api, f.taskId, 'A2');
    expect(s.status).toBe('uploaded');
    expect((await f.e.api.call('get', `/tasks/${f.taskId}`)).body.missing_for_submit).toEqual([]);

    const sub = await submit(f.e, f.taskId);
    expect(sub.status).toBe(200);
    expect(sub.body.task.state).toBe('in_approval');
    expect((await slotOf(f.e.api, f.taskId, 'A2')).status).toBe('in_review');

    // L2 rejects the slot with a reason: the task goes back to L1
    const tv = (await f.a.api.call('get', `/tasks/${f.taskId}`)).body;
    const rej = await f.a.api.call('post', `/tasks/${f.taskId}/reject`, { note: 'Page 2 is cut off', rejected_slots: [{ slot_id: s.id, reason: 'Scan is incomplete' }] }, { 'If-Match': `"${tv.version}"` });
    expect(rej.status).toBe(200);
    expect(rej.body.task.state).toBe('entry');
    s = await slotOf(f.e.api, f.taskId, 'A2');
    expect(s).toMatchObject({ status: 'rejected', reject_reason: 'Scan is incomplete' });
    // a rejected mandatory slot blocks Submit again
    expect((await submit(f.e, f.taskId)).body.code).toBe('mandatory_slots_missing');

    // the replacement is a new version; the rejected file stays downloadable
    const v2 = await upload(f.e.api, f.taskId, s.id, PNG, 'tssr2.png', { replaces: v1.body.file_group_id });
    expect(v2.status).toBe(201);
    s = await slotOf(f.e.api, f.taskId, 'A2');
    expect(s).toMatchObject({ status: 'uploaded', reject_reason: null });
    expect((await submit(f.e, f.taskId)).status).toBe(200);
    expect((await slotOf(f.e.api, f.taskId, 'A2')).status).toBe('in_review');

    // approval completes the task, the slot and the files (approved date)
    const tv2 = (await f.a.api.call('get', `/tasks/${f.taskId}`)).body;
    const ok = await f.a.api.call('post', `/tasks/${f.taskId}/approve`, {}, { 'If-Match': `"${tv2.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.task.state).toBe('approved');
    s = await slotOf(f.e.api, f.taskId, 'A2');
    expect(s.status).toBe('approved');
    const d = await today();
    // the current file takes the approved date; the superseded version was never approved and keeps its draft name
    expect(s.files.find((x) => x.is_current)!.download_name).toMatch(new RegExp(`_A2_A2_${d}\\.png$`));
    expect(s.files.find((x) => !x.is_current)!.download_name).toMatch(/_DRAFT-\d{8}_v1\.pdf$/);
    // approved tasks never change: no upload, no new slot
    const late = await upload(f.e.api, f.taskId, s.id, PDF, 'late.pdf');
    expect(late.status).toBe(409);
  });

  it('withdrawing the only file puts the slot back to missing and keeps the file on record', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const up = await upload(f.e.api, f.taskId, s.id, PDF, 'tssr.pdf');
    const del = await f.e.api.call('delete', `/tasks/${f.taskId}/slots/${s.id}/files/${up.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.status).toBe('missing');
    expect((await submit(f.e, f.taskId)).body.code).toBe('mandatory_slots_missing');
    const row = (await q<{ withdrawn_at: string | null; is_current: boolean }>('SELECT withdrawn_at, is_current FROM document_files WHERE id = $1', [up.body.id]))[0]!;
    expect(row.withdrawn_at).not.toBeNull();
    expect(row.is_current).toBe(false);
    expect((await q('SELECT 1 FROM audit_log WHERE action = $1 AND entity_id = $2', ['document_file_withdraw', f.taskId])).length).toBe(1);
    // the file can still be downloaded by its id (superseded or withdrawn, nothing is deleted)
    expect((await download(f.e.api, up.body.id)).status).toBe(200);
  });
});

describe('superseded versions', () => {
  it('keeps every version, marks the superseded one, names it _v<n> and lets both be downloaded', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const v1 = await upload(f.e.api, f.taskId, s.id, PDF, 'first.pdf');
    const v2 = await upload(f.e.api, f.taskId, s.id, PNG, 'second.png', { replaces: v1.body.file_group_id });
    const after = await slotOf(f.e.api, f.taskId, 'A2');
    expect(after.files).toHaveLength(2);
    const old = after.files.find((x) => x.version === 1)!;
    const cur = after.files.find((x) => x.version === 2)!;
    expect(old).toMatchObject({ is_current: false, superseded_by: v2.body.id });
    expect(cur).toMatchObject({ is_current: true, superseded_by: null });
    expect(old.download_name).toMatch(/_v1\.pdf$/);
    expect(cur.download_name).toMatch(/\.png$/);
    expect(cur.download_name).not.toMatch(/_v\d/);
    const r1 = await download(f.e.api, old.id);
    expect(r1.status).toBe(200);
    expect(bytes(r1).equals(PDF)).toBe(true);
    expect(bytes(await download(f.e.api, cur.id)).equals(PNG)).toBe(true);
    // the site Documents list: current files only, or the history
    const listed = await f.e.api.call('get', `/documents?site_id=${f.site.id}`);
    expect(listed.body.items.map((i: { file: { id: string } }) => i.file.id)).toEqual([cur.id]);
    const hist = await f.e.api.call('get', `/documents?site_id=${f.site.id}&include_superseded=true`);
    expect(hist.body.items.map((i: { file: { id: string } }) => i.file.id).sort()).toEqual([old.id, cur.id].sort());
    const group = await f.e.api.call('get', `/documents?file_group_id=${v1.body.file_group_id}`);
    expect(group.body.items).toHaveLength(2);
  });
});

describe('download: name, headers, audit, scope', () => {
  it('names the file SITE_TASK_DOC_DATE.ext, serves it as an attachment and audits every download before it', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const up = await upload(f.e.api, f.taskId, s.id, PDF, 'anything at all.pdf');
    const d = await today();
    const expected = `${f.site.code.replace(/[^A-Za-z0-9-]/g, '-')}_A2_A2_DRAFT-${d}.pdf`;
    expect(up.body.download_name).toBe(expected);
    const before = (await q('SELECT 1 FROM audit_log WHERE action = $1 AND entity_id = $2', ['document_file_download', up.body.id])).length;
    const r = await download(f.e.api, up.body.id);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${expected}"`);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(bytes(r).equals(PDF)).toBe(true);
    await download(f.e.api, up.body.id);
    const rows = await q<{ actor_id: string; site_id: string; after: { download_name: string; sha256: string } }>('SELECT actor_id, site_id, after FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', ['document_file_download', up.body.id]);
    expect(rows.length - before).toBe(2);
    expect(rows[0]).toMatchObject({ actor_id: f.e.user.id, site_id: f.site.id });
    expect(rows[0]!.after).toMatchObject({ download_name: expected, sha256: up.body.sha256 });
  });

  it('answers 404 outside the regions, 403 without the download grant, and writes no audit row for them', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const up = await upload(f.e.api, f.taskId, s.id, PDF, 'a.pdf');
    const other = await actor(app, db, { level: 'entry', regions: [4], grants: DOC_GRANTS });
    expect((await download(other.api, up.body.id)).status).toBe(404);
    expect((await other.api.call('get', `/documents?site_id=${f.site.id}`)).body.items).toEqual([]);
    const noGrant = await actor(app, db, { level: 'entry', regions: [5], grants: [['sites', 'view'], ['sites', 'edit']] });
    const r = await download(noGrant.api, up.body.id);
    expect(r.status).toBe(403);
    expect((await noGrant.api.call('get', `/documents?site_id=${f.site.id}`)).status).toBe(200); // view is not download
    expect((await q('SELECT 1 FROM audit_log WHERE action = $1 AND entity_id = $2', ['document_file_download', up.body.id])).length).toBe(0);
    expect((await download(f.e.api, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await download(f.e.api, 'not-a-uuid')).status).toBe(404);
  });

  it('lists the files with filters and region scope', async () => {
    const f = await docFlow(app, db, 'A2');
    const g = await docFlow(app, db, 'A3', { site: f.site, entry: f.e, approve: f.a });
    await upload(f.e.api, f.taskId, (await slotOf(f.e.api, f.taskId, 'A2')).id, PDF, 'a.pdf');
    await upload(f.e.api, g.taskId, (await slotOf(f.e.api, g.taskId, 'A3')).id, PNG, 'b.png');
    const all = await f.e.api.call('get', `/documents?site_id=${f.site.id}`);
    expect(all.body.items.map((i: { doc_code: string }) => i.doc_code).sort()).toEqual(['A2', 'A3']);
    expect(all.body.items[0]).toMatchObject({ site_code: f.site.code, region_id: 5, stage_code: 'MS1' });
    const byDoc = await f.e.api.call('get', `/documents?site_id=${f.site.id}&doc_code=A3`);
    expect(byDoc.body.items.map((i: { doc_code: string }) => i.doc_code)).toEqual(['A3']);
    expect((await f.e.api.call('get', `/documents?site_id=${f.site.id}&task_code=A2`)).body.items).toHaveLength(1);
    expect((await f.e.api.call('get', `/documents?site_id=${f.site.id}&stage_code=MS2`)).body.items).toHaveLength(0);
    expect((await f.e.api.call('get', `/documents?site_id=${f.site.id}&kind=photo`)).body.items).toHaveLength(0);
    expect((await f.e.api.call('get', `/documents?site_id=${f.site.id}&slot_status=uploaded`)).body.items).toHaveLength(2);
    expect((await f.e.api.call('get', `/documents?site_id=${f.site.id}&q=${f.site.code}`)).body.items).toHaveLength(2);
    expect((await f.e.api.call('get', `/documents?site_id=${f.site.id}&limit=1`)).body.page.next_cursor).not.toBeNull();
    expect((await f.e.api.call('get', `/documents?kind=nonsense`)).status).toBe(422);
    const page2 = await f.e.api.call('get', `/documents?site_id=${f.site.id}&limit=1`);
    const next = await f.e.api.call('get', `/documents?site_id=${f.site.id}&limit=1&cursor=${page2.body.page.next_cursor}`);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].file.id).not.toBe(page2.body.items[0].file.id);
    // a user with no module access at all
    const nobody = await actor(app, db, { level: 'view', regions: [5], grants: [['approvals', 'view']] });
    expect((await nobody.api.call('get', '/documents')).status).toBe(403);
  });
});

describe('photos: EXIF capture date', () => {
  it('reads the capture date, flags a photo without one, and holds the photo rules', async () => {
    const f = await docFlow(app, db, 'B9');
    const s = await slotOf(f.e.api, f.taskId, 'B9');
    expect(s).toMatchObject({ kind: 'photo', formats: ['jpg', 'jpeg', 'png', 'heic'] });
    const dated = await upload(f.e.api, f.taskId, s.id, jpegWithExif('2026:03:04 10:20:30'), 'IMG_1.jpg');
    expect(dated.status).toBe(201);
    expect(dated.body).toMatchObject({ capture_date: '2026-03-04T10:20:30.000Z', unknown_capture_date: false });
    const bare = await upload(f.e.api, f.taskId, s.id, jpegWithExif(null), 'IMG_2.jpg');
    expect(bare.status).toBe(201);
    expect(bare.body).toMatchObject({ capture_date: null, unknown_capture_date: true });
    const png = await upload(f.e.api, f.taskId, s.id, PNG, 'shot.png');
    expect(png.body.unknown_capture_date).toBe(true);
    // a PDF is not a photo
    expect((await upload(f.e.api, f.taskId, s.id, PDF, 'doc.pdf')).body.reason).toBe('format_not_allowed');
    const row = (await q<{ capture_date: Date | null; unknown_capture_date: boolean }>('SELECT capture_date, unknown_capture_date FROM document_files WHERE id = $1', [dated.body.id]))[0]!;
    expect(row.capture_date?.toISOString()).toBe('2026-03-04T10:20:30.000Z');
    expect(row.unknown_capture_date).toBe(false);
  });
});

describe('the database is the gate', () => {
  it('pmis_app cannot write the document tables or call the internal functions; the files are never deleted or rewritten', async () => {
    const f = await docFlow(app, db, 'A2');
    const s = await slotOf(f.e.api, f.taskId, 'A2');
    const up = await upload(f.e.api, f.taskId, s.id, PDF, 'a.pdf');
    const { Client } = await import('pg');
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL_DOCS });
    await c.connect();
    try {
      for (const sql of [
        `UPDATE document_slots SET status = 'approved'`, `INSERT INTO document_slots (site_id, region_id, doc_type_id) SELECT site_id, region_id, doc_type_id FROM document_slots LIMIT 1`,
        `UPDATE document_files SET sha256 = 'x'`, `DELETE FROM document_files`, `UPDATE document_types SET is_mandatory = false`, `DELETE FROM document_type_placements`,
        `INSERT INTO document_export_jobs (requested_by, scope) VALUES (gen_random_uuid(), '{}')`, `DELETE FROM document_type_versions`,
      ]) {
        await expect(c.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
      await expect(c.query(`SELECT doc_sync_task_slots_core('${f.taskId}')`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`SELECT doc_apply_spec(gen_random_uuid(), '{}')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
    // even the definer path cannot change what a stored file is
    await expect(db.query(`UPDATE document_files SET storage_key = 'docs/x/y' WHERE id = $1`, [up.body.id])).rejects.toThrow(/never change/);
    await expect(db.query(`DELETE FROM document_files WHERE id = $1`, [up.body.id])).rejects.toThrow(/never deleted/);
  });
});

describe('a task of another site is untouched', () => {
  it('slots are per task: a second site with the same task code has its own', async () => {
    const f = await docFlow(app, db, 'A2');
    const g = await docFlow(app, db, 'A2', { entry: f.e, approve: f.a });
    await upload(f.e.api, f.taskId, (await slotOf(f.e.api, f.taskId, 'A2')).id, PDF, 'a.pdf');
    expect((await slotOf(f.e.api, g.taskId, 'A2')).files).toEqual([]);
    const site = await makeSite(db, 5);
    const t = await makeTask(db, site, 'A2', 'open');
    expect((await slots(f.e.api, t)).map((s) => s.status)).toEqual(['missing']);
  });
});
