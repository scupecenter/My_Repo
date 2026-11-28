import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAnswers, type FieldForm } from '../src/field-forms/field-forms.service';
import { q } from './calc-helpers';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/** Offline field forms (migration 0667, contract 0.15.596): the kinds are the setting field.forms; a filled form is one idempotent row. The suite puts the setting back at the end. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let viewer: Actor;
let outsider: Actor;
let regDelegate: Actor;
let siteId: string;
const REASON = 'Owner request 2026-11-28';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const KIND = { code: 'handover', name_en: 'Handover', name_ar: 'تسليم', enabled: true, signature: true, fields: [
  { key: 'note', label_en: 'Note', label_ar: '', type: 'text', required: true, options: [] },
  { key: 'state', label_en: 'State', label_ar: '', type: 'choice', required: false, options: ['good', 'bad'] },
  { key: 'qty', label_en: 'Qty', label_ar: '', type: 'number', required: false, options: [] },
] };
const PLAIN = { ...KIND, code: 'plain', signature: false, fields: [KIND.fields[0]] };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  noStep = await plainAdmin(app, db, false);
  viewer = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  outsider = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [9], modules: null });
  regDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, regDelegate.user.id, [['settings', 'edit']], [5]);
  siteId = (await makeSite(db, 5)).id;
});
afterAll(async () => {
  await db.query(`DELETE FROM field_form_submissions WHERE site_id = $1`, [siteId]).catch(() => undefined);
  await db.query(`UPDATE settings SET value = '{"forms":[]}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'field.forms'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/field-forms');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/field-forms', body, tag === undefined ? {} : { 'If-Match': tag });
const send = (who: Actor, over: Record<string, unknown> = {}, site = siteId) => who.api.call('post', `/sites/${site}/field-forms`, {
  client_id: uuid(1), form_code: 'handover', answers: { note: 'ok' }, signature: PNG, signer_name: 'Ali', captured_at: new Date().toISOString(), ...over,
});

describe('checkAnswers', () => {
  const f = KIND as unknown as FieldForm;
  it('needs the required field, refuses an unknown key, a wrong type and an unlisted choice', () => {
    expect(checkAnswers(f, { note: 'x' })).toEqual([]);
    expect(checkAnswers(f, {}).map((e) => e.code)).toEqual(['required']);
    expect(checkAnswers(f, { note: 'x', other: 1 }).map((e) => e.code)).toEqual(['unknown_field']);
    expect(checkAnswers(f, { note: 'x', qty: '3' }).map((e) => e.code)).toEqual(['invalid']);
    expect(checkAnswers(f, { note: 'x', state: 'weird' }).map((e) => e.code)).toEqual(['invalid']);
  });
});

describe('GET and PUT /settings/field-forms', () => {
  it('every signed-in user reads the kinds; only an admin or an all-regions settings delegate edits, with If-Match and the step-up', async () => {
    const r = await read(viewer);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ forms: [], can_edit: false });
    expect((await new Api(app).raw('get', '/settings/field-forms')).status).toBe(401);
    const tag = etag(await read(admin));
    const body = { forms: [KIND, PLAIN], reason: REASON };
    expect((await put(viewer, body, tag)).status).toBe(403);
    expect((await put(regDelegate, body, tag)).status).toBe(403);
    expect((await put(admin, body)).status).toBe(428);
    expect((await put(admin, body, '"999"')).status).toBe(412);
    expect((await put(noStep, body, tag)).body.code).toBe('step_up_required');
    for (const bad of [
      { ...body, forms: [KIND, KIND] }, { ...body, forms: [{ ...KIND, fields: [KIND.fields[0], KIND.fields[0]] }] },
      { ...body, forms: [{ ...KIND, fields: [{ ...KIND.fields[1], options: ['one'] }] }] }, { ...body, reason: 'ab' }, { ...body, extra: 1 },
    ]) expect((await put(admin, bad, tag)).status, JSON.stringify(bad)).toBe(422);
  });

  it('saves, audits and refuses the same values again (409)', async () => {
    const cur = await read(admin);
    const ok = await put(admin, { forms: [KIND, PLAIN], reason: REASON }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body.forms).toHaveLength(2);
    expect(ok.body.version).toBe(cur.body.version + 1);
    expect((await put(admin, { forms: [KIND, PLAIN], reason: REASON }, etag(ok))).status).toBe(409);
    const a = await q<{ reason: string }>(db, `SELECT reason FROM audit_log WHERE entity_id = 'field.forms' ORDER BY id DESC LIMIT 1`);
    expect(a[0]?.reason).toBe(REASON);
  });
});

describe('POST and GET /sites/:id/field-forms', () => {
  it('stores a signed form once: a replay with the same client_id returns the first row', async () => {
    const a = await send(viewer);
    expect(a.status).toBe(201);
    expect(a.body.replayed).toBe(false);
    const b = await send(viewer, { answers: { note: 'changed' } });
    expect(b.body).toMatchObject({ id: a.body.id, replayed: true });
    const rows = await q<{ n: string }>(db, `SELECT count(*) AS n FROM field_form_submissions WHERE site_id = $1`, [siteId]);
    expect(Number(rows[0]?.n)).toBe(1);
    const list = await viewer.api.call('get', `/sites/${siteId}/field-forms`);
    expect(list.status).toBe(200);
    expect(list.body.items).toMatchObject([{ id: a.body.id, form_code: 'handover', signed: true, signer_name: 'Ali' }]);
    const sig = await viewer.api.call('get', `/field-forms/${a.body.id}/signature`);
    expect(sig.body).toEqual({ signature: PNG });
  });

  it('refuses a bad form: unknown code, missing signature or signer, a signature on an unsigned kind, a wrong answer, a bad image', async () => {
    for (const over of [
      { form_code: 'nope' }, { signature: null }, { signer_name: null }, { form_code: 'plain', signature: PNG }, { answers: {} }, { answers: { note: 'x', state: 'weird' } },
      { signature: 'data:image/jpeg;base64,AAAA' }, { extra: 1 },
    ]) expect((await send(viewer, { client_id: uuid(2), ...over })).status, JSON.stringify(over)).toBe(422);
    expect((await send(viewer, { client_id: uuid(3), form_code: 'plain', signature: null, signer_name: null })).status).toBe(201);
  });

  it('is for the view right of the site region, and the signature follows the same right', async () => {
    expect((await send(outsider, { client_id: uuid(4) })).status).toBe(403);
    expect((await outsider.api.call('get', `/sites/${siteId}/field-forms`)).status).toBe(403);
    const id = (await q<{ id: string }>(db, `SELECT id FROM field_form_submissions WHERE site_id = $1 AND signature IS NOT NULL LIMIT 1`, [siteId]))[0]!.id;
    expect((await outsider.api.call('get', `/field-forms/${id}/signature`)).status).toBe(403);
    expect((await send(viewer, { client_id: uuid(5) }, 'not-a-uuid')).status).toBe(422);
    expect((await new Api(app).raw('post', `/sites/${siteId}/field-forms`, {})).status).toBe(401);
  });
});
