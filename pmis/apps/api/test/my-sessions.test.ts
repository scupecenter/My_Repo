import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeUser, startApp, superDb } from './helpers';

// "My sessions" (contract 0.15.101): own devices, ending them. Own rows only.
let app: NestExpressApplication;
let db: Pg;
beforeAll(async () => { app = await startApp(); db = await superDb(); });
afterAll(async () => { await app.close(); await db.end(); });

describe('my sessions', () => {
  it('lists only my live sessions, ends another one of mine, never the current one and never someone else\'s', async () => {
    const u = await makeUser(db, { assigned: true });
    const other = await makeUser(db, { assigned: true });
    const here = await loggedIn(app, u);
    const there = await loggedIn(app, u);
    const stranger = await loggedIn(app, other);
    const list = await here.call('get', '/me/sessions');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.filter((s: { is_current: boolean }) => s.is_current)).toHaveLength(1);
    const cur = list.body.items.find((s: { is_current: boolean }) => s.is_current).session_id as string;
    const oth = list.body.items.find((s: { is_current: boolean }) => !s.is_current).session_id as string;
    expect((await here.call('post', `/me/sessions/${cur}/revoke`, {})).status).toBe(422);
    const theirs = (await stranger.call('get', '/me/sessions')).body.items[0].session_id as string;
    expect((await here.call('post', `/me/sessions/${theirs}/revoke`, {})).status).toBe(404);
    expect((await stranger.call('get', '/me/sessions')).status).toBe(200);
    const ok = await here.call('post', `/me/sessions/${oth}/revoke`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.revoked_count).toBe(1);
    expect((await there.call('get', '/me/sessions')).status).toBe(401);
    expect((await here.call('get', '/me/sessions')).body.items).toHaveLength(1);
  });

  it('signs out every other device at once and keeps this one', async () => {
    const u = await makeUser(db, { assigned: true });
    const a = await loggedIn(app, u);
    const b = await loggedIn(app, u);
    const c = await loggedIn(app, u);
    const r = await a.call('post', '/me/sessions/revoke-others', {});
    expect(r.status).toBe(200);
    expect(r.body.revoked_count).toBe(2);
    expect((await b.call('get', '/me/sessions')).status).toBe(401);
    expect((await c.call('get', '/me/sessions')).status).toBe(401);
    expect((await a.call('get', '/me/sessions')).body.items).toHaveLength(1);
  });
});
