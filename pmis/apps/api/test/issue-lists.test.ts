import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { createRec, patch, recPath, team } from './reg-helpers';

/** Migration 0168: the IssueCategory and BlockerReason lists, the three new Issues fields and the automatic issue number. */
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

describe('issue lists and fields (0168)', () => {
  it('the two lists exist with their values, pending, not critical, editable list values', async () => {
    const c = await db.query(`SELECT code, status, critical, allow_other FROM list_catalogues WHERE code IN ('IssueCategory','BlockerReason') ORDER BY code`);
    expect(c.rows).toEqual([
      { code: 'BlockerReason', status: 'pending', critical: false, allow_other: false },
      { code: 'IssueCategory', status: 'pending', critical: false, allow_other: false },
    ]);
    const n = await db.query(`SELECT catalogue_code, count(*)::int AS n FROM list_values WHERE catalogue_code IN ('IssueCategory','BlockerReason') GROUP BY 1 ORDER BY 1`);
    // later migrations add values (0554 daily delay): at least the first ones are there
    expect(n.rows.map((r) => r.catalogue_code)).toEqual(['BlockerReason', 'IssueCategory']);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(11);
    expect(n.rows[1].n).toBeGreaterThanOrEqual(10);
    const u = await db.query(`SELECT 1 FROM list_values WHERE catalogue_code = 'BlockerReason' AND code = 'Uplink Site Not Ready'`);
    expect(u.rowCount).toBe(1);
  });

  it('the Issues register has the new fields, none required, the old ones unchanged', async () => {
    const f = await db.query(`SELECT code, field_type, required, derived, list_catalogue FROM register_fields WHERE register_key = 'issues' AND code IN ('issue_no','issue_category','blocker_reason') ORDER BY code`);
    expect(f.rows).toEqual([
      { code: 'blocker_reason', field_type: 'list_code', required: false, derived: false, list_catalogue: 'BlockerReason' },
      { code: 'issue_category', field_type: 'list_code', required: false, derived: false, list_catalogue: 'IssueCategory' },
      { code: 'issue_no', field_type: 'text', required: false, derived: true, list_catalogue: null },
    ]);
    const old = await db.query(`SELECT required FROM register_fields WHERE register_key = 'issues' AND code = 'pending_issue'`);
    expect(old.rows[0].required).toBe(true);
  });

  it('a new issue gets ISS-nnnn, a new version keeps it, a typed number is refused (read-only)', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const typed = await t.entry.api.call('post', recPath('issues'), { site_id: t.site.id, data: { ...ISSUE, issue_no: 'ISS-9999' } });
    expect(typed.status).toBe(422);
    expect(typed.body.errors[0]).toMatchObject({ path: '/data/issue_no', code: 'field_read_only' });
    const a = await createRec(t, ISSUE);
    expect(a.data.issue_no).toMatch(/^ISS-\d{4,}$/);
    const b = await createRec(t, ISSUE);
    expect(b.data.issue_no).toMatch(/^ISS-\d{4,}$/);
    expect(b.data.issue_no).not.toBe(a.data.issue_no);
    const p = await patch(t.entry.api, 'issues', a.id, a.version, { data: { ...ISSUE, issue_category: 'Fiber', blocker_reason: 'Uplink Site Not Ready' } });
    expect(p.status).toBe(200);
    expect(p.body.data.issue_no).toBe(a.data.issue_no);
    expect(p.body.data.blocker_reason).toBe('Uplink Site Not Ready');
  });
});
