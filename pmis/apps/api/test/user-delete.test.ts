import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, loggedIn, makeAdmin, makeUser, startApp, superDb } from './helpers';

let app: NestExpressApplication;
let db: Pg;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe('soft delete and restore (B14, migration 0012)', () => {
  it('needs step-up and If-Match, ends sessions, stops sign-in, lists the user as deleted, then restores the old status', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const target = await makeUser(db, { assigned: true });
    const theirs = await loggedIn(app, target);
    expect((await theirs.call('get', '/me')).status).toBe(200);

    const etag = (await api.call('get', `/users/${target.id}`)).headers['etag']!;
    expect((await api.call('post', `/users/${target.id}/delete`, { reason: 'Left the company' })).status).toBe(428);
    const noStepUp = await api.call('post', `/users/${target.id}/delete`, { reason: 'Left the company' }, { 'If-Match': etag });
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    await api.stepUp(admin.password);
    expect((await api.call('post', `/users/${target.id}/delete`, { reason: 'x' }, { 'If-Match': etag })).status).toBe(422);
    const del = await api.call('post', `/users/${target.id}/delete`, { reason: 'Left the company' }, { 'If-Match': etag });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id: target.id, status: 'disabled', delete_reason: 'Left the company', can_restore: true });
    expect(del.body.deleted_at).toBeTruthy();
    expect(del.body.deleted_by).toMatchObject({ id: admin.id });

    expect((await theirs.call('get', '/me')).status).toBe(401); // the session ended
    expect((await new Api(app).login(target.email, target.password)).status).toBe(401); // cannot sign in

    const list = await api.call('get', `/users?q=${encodeURIComponent(target.email)}`);
    expect(list.body.items).toEqual([]); // not in the normal list
    const deleted = await api.call('get', '/users/deleted');
    expect(deleted.body.items.map((u: { id: string }) => u.id)).toContain(target.id);

    const again = await api.call('post', `/users/${target.id}/delete`, { reason: 'Again please' }, { 'If-Match': del.headers['etag']! });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');

    const res = await api.call('post', `/users/${target.id}/restore`, { reason: 'Came back' }, { 'If-Match': del.headers['etag']! });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, status: 'active', deleted_at: null });
    expect((await new Api(app).login(target.email, target.password)).status).toBe(200);
    const audit = await db.query("SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('user_deleted','user_restored') ORDER BY id", [target.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['user_deleted', 'user_restored']);
  });

  it('refuses deleting yourself and refuses a user without users.delete', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    await api.stepUp(admin.password);
    const mine = (await api.call('get', `/users/${admin.id}`)).headers['etag']!;
    const self = await api.call('post', `/users/${admin.id}/delete`, { reason: 'Testing myself' }, { 'If-Match': mine });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');

    const plain = await makeUser(db, { assigned: true });
    const p = await loggedIn(app, plain);
    await p.stepUp(plain.password);
    const res = await p.call('post', `/users/${admin.id}/delete`, { reason: 'Not allowed' }, { 'If-Match': mine });
    expect(res.status).toBe(403);
    expect((await p.call('get', '/users/deleted')).status).toBe(403);
  });
});
