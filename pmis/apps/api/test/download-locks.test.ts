import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';
import { ExportAction, ExportLockInterceptor } from '../src/security/export-lock';

/**
 * Download lock categories (migration 0293, contract 0.15.193): GET / PUT /settings/download-locks. All three switches are off by default. Only a System Admin changes them
 * (a settings delegate does not), with a reason, a step-up and If-Match; every change is audited. Enforcement of the routes is tested on the interceptor with a stub so no
 * other suite that downloads a template or a file ever meets a lock; the API door tests flip only `generated_documents`, briefly, and always turn it back off.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let delegateAll: Actor;
const REASON = 'Close the generated documents';
const OFF = { templates: false, uploaded_files: false, generated_documents: false };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  delegateAll = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, delegateAll.user.id, [['settings', 'edit']]);
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '{"templates": false, "uploaded_files": false, "generated_documents": false}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'security.download_locks'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/download-locks');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/download-locks', body, tag === undefined ? {} : { 'If-Match': tag });
const value = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'security.download_locks'`))[0]?.value;
const audits = () => q<{ before: any; after: any; reason: string; actor_id: string }>(db,
  `SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'download_locks_update' AND entity_id = 'security.download_locks' ORDER BY id`);

describe('GET and PUT /settings/download-locks', () => {
  it('all three are off by default; every signed-in user reads them; only a System Admin can edit', async () => {
    for (const [who, can] of [[plain, false], [delegateAll, false], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(etag(r)).toMatch(/^"\d{1,10}"$/);
      expect(r.body).toMatchObject({ ...OFF, updated_by: null, can_edit: can });
    }
    expect((await new Api(app).raw('get', '/settings/download-locks')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, delegateAll]) {
      const r = await put(who, { ...OFF, generated_documents: true, reason: REASON }, tag);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    expect(await value()).toEqual(OFF);
    expect(await audits()).toHaveLength(0);
  });

  it('checks the body, If-Match and the step-up', async () => {
    const tag = etag(await read(admin));
    const body = { ...OFF, generated_documents: true, reason: REASON };
    expect((await put(admin, body)).status).toBe(428);
    const stale = await put(admin, body, '"1"');
    expect(stale.status).toBe(412);
    const noStepUp = await put(noStep, body, tag);
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    for (const bad of [{ ...body, templates: 'yes' }, { ...body, uploaded_files: null }, { templates: true, reason: REASON }, { ...body, reason: 'ab' }, { ...body, extra: 1 }]) {
      expect((await put(admin, bad, tag)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(await value()).toEqual(OFF);
  });

  it('saves with before and after in the audit log, refuses the same values (409), and turning it off is as easy as turning it on', async () => {
    const cur = await read(admin);
    const on = await put(admin, { ...OFF, generated_documents: true, reason: REASON }, etag(cur));
    try {
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ ...OFF, generated_documents: true, updated_by: { id: admin.user.id }, can_edit: true });
      expect(await value()).toEqual({ ...OFF, generated_documents: true });
      const a = await audits();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ actor_id: admin.user.id, reason: REASON, before: OFF, after: { ...OFF, generated_documents: true } });
      const same = await put(admin, { ...OFF, generated_documents: true, reason: REASON }, etag(on));
      expect(same.status).toBe(409);
      expect((await put(admin, { ...OFF, reason: REASON }, etag(cur))).status).toBe(412);
    } finally {
      const off = await put(admin, { ...OFF, reason: REASON }, etag(await read(admin)));
      expect(off.status).toBe(200);
    }
    expect(await value()).toEqual(OFF);
    expect(await audits()).toHaveLength(2);
  });

  it('the setting cannot be written around the door: a direct write by the application role changes nothing', async () => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE pmis_app');
      await db.query(`UPDATE settings SET value = '{"templates": true, "uploaded_files": true, "generated_documents": true}'::jsonb WHERE key = 'security.download_locks'`).catch(() => undefined);
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await value()).toEqual(OFF);
  });

  it('download_lock_active answers one boolean per key and refuses an unknown key', async () => {
    expect((await q<{ a: boolean; b: boolean; c: boolean }>(db, `SELECT download_lock_active('templates') AS a, download_lock_active('uploaded_files') AS b, download_lock_active('generated_documents') AS c`))[0]).toEqual({ a: false, b: false, c: false });
    await expect(db.query(`SELECT download_lock_active('template')`)).rejects.toThrow(/unknown download lock key/);
  });
});

describe('category enforcement (interceptor, stubbed lock state)', () => {
  class Handlers {
    @ExportAction({ category: 'templates' }) templates() {}
    @ExportAction({ category: 'generated_documents', exceptQuery: { name: 'purpose', values: ['view'] } }) generated() {}
    @ExportAction() plainExport() {}
  }
  const run = async (handler: keyof Handlers, active: Record<string, boolean>, query: Record<string, string> = {}) => {
    const calls: string[] = [];
    const stub = { tx: { $queryRaw: (sql: { values: unknown[] }) => { const key = String(sql.values[0] ?? 'disable_export'); calls.push(key); return Promise.resolve([{ on: active[key] === true }]); } } };
    const itc = new ExportLockInterceptor(new Reflector(), stub as never);
    const ctx = { getHandler: () => Handlers.prototype[handler], getClass: () => Handlers, switchToHttp: () => ({ getRequest: () => ({ query }) }) } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('ran') };
    const out = await lastValueFrom(itc.intercept(ctx, next)).then((v) => v, (e: any) => e);
    return { out, calls };
  };

  it('a locked category answers 403 download_locked; the same category off, or another category on, lets it through', async () => {
    const locked = await run('templates', { templates: true });
    expect(locked.out.getStatus?.()).toBe(403);
    expect(locked.out.opts.errors[0].code).toBe('download_locked');
    expect((await run('templates', { templates: false })).out).toBe('ran');
    expect((await run('templates', { uploaded_files: true, generated_documents: true, disable_export: true })).out).toBe('ran');
  });

  it('a category route is not gated by disable_export, and an export route is not gated by a category', async () => {
    expect((await run('generated', { disable_export: true })).out).toBe('ran');
    const e = await run('plainExport', { templates: true, uploaded_files: true, generated_documents: true });
    expect(e.out).toBe('ran');
    expect(e.calls).toEqual(['disable_export']);
  });

  it('viewing on screen stays open while the generated documents are locked, a download or a print does not', async () => {
    expect((await run('generated', { generated_documents: true }, { purpose: 'view' })).out).toBe('ran');
    for (const purpose of ['download', 'print']) expect((await run('generated', { generated_documents: true }, { purpose })).out.getStatus?.()).toBe(403);
    expect((await run('generated', { generated_documents: true })).out.getStatus?.()).toBe(403);
  });
});
