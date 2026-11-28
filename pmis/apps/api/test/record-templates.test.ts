import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Migration 0741, contract 0.15.621: personal record templates. */
const TAG = randomBytes(3).toString('hex');
let app: NestExpressApplication;
let db: PgClient;
beforeAll(async () => { app = await startApp(); db = await superDb(); });
afterAll(async () => { await db.end(); await app.close(); });

describe('personal record templates', () => {
  it('save, list per register, unique name, hide; another person sees nothing', async () => {
    const ann = await actor(app, db, { grants: [['sites', 'view']] });
    const ben = await actor(app, db, { grants: [['sites', 'view']] });
    const body = { register_key: 'procurement', name: `Weekly ${TAG}`, record_type: 'pr', data: { remark: 'Spare parts', qty: 4, urgent: true } };
    const made = await ann.api.call('post', '/record-templates', body);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ register_key: 'procurement', name: `Weekly ${TAG}`, record_type: 'pr', data: { remark: 'Spare parts', qty: 4, urgent: true } });
    expect((await ann.api.call('post', '/record-templates', { ...body, name: `weekly ${TAG}` })).status).toBe(409);
    expect((await ann.api.call('post', '/record-templates', { ...body, name: '' })).status).toBe(422);
    expect((await ann.api.call('post', '/record-templates', { ...body, data: { x: { nested: 1 } } })).status).toBe(422);
    expect((await ann.api.call('get', '/record-templates?register_key=procurement')).body.items.map((t: { id: string }) => t.id)).toEqual([made.body.id]);
    expect((await ann.api.call('get', '/record-templates?register_key=gecol')).body.items).toEqual([]);
    expect((await ben.api.call('get', '/record-templates?register_key=procurement')).body.items).toEqual([]);
    expect((await ben.api.call('post', `/record-templates/${made.body.id}/archive`)).status).toBe(404);
    expect((await ann.api.call('post', `/record-templates/${made.body.id}/archive`)).body).toMatchObject({ id: made.body.id });
    expect((await ann.api.call('get', '/record-templates?register_key=procurement')).body.items).toEqual([]);
    const row = await db.query('SELECT is_active FROM user_record_templates WHERE id = $1', [made.body.id]);
    expect(row.rows[0]).toEqual({ is_active: false });
    expect((await ann.api.call('get', '/record-templates')).status).toBe(422);
  });
});
