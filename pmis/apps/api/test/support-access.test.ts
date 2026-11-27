import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Support access (migration 0291, contract 0.15.191): off by default; a System Admin grants a named user a few write rights for a limited time as an ordinary
 * delegation. Limits: allowlisted rights, mandatory expiry within max_hours, never to yourself, step-up, reason, audit. The suite turns the switch off at the end.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let settingsDelegate: Actor;
let support: Actor;
const REASON = 'Support session for the template review';
const CFG_OFF = '{"enabled": false, "max_hours": 72, "default_hours": 24}';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  settingsDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, settingsDelegate.user.id, [['settings', 'edit']]);
  support = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '${CFG_OFF}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'security.support_access'`);
  await db.query(`UPDATE delegations SET revoked = true, revoked_at = now() WHERE reason LIKE '[support-access] %' AND NOT revoked`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const readCfg = (who: Actor) => who.api.call('get', '/settings/support-access');
const putCfg = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/support-access', body, tag === undefined ? {} : { 'If-Match': tag });
const cfg = async (): Promise<any> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'security.support_access'`))[0]?.value;
const enable = async (max = 72, def = 24) => {
  const r = await putCfg(admin, { enabled: true, max_hours: max, default_hours: def, reason: REASON }, etag(await readCfg(admin)));
  expect(r.status).toBe(200);
};
const disable = async () => {
  const r = await putCfg(admin, { enabled: false, max_hours: 72, default_hours: 24, reason: REASON }, etag(await readCfg(admin)));
  expect([200, 409]).toContain(r.status);
};
const grantBody = (over: Record<string, unknown> = {}) => ({ to_user_id: support.user.id, rights: ['templates.edit'], hours: 2, reason: REASON, ...over });
const grant = (who: Actor, body: unknown) => who.api.call('post', '/support-access', body);
const audits = (action: string) => q<{ reason: string; actor_id: string; after: any }>(db, `SELECT reason, actor_id::text AS actor_id, after FROM audit_log WHERE action = $1 ORDER BY id`, [action]);

describe('the setting', () => {
  it('is off by default; only a System Admin reads or changes it', async () => {
    expect(await cfg()).toEqual(JSON.parse(CFG_OFF));
    const r = await readCfg(admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, max_hours: 72, default_hours: 24, can_edit: true });
    expect(r.body.modules).toEqual(expect.arrayContaining(['templates', 'fields']));
    expect(r.body.modules).not.toContain('users');
    for (const who of [plain, settingsDelegate]) {
      expect((await readCfg(who)).status).toBe(403);
      const w = await putCfg(who, { enabled: true, max_hours: 72, default_hours: 24, reason: REASON }, etag(r));
      expect(w.status).toBe(403);
      expect((await who.api.call('get', '/support-access')).status).toBe(403);
    }
    expect(await cfg()).toEqual(JSON.parse(CFG_OFF));
  });

  it('checks the body, If-Match and the step-up; saves with before and after in the audit log', async () => {
    const tag = etag(await readCfg(admin));
    const body = { enabled: true, max_hours: 48, default_hours: 12, reason: REASON };
    expect((await putCfg(admin, body)).status).toBe(428);
    expect((await putCfg(admin, body, '"1"')).status).toBe(412);
    const noStepUp = await putCfg(noStep, body, tag);
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    for (const bad of [{ ...body, enabled: 'yes' }, { ...body, max_hours: 0 }, { ...body, max_hours: 169 }, { ...body, default_hours: 49 }, { ...body, reason: 'ab' }, { ...body, extra: 1 }]) {
      expect((await putCfg(admin, bad, tag)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(await cfg()).toEqual(JSON.parse(CFG_OFF));
    const ok = await putCfg(admin, body, tag);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, max_hours: 48, default_hours: 12 });
    const a = (await audits('support_access_update')).at(-1)!;
    expect(a).toMatchObject({ actor_id: admin.user.id, reason: REASON, after: { enabled: true, max_hours: 48, default_hours: 12 } });
    const same = await putCfg(admin, body, etag(ok));
    expect(same.status).toBe(409);
    await disable();
    expect(await cfg()).toEqual(JSON.parse(CFG_OFF));
  });
});

describe('granting', () => {
  it('is refused while the switch is off, and nothing is created', async () => {
    const before = await q<{ n: string }>(db, `SELECT count(*) AS n FROM delegations WHERE reason LIKE '[support-access] %'`);
    const r = await grant(admin, grantBody());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('invalid_transition');
    expect(await q<{ n: string }>(db, `SELECT count(*) AS n FROM delegations WHERE reason LIKE '[support-access] %'`)).toEqual(before);
  });

  it('only a System Admin grants; step-up and a reason are required', async () => {
    await enable();
    try {
      for (const who of [plain, settingsDelegate]) expect((await grant(who, grantBody())).status).toBe(403);
      const ns = await grant(noStep, grantBody());
      expect(ns.status).toBe(401);
      expect(ns.body.code).toBe('step_up_required');
      expect((await grant(admin, grantBody({ reason: 'x' }))).status).toBe(422);
    } finally { await disable(); }
  });

  it('creates a time-limited delegation: the rights asked for, an expiry, no re-delegation, audited; the default hours apply when omitted', async () => {
    await enable(72, 24);
    try {
      const r = await grant(admin, grantBody({ rights: ['templates.edit', 'fields.edit'], hours: 3 }));
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ state: 'active', scope: 'partial', allow_redelegate: false, to_user: { id: support.user.id }, from_user: { id: admin.user.id } });
      expect(r.body.rights.sort()).toEqual(['fields.edit', 'templates.edit']);
      expect(r.body.reason).toBe(`[support-access] ${REASON}`);
      const span = new Date(r.body.valid_to).getTime() - new Date(r.body.valid_from).getTime();
      expect(Math.abs(span - 3 * 3_600_000)).toBeLessThan(5_000);
      expect((await audits('delegation_created')).some((a) => a.reason === `[support-access] ${REASON}` && a.actor_id === admin.user.id)).toBe(true);
      const dflt = await grant(admin, { to_user_id: support.user.id, rights: ['documents.edit'], reason: REASON });
      expect(dflt.status).toBe(201);
      expect(Math.abs(new Date(dflt.body.valid_to).getTime() - new Date(dflt.body.valid_from).getTime() - 24 * 3_600_000)).toBeLessThan(5_000);
    } finally { await disable(); }
  });

  it('refuses rights outside the allowlist, hours above the maximum, yourself, an unknown user and a body with extras', async () => {
    await enable(10, 5);
    try {
      for (const rights of [['users.edit'], ['roles.edit'], ['users.two_factor'], ['settings.edit'], ['reassign'], ['templates.edit', 'users.edit'], []]) {
        expect((await grant(admin, grantBody({ rights }))).status, JSON.stringify(rights)).toBe(422);
      }
      expect((await grant(admin, grantBody({ hours: 11 }))).status).toBe(422);
      expect((await grant(admin, grantBody({ hours: 0 }))).status).toBe(422);
      expect((await grant(admin, grantBody({ to_user_id: admin.user.id }))).status).toBe(422);
      expect((await grant(admin, grantBody({ to_user_id: '11111111-1111-4111-8111-111111111111' }))).status).toBe(422);
      expect((await grant(admin, grantBody({ is_full: true }))).status).toBe(422);
      expect((await grant(admin, grantBody({ hours: 10 }))).status).toBe(201);
    } finally { await disable(); }
  });

  it('the database doors are definer functions owned by the definer role; the internal config reader is not callable by the application role', async () => {
    const rows = await q<{ proname: string; secdef: boolean; owner: string }>(db,
      `SELECT p.proname, p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.proname LIKE 'support_access_%' OR p.proname = 'admin_set_support_access'`);
    expect(rows.map((r) => r.proname).sort()).toEqual(['admin_set_support_access', 'support_access_cfg', 'support_access_check_grant', 'support_access_check_revoke', 'support_access_modules', 'support_access_state']);
    for (const r of rows) {
      if (r.proname !== 'support_access_modules') expect(r.secdef, r.proname).toBe(true);
      expect(r.owner, r.proname).toBe('pmis_definer');
    }
    const cfgOk = await q<{ ok: boolean }>(db, `SELECT has_function_privilege('pmis_app', 'support_access_cfg()', 'EXECUTE') AS ok`);
    expect(cfgOk[0]?.ok).toBe(false);
    const grantOk = await q<{ ok: boolean }>(db, `SELECT has_function_privilege('public', 'support_access_check_grant(uuid,jsonb,integer)', 'EXECUTE') AS ok`);
    expect(grantOk[0]?.ok).toBe(false);
  });
});

describe('listing and revoking', () => {
  it('lists support grants with their state; an expired one reads as expired; revoke ends one, revoke-all ends the rest; a normal delegation is untouched', async () => {
    await enable();
    try {
      const a = (await grant(admin, grantBody({ hours: 1 }))).body;
      const b = (await grant(admin, grantBody({ rights: ['fields.edit'], hours: 1 }))).body;
      const c = (await grant(admin, grantBody({ rights: ['documents.edit'], hours: 1 }))).body;
      const normal = (await admin.api.call('post', '/delegations', { to_user_id: support.user.id, scope: 'partial', rights: ['templates.edit'], valid_from: new Date().toISOString(), valid_to: new Date(Date.now() + 3_600_000).toISOString(), reason: 'normal delegation' })).body;
      expect(normal.id).toBeTruthy();
      const list = await admin.api.call('get', '/support-access');
      expect(list.status).toBe(200);
      const ids = list.body.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
      expect(ids).not.toContain(normal.id);
      // expiry is automatic: move valid_to into the past and the state reads expired
      await db.query(`UPDATE delegations SET valid_from = now() - interval '2 hours', valid_to = now() - interval '1 minute' WHERE id = $1`, [c.id]);
      const after = await admin.api.call('get', '/support-access');
      expect(after.body.items.find((i: { id: string }) => i.id === c.id).state).toBe('expired');
      // revoke one: reason and step-up needed, a normal delegation is refused by this door
      expect((await admin.api.call('post', `/support-access/${a.id}/revoke`, { reason: 'x' })).status).toBe(422);
      expect((await noStep.api.call('post', `/support-access/${a.id}/revoke`, { reason: REASON })).status).toBe(401);
      expect((await plain.api.call('post', `/support-access/${a.id}/revoke`, { reason: REASON })).status).toBe(403);
      expect((await admin.api.call('post', `/support-access/${normal.id}/revoke`, { reason: REASON })).status).toBe(404);
      const rv = await admin.api.call('post', `/support-access/${a.id}/revoke`, { reason: REASON });
      expect(rv.status).toBe(200);
      expect(rv.body.state).toBe('revoked');
      expect((await admin.api.call('post', `/support-access/${a.id}/revoke`, { reason: REASON })).status).toBe(409);
      expect((await audits('delegation_revoked')).some((x) => x.reason === `[support-access] ${REASON}`)).toBe(true);
      // revoke-all: the one still in force, not the expired, not the normal delegation
      const all = await admin.api.call('post', '/support-access/revoke-all', { reason: REASON });
      expect(all.status).toBe(200);
      expect(all.body.revoked).toBeGreaterThanOrEqual(1);
      const final = await admin.api.call('get', '/support-access');
      expect(final.body.items.find((i: { id: string }) => i.id === b.id).state).toBe('revoked');
      const n = await q<{ revoked: boolean }>(db, `SELECT revoked FROM delegations WHERE id = $1`, [normal.id]);
      expect(n[0]?.revoked).toBe(false);
      expect((await plain.api.call('post', '/support-access/revoke-all', { reason: REASON })).status).toBe(403);
    } finally { await disable(); }
  });
});
