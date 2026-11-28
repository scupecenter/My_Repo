import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/** Contract 0.15.648 (migration 0772, automation item 9): the link fill rules in Settings. Seeded empty; the test rule is hidden and removed at the end. */
type J = Record<string, any>;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let mine: J;
beforeAll(async () => {
  app = await startApp(); db = await superDb(); admin = await plainAdmin(app, db);
  // a declared link whose two registers share a non-derived field of one type: that pair is the test rule, whatever the seed holds
  const pick = await db.query(`SELECT l.register_key, l.field_code AS link_field, s.code AS source_field, t.code AS target_field
      FROM register_links l JOIN register_fields s ON s.register_key = l.register_key AND NOT s.derived
      JOIN register_fields t ON t.register_key = l.target_register AND NOT t.derived AND t.field_type = s.field_type
     WHERE l.is_active ORDER BY l.sort_order, s.code, t.code LIMIT 1`);
  mine = pick.rows[0];
});
afterAll(async () => {
  if (mine) await db.query(`DELETE FROM register_link_fills WHERE register_key = $1 AND link_field = $2 AND target_field = $3`, [mine.register_key, mine.link_field, mine.target_field]);
  await db.end();
});

const read = async () => (await admin.api.call('get', '/settings/link-fills')).body as J;

describe('link fill rules', () => {
  it('is seeded empty and lists the declared links with their fields', async () => {
    const r = await read();
    expect(typeof r.version).toBe('number');
    expect((r.links as J[]).length).toBeGreaterThan(0);
    expect((r.links as J[])[0]!.source_fields.length).toBeGreaterThan(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM register_link_fills WHERE register_key = $1 AND link_field = $2 AND target_field = $3`, [mine.register_key, mine.link_field, mine.target_field])).rows[0].n).toBe(0);
  });

  it('adds a rule with a reason, audits it, hides it, and never deletes', async () => {
    const before = await read();
    const put = await admin.api.call('put', '/settings/link-fills', { reason: 'Test fill 0772', rows: [mine] }).set('If-Match', `"${before.version}"`);
    expect(put.status).toBe(200);
    expect((put.body.rows as J[]).some((x) => x.link_field === mine.link_field && x.target_field === mine.target_field && x.is_active)).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'register_link_fills_update'`)).rows[0].n).toBeGreaterThan(0);
    const hide = await admin.api.call('put', '/settings/link-fills', { reason: 'Hide the test fill', rows: [{ ...mine, is_active: false }] });
    expect(hide.status).toBe(200);
    expect((hide.body.rows as J[]).find((x) => x.link_field === mine.link_field && x.target_field === mine.target_field)!.is_active).toBe(false);
  });

  it('refuses a stale version, a missing reason, an undeclared link, an unknown field and a duplicate', async () => {
    const r = await read();
    const bad = async (row: J, reason = 'Check refusal') => admin.api.call('put', '/settings/link-fills', { reason, rows: [row] });
    expect((await admin.api.call('put', '/settings/link-fills', { reason: 'Stale', rows: [] }).set('If-Match', `"${Number(r.version) + 50}"`)).status).toBe(412);
    expect((await bad(mine, '')).status).toBe(422);
    expect((await bad({ ...mine, link_field: 'no_such_link' })).status).toBe(422);
    expect((await bad({ ...mine, source_field: 'no_such_field' })).status).toBe(422);
    expect((await bad({ ...mine, target_field: 'no_such_field' })).status).toBe(422);
    expect((await admin.api.call('put', '/settings/link-fills', { reason: 'Dup', rows: [mine, mine] })).status).toBe(422);
  });

  it('a user without the Settings right cannot save', async () => {
    const eng: Actor = await actor(app, db);
    expect((await eng.api.call('put', '/settings/link-fills', { reason: 'No right', rows: [] })).status).toBe(403);
  });
});
