import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { createRec, post, team } from './reg-helpers';

/** Migration 0169: an issue can be owned by a role; the submit rule accepts a person, a role or an external party. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

const ISSUE = { pending_issue: 'x', raised_date: '2026-01-05', issue_status: 'Open' };

describe('issue owner role (0169)', () => {
  it('the list holds the active roles, pending and not critical; the field is optional', async () => {
    const c = await db.query(`SELECT status, critical FROM list_catalogues WHERE code = 'IssueOwnerRole'`);
    expect(c.rows).toEqual([{ status: 'pending', critical: false }]);
    const n = await db.query(`SELECT (SELECT count(*)::int FROM list_values WHERE catalogue_code = 'IssueOwnerRole') AS v, (SELECT count(*)::int FROM roles WHERE is_active) AS r`);
    expect(n.rows[0].v).toBeGreaterThanOrEqual(1);
    expect(n.rows[0].v).toBeLessThanOrEqual(n.rows[0].r);
    const f = await db.query(`SELECT field_type, required, list_catalogue FROM register_fields WHERE register_key = 'issues' AND code = 'owner_role'`);
    expect(f.rows).toEqual([{ field_type: 'list_code', required: false, list_catalogue: 'IssueOwnerRole' }]);
  });

  it('submit: no owner is still refused, a role alone is enough', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const none = await createRec(t, ISSUE);
    const refused = await post(t.entry.api, 'issues', none.id, 'submit', none.version);
    expect(refused.body.errors[0]).toMatchObject({ path: '/data/owner_user', code: 'required' });
    const code = (await db.query(`SELECT code FROM list_values WHERE catalogue_code = 'IssueOwnerRole' ORDER BY sort_order LIMIT 1`)).rows[0].code as string;
    const role = await createRec(t, { ...ISSUE, owner_role: code });
    const ok = await post(t.entry.api, 'issues', role.id, 'submit', role.version);
    expect(ok.status).toBe(200);
  });
});
