import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { grantProfile, loggedIn, makeUser, startApp, superDb, Api } from './helpers';

/** Migration 0546 (contract 0.15.501): share links for the unified dashboard view. */
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

/** A signed-in person with dashboard view. */
async function person(grants: [string, string][] = [['dashboard', 'view'], ['sites', 'view']]): Promise<Api> {
  const u = await makeUser(db, { assigned: false });
  await grantProfile(db, u.id, grants);
  await db.query("UPDATE users SET status = 'active' WHERE id = $1", [u.id]);
  return loggedIn(app, u);
}

const params = { view: 'pmo', ref_date: '2026-11-27', region_id: '3', stream: 'UNIFIED' };

describe('dashboard share links (0546)', () => {
  it('create → list → resolve returns the stored parameters, audited', async () => {
    const api = await person();
    expect((await api.call('post', '/dashboard/share-links', {})).status).toBe(422);
    expect((await api.call('post', '/dashboard/share-links', { params })).status).toBe(422);

    const res = await api.call('post', '/dashboard/share-links', { params, reason: 'weekly report', days: 7 });
    expect(res.status).toBe(201);
    const link = res.body as Record<string, unknown>;
    expect(link.path).toBe(`/dashboard/shared/${link.token}`);
    expect(link.expires_at).not.toBeNull();
    expect((link.params as Record<string, unknown>).stream).toBe('UNIFIED');

    const list = await api.call('get', '/dashboard/share-links');
    expect((list.body.items as unknown[]).some((l) => (l as Record<string, unknown>).id === link.id)).toBe(true);

    const r = await api.call('get', `/dashboard/shared/${link.token}`);
    expect(r.status).toBe(200);
    expect(r.body.params).toEqual(params);
    expect(typeof r.body.created_by).toBe('string');

    const audit = await db.query(
      `SELECT action FROM audit_log WHERE entity_type = 'dashboard_share_link' AND entity_id = $1 ORDER BY id`,
      [link.id],
    );
    expect(audit.rows.map((x) => x.action)).toEqual(['dashboard_share_created', 'dashboard_share_opened']);
  });

  it('a link grants nothing by itself: the envelope opens for any signed-in user, the data stays the opener\'s own', async () => {
    const owner = await person();
    const res = await owner.call('post', '/dashboard/share-links', { params, reason: 'gate check' });
    expect(res.status).toBe(201);
    const token = (res.body as Record<string, unknown>).token as string;

    // a colleague without dashboard.view can open the envelope, but the dashboard itself still refuses them
    const other = await person([['sites', 'view']]);
    expect((await other.call('get', `/dashboard/shared/${token}`)).status).toBe(200);
    expect((await other.call('get', '/dashboard?view=pmo')).status).toBe(403);

    // and a link never crosses into another person's list
    const otherList = await other.call('get', '/dashboard/share-links');
    expect((otherList.body.items as unknown[]).some((l) => (l as Record<string, unknown>).token === token)).toBe(false);
  });

  it('creating or opening without a session is refused', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/dashboard/share-links').send({ params, reason: 'anon' });
    expect(res.status).toBe(401);
    const open = await request(app.getHttpServer()).get(`/api/v1/dashboard/shared/${'x'.repeat(32)}`);
    expect([401, 404]).toContain(open.status);
  });

  it('revoke closes the link with gone, and a double revoke is a conflict', async () => {
    const api = await person();
    const res = await api.call('post', '/dashboard/share-links', { params, reason: 'revoke me' });
    const link = res.body as Record<string, unknown>;

    const gone = await api.call('post', `/dashboard/share-links/${link.id}/revoke`, { reason: 'no longer needed' });
    expect(gone.status).toBe(200);
    expect((gone.body as Record<string, unknown>).revoked).toBe(true);

    const again = await api.call('post', `/dashboard/share-links/${link.id}/revoke`, { reason: 'no longer needed' });
    expect(again.status).toBe(409);

    const open = await api.call('get', `/dashboard/shared/${link.token}`);
    expect(open.status).toBe(410);
    expect(open.body.code ?? open.body.type).toMatch(/gone/);

    const mine = await api.call('get', '/dashboard/share-links');
    const row = (mine.body.items as Record<string, unknown>[]).find((l) => l.id === link.id);
    expect(row?.revoked_at).not.toBeNull();
  });

  it('an expired link opens as gone; a bogus token is a plain not_found', async () => {
    const api = await person();
    const res = await api.call('post', '/dashboard/share-links', { params, reason: 'expiry', days: 1 });
    const token = (res.body as Record<string, unknown>).token as string;
    await db.query("UPDATE dashboard_share_links SET expires_at = now() - interval '1 hour' WHERE token = $1", [token]);
    expect((await api.call('get', `/dashboard/shared/${token}`)).status).toBe(410);

    const bogus = await api.call('get', `/dashboard/shared/${'x'.repeat(32)}`);
    expect(bogus.status).toBe(404);
  });
});
