import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Migration 0740, contract 0.15.620: personal coloured labels on records. */
const TAG = randomBytes(3).toString('hex');
let app: NestExpressApplication;
let db: PgClient;
beforeAll(async () => { app = await startApp(); db = await superDb(); });
afterAll(async () => { await db.end(); await app.close(); });

describe('personal labels', () => {
  it('create, rename, assign, list links, unassign, hide; another person sees nothing of it', async () => {
    const ann = await actor(app, db, { grants: [['sites', 'view']] });
    const ben = await actor(app, db, { grants: [['sites', 'view']] });
    const made = await ann.api.call('post', '/labels', { name: `Urgent ${TAG}`, colour: 'red' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: `Urgent ${TAG}`, colour: 'red', is_active: true, link_count: 0 });
    const id = made.body.id as string;
    expect((await ann.api.call('post', '/labels', { name: `urgent ${TAG}`, colour: 'blue' })).status).toBe(409);
    expect((await ann.api.call('post', '/labels', { name: 'x', colour: 'pink-ish' })).status).toBe(422);
    const renamed = await ann.api.call('patch', `/labels/${id}`, { colour: 'teal' });
    expect(renamed.body).toMatchObject({ colour: 'teal', name: `Urgent ${TAG}` });
    const rec = '5f0d2e0e-7d7e-4c0e-9a77-111111111111';
    expect((await ann.api.call('post', `/labels/${id}/assign`, { kind: 'site', ref_id: rec })).body).toMatchObject({ on: true });
    expect((await ann.api.call('post', `/labels/${id}/assign`, { kind: 'site', ref_id: rec })).status).toBe(200);
    expect((await ann.api.call('get', '/labels/links?kind=site')).body.items).toEqual([{ ref_id: rec, context: null, label_ids: [id] }]);
    expect((await ann.api.call('post', `/labels/${id}/assign`, { kind: 'site', ref_id: rec, context: 'x' })).status).toBe(422);
    const rr = '5f0d2e0e-7d7e-4c0e-9a77-222222222222';
    await ann.api.call('post', `/labels/${id}/assign`, { kind: 'register_record', ref_id: rr, context: 'car_dispatcher' });
    expect((await ann.api.call('get', '/labels/links?kind=register_record')).body.items).toEqual([{ ref_id: rr, context: 'car_dispatcher', label_ids: [id] }]);
    await ann.api.call('post', `/labels/${id}/unassign`, { kind: 'register_record', ref_id: rr });
    expect((await ann.api.call('get', '/labels')).body.items.find((l: { id: string }) => l.id === id)).toMatchObject({ link_count: 1 });
    // ben: nothing of ann's, and no way to use her label
    expect((await ben.api.call('get', '/labels')).body.items).toEqual([]);
    expect((await ben.api.call('get', '/labels/links?kind=site')).body.items).toEqual([]);
    expect((await ben.api.call('post', `/labels/${id}/assign`, { kind: 'site', ref_id: rec })).status).toBe(404);
    expect((await ben.api.call('patch', `/labels/${id}`, { name: 'mine now' })).status).toBe(404);
    expect((await ben.api.call('post', `/labels/${id}/archive`)).status).toBe(404);
    expect((await ann.api.call('post', `/labels/${id}/unassign`, { kind: 'site', ref_id: rec })).body).toMatchObject({ on: false });
    expect((await ann.api.call('get', '/labels/links?kind=site')).body.items).toEqual([]);
    // hide, never delete: the row stays, the lists drop it
    expect((await ann.api.call('post', `/labels/${id}/archive`)).body).toMatchObject({ is_active: false });
    expect((await ann.api.call('get', '/labels')).body.items.map((l: { id: string }) => l.id)).not.toContain(id);
    const row = await db.query('SELECT is_active FROM user_labels WHERE id = $1', [id]);
    expect(row.rows[0]).toEqual({ is_active: false });
    expect((await ann.api.call('get', '/labels/links?kind=bogus')).status).toBe(422);
  });
});
