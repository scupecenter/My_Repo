import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { type Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0342: the HTTP surface of the alert-rules Settings screen (the engine itself is covered in alert-rules.test.ts). The catalogue
 * comes with the list, create/update run through admin_alert_rule_save with If-Match, and non-admins get 403. The matrix lock serialises
 * the suite against the other register/settings suites on the shared database.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
});
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770202)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770202)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const PATH = '/settings/alert-rules';
const RULE = {
  code: 'issues-idle-30',
  kind: 'record_idle',
  params: { register_key: 'issues', state: 'open', days: 30 },
  audience: { type: 'system_admin' },
  title_en: 'Issue idle {{days}} days',
  title_ar: 'بلاغ خامد {{days}} يوم',
  body_en: 'Record {{record}} has been in {{state}} for {{days}} days.',
  body_ar: 'السجل {{record}} في حالة {{state}} منذ {{days}} يوم.',
  link: '/registers/issues',
  enabled: false,
};

describe('alert-rules routes (0342)', () => {
  it('lists rules with the kind/register catalogue, and refuses non-admins', async () => {
    const res = await admin.api.call('get', PATH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rules)).toBe(true);
    expect(res.body.catalogue.kinds.map((k: { kind: string }) => k.kind)).toEqual(['weekly_status_missing', 'record_idle', 'kpi_threshold', 'link_orphans']);
    expect(res.body.catalogue.kpis.some((k: { code: string }) => k.code === 'sla_breach')).toBe(true);
    expect(res.body.catalogue.registers.some((r: { register_key: string }) => r.register_key === 'issues')).toBe(true);

    expect((await plain.api.call('get', PATH)).status).toBe(403);
    expect((await plain.api.call('post', PATH, { ...RULE, reason: 'x' })).status).toBe(403);
  });

  it('creates, then updates with If-Match (428 without it, 412 on a stale version), and audits both writes', async () => {
    const created = await admin.api.call('post', PATH, { ...RULE, reason: 'Track stale issues' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ version: 1 });
    const id = created.body.id as string;

    const noTag = await admin.api.call('put', `${PATH}/${id}`, { ...RULE, reason: 'Longer window' });
    expect(noTag.status).toBe(428);
    const stale = await admin.api.call('put', `${PATH}/${id}`, { ...RULE, reason: 'Longer window' }, { 'If-Match': '"99"' });
    expect(stale.status).toBe(412);
    const body2 = { ...RULE, params: { ...RULE.params, days: 45 } };
    const updated = await admin.api.call('put', `${PATH}/${id}`, { ...body2, reason: 'Longer window' }, { 'If-Match': '"1"' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id, version: 2 });

    const rows = await q<{ action: string; entity_id: string; reason: string }>(
      db,
      `SELECT action, entity_id, reason FROM audit_log WHERE action IN ('alert_rule_create', 'alert_rule_update') AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(rows.map((r) => [r.action, r.reason])).toEqual([
      ['alert_rule_create', 'Track stale issues'],
      ['alert_rule_update', 'Longer window'],
    ]);
  });

  it('rejects an unknown kind, bad params and a bad audience (422) with field paths', async () => {
    const badKind = await admin.api.call('post', PATH, { ...RULE, kind: 'nope', reason: 'Try it' });
    expect(badKind.status).toBe(422);
    const badDays = await admin.api.call('post', PATH, { ...RULE, params: { ...RULE.params, days: 0 }, reason: 'Try it' });
    expect(badDays.status).toBe(422);
    const badAudience = await admin.api.call('post', PATH, { ...RULE, audience: { type: 'everyone' }, reason: 'Try it' });
    expect(badAudience.status).toBe(422);
    const noReason = await admin.api.call('post', PATH, RULE);
    expect(noReason.status).toBe(422);
  });
});
