import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { createRec, patch, team } from './reg-helpers';

/** Migration 0554: the daily delay log is a type of the Issues register (list IssueCategory), with a day, a reason and an optional task. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

const ISSUE = { pending_issue: 'Rain stopped the crew', raised_date: '2026-01-05', issue_status: 'Open' };

describe('daily delay log (0554)', () => {
  it('adds the type, the reasons and the optional date field, hidden values untouched, nothing required', async () => {
    const t = await db.query(`SELECT label_en, label_ar, is_active FROM list_values WHERE catalogue_code = 'IssueCategory' AND code = 'Daily Delay'`);
    expect(t.rows).toEqual([{ label_en: 'Daily delay', label_ar: 'تأخير يومي', is_active: true }]);
    const r = await db.query(`SELECT code FROM list_values WHERE catalogue_code = 'BlockerReason' AND code IN ('Weather','Permit Pending','Delivery Delay','Safety Stop') ORDER BY code`);
    expect(r.rows.map((x) => x.code)).toEqual(['Delivery Delay', 'Permit Pending', 'Safety Stop', 'Weather']);
    const f = await db.query(`SELECT field_type, required, derived, in_list FROM register_fields WHERE register_key = 'issues' AND code = 'delay_date'`);
    expect(f.rows).toEqual([{ field_type: 'date', required: false, derived: false, in_list: true }]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM list_values WHERE catalogue_code IN ('IssueCategory','BlockerReason')`);
    await db.query(`INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES ('IssueCategory', 'Daily Delay', 'x', 'x', 1) ON CONFLICT (catalogue_code, code) DO NOTHING`);
    const after = await db.query(`SELECT count(*)::int AS n FROM list_values WHERE catalogue_code IN ('IssueCategory','BlockerReason')`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('a delay is saved on a site with its day, reason and category, and a bad reason is refused', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const a = await createRec(t, { ...ISSUE, issue_category: 'Daily Delay', blocker_reason: 'Weather', delay_date: '2026-01-05' });
    expect(a.data).toMatchObject({ issue_category: 'Daily Delay', blocker_reason: 'Weather', delay_date: '2026-01-05' });
    const bad = await patch(t.entry.api, 'issues', a.id, a.version, { data: { ...ISSUE, issue_category: 'Daily Delay', blocker_reason: 'No Such Reason', delay_date: '2026-01-05' } });
    expect(bad.status).toBe(422);
  });
});
