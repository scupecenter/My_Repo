import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/** Migration 0421: the alerts `backup_late` and `job_failed` (production readiness, item 4). */
let db: PgClient;
beforeAll(async () => { db = await superDb(); });
afterAll(async () => { await db.end(); });

const TAG = `t${Date.now().toString(36)}`;

describe('ops alerts', () => {
  it('knows both rules, with their default severities, and keeps the older ones', async () => {
    const r = (await db.query(`SELECT sec_rule_default_severities() AS s`)).rows[0].s as Record<string, string>;
    expect(r.backup_late).toBe('high');
    expect(r.job_failed).toBe('medium');
    expect(r.backup_missing).toBe('high');
    expect(r.break_glass_used).toBe('critical');
    const c = (await db.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'security_alerts'::regclass AND conname = 'security_alerts_rule_check'`)).rows[0].d as string;
    for (const k of ['backup_late', 'job_failed', 'backup_missing', 'malware_upload', 'break_glass_used']) expect(c).toContain(k);
  });

  it('job_failed_alert raises one alert per job and day', async () => {
    const job = `job_${TAG}`;
    expect((await db.query(`SELECT job_failed_alert($1, 'boom') AS r`, [job])).rows[0].r).toBe(true);
    expect((await db.query(`SELECT job_failed_alert($1, 'boom again') AS r`, [job])).rows[0].r).toBe(false);
    const rows = (await db.query(`SELECT severity, title, detail FROM security_alerts WHERE rule = 'job_failed' AND detail ->> 'job' = $1`, [job])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain(job);
    expect(rows[0].detail.error).toBe('boom');
  });

  it('backup_late_alert raises once in the same 6 hour window', async () => {
    const first = (await db.query(`SELECT backup_late_alert($1) AS r`, [`WAL late ${TAG}`])).rows[0].r as boolean;
    const second = (await db.query(`SELECT backup_late_alert($1) AS r`, [`WAL late again ${TAG}`])).rows[0].r as boolean;
    expect(second).toBe(false);
    const n = (await db.query(`SELECT count(*)::int AS n FROM security_alerts WHERE rule = 'backup_late' AND dedup_key LIKE 'backup_late:%'`)).rows[0].n as number;
    expect(n).toBeGreaterThanOrEqual(1);
    if (first) {
      const row = (await db.query(`SELECT title, detail FROM security_alerts WHERE rule = 'backup_late' ORDER BY id DESC LIMIT 1`)).rows[0];
      expect(row.title).toMatch(/backup/i);
    }
  });

  it('the app role may raise job_failed but not backup_late', async () => {
    const r = await db.query(`SELECT has_function_privilege('pmis_app', 'job_failed_alert(text,text)', 'EXECUTE') AS a, has_function_privilege('pmis_app', 'backup_late_alert(text)', 'EXECUTE') AS b`);
    expect(r.rows[0].a).toBe(true);
    expect(r.rows[0].b).toBe(false);
  });
});
