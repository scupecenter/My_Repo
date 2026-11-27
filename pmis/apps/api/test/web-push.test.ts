import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { PUSH_PAYLOAD, PushService } from '../src/push/push.service';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/** Item 13 (migration 0256, contract 0.15.156): Web Push is off without keys; own browsers only; the sender pushes a fixed payload with no text. */
let off: NestExpressApplication;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let a: Actor;
let b: Actor;
const U = randomUUID().slice(0, 8);
const ep = (n: string) => `https://push.example.test/${U}/${n}`;
const sub = (n: string) => ({ endpoint: ep(n), keys: { p256dh: 'BPublicKeyForTestingOnly1234567890', auth: 'authsecret12345' } });

beforeAll(async () => {
  off = await startApp();
  app = await startApp({ webPush: { enabled: true, publicKey: 'BTestPublicKey', privateKey: 'test-private', subject: 'mailto:ops@example.test' } });
  db = await superDb();
  admin = await plainAdmin(app, db);
  a = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  b = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
});
afterAll(async () => {
  await db.end();
  await app.close();
  await off.close();
});

describe('web push', () => {
  it('is off without keys: status says so and subscribing is refused', async () => {
    const offUser = await actor(off, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
    const st = await offUser.api.call('get', '/me/push');
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: false, public_key: null, count: 0 });
    expect((await offUser.api.call('post', '/me/push/subscribe', sub('x'))).status).toBe(409);
  });

  it('keeps browsers per person, refuses bad input and shows the admin counts to a System Admin only', async () => {
    expect((await a.api.call('get', '/me/push')).body).toMatchObject({ enabled: true, public_key: 'BTestPublicKey' });
    expect((await a.api.call('post', '/me/push/subscribe', { endpoint: 'http://insecure.example.test/x', keys: sub('y').keys })).status).toBe(422);
    expect((await a.api.call('post', '/me/push/subscribe', sub('a1'))).status).toBe(200);
    expect((await a.api.call('get', `/me/push?endpoint=${encodeURIComponent(ep('a1'))}`)).body).toMatchObject({ count: 1, this_browser: true });
    expect((await b.api.call('get', `/me/push?endpoint=${encodeURIComponent(ep('a1'))}`)).body).toMatchObject({ count: 0, this_browser: false });
    const other = await b.api.call('post', '/me/push/unsubscribe', { endpoint: ep('a1') });
    expect(other.body.removed).toBe(0);                                   // not b's browser
    expect((await a.api.call('get', '/me/push')).body.count).toBe(1);
    expect((await a.api.call('get', '/admin/web-push')).status).toBe(403);
    const ad = await admin.api.call('get', '/admin/web-push');
    expect(ad.status).toBe(200);
    expect(ad.body.enabled).toBe(true);
    expect(ad.body.subscriptions).toBeGreaterThanOrEqual(1);
    const w = await db.query(`SELECT has_table_privilege('pmis_app', 'push_subscriptions', 'INSERT') AS w`);
    expect(w.rows[0].w).toBe(false);
  });

  it('sends one fixed payload per browser with new unread notifications, moves the cursor, and drops a gone browser', async () => {
    const svc = app.get(PushService);
    const calls: { endpoint: string; payload: string }[] = [];
    svc.send = async (s, payload) => { calls.push({ endpoint: s.endpoint, payload }); if (s.endpoint === ep('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 }); return { statusCode: 201 }; };
    expect((await a.api.call('post', '/me/push/subscribe', sub('a2'))).status).toBe(200);
    expect((await b.api.call('post', '/me/push/subscribe', sub('gone'))).status).toBe(200);
    await db.query(`UPDATE push_subscriptions SET last_notification_at = now() - interval '1 hour' WHERE endpoint LIKE $1`, [`%/${U}/%`]);
    await db.query(`INSERT INTO notifications (user_id, channel, kind, title, body) VALUES ($1, 'in_app', 'assigned', 'SECRET-SITE-TITLE', 'secret body')`, [a.user.id]);
    await db.query(`INSERT INTO notifications (user_id, channel, kind, title, body) VALUES ($1, 'in_app', 'assigned', 'x', 'y')`, [b.user.id]);
    const r = await svc.sendDue();
    expect(r.sent).toBeGreaterThanOrEqual(2);
    const mine = calls.filter((c) => c.endpoint.includes(`/${U}/`));
    expect(mine.map((c) => c.endpoint).sort()).toEqual([ep('a1'), ep('a2'), ep('gone')].sort());
    for (const c of mine) { expect(c.payload).toBe(PUSH_PAYLOAD); expect(c.payload).not.toContain('SECRET'); }
    const left = await db.query(`SELECT endpoint FROM push_subscriptions WHERE endpoint LIKE $1`, [`%/${U}/%`]);
    expect(left.rows.map((x: { endpoint: string }) => x.endpoint)).not.toContain(ep('gone'));
    calls.length = 0;
    await svc.sendDue();
    expect(calls.filter((c) => c.endpoint.includes(`/${U}/`))).toHaveLength(0);   // cursor moved: nothing new, nothing sent
  });
});
