import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/** Migration 0184: the alert `backup_missing` (no successful backup in the last 24 hours). The System Log is shared with other suites, so the checks follow the state they read. */
let db: PgClient;
beforeAll(async () => { db = await superDb(); });
afterAll(async () => { await db.end(); });

const recent = async (): Promise<boolean> => (await db.query(
  `SELECT EXISTS (SELECT 1 FROM system_log l WHERE l.source = 'backup' AND l.level = 'info' AND l.context ->> 'script' = 'db-backup' AND l.context ->> 'event' = 'backup_ok'
     AND l.context ->> 'type' IN ('full', 'diff') AND l.at > clock_timestamp() - interval '24 hours') AS r`)).rows[0].r as boolean;
const today = async (): Promise<string> => (await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`)).rows[0].d as string;
const alerts = async (): Promise<number> => (await db.query(`SELECT count(*)::int AS n FROM security_alerts WHERE rule = 'backup_missing' AND dedup_key = $1`, [`backup_missing:${await today()}`])).rows[0].n as number;

describe('backup_missing_check()', () => {
  it('has a default severity of high and the rule is accepted by the table', async () => {
    const r = await db.query(`SELECT sec_rule_default_severities() ->> 'backup_missing' AS s`);
    expect(r.rows[0].s).toBe('high');
  });

  it('raises at most one alert a day while the last success is older than 24 hours, and none when a backup is recent', async () => {
    const had = await recent();
    const first = (await db.query(`SELECT backup_missing_check() AS n`)).rows[0].n as number;
    if (had) {
      expect(first).toBe(0);
    } else {
      expect(first === 1 || (await alerts()) === 1).toBe(true);
      expect((await db.query(`SELECT backup_missing_check() AS n`)).rows[0].n).toBe(0);
      expect(await alerts()).toBe(1);
      const row = (await db.query(`SELECT severity, title FROM security_alerts WHERE rule = 'backup_missing' AND dedup_key = $1`, [`backup_missing:${await today()}`])).rows[0];
      expect(row.title).toMatch(/backup/i);
      expect(['high', 'critical', 'medium', 'low', 'info']).toContain(row.severity);
    }
    await db.query(`INSERT INTO system_log (at, level, source, message, context) VALUES (now(), 'info', 'backup', 'Database backup completed',
      '{"script":"db-backup","event":"backup_ok","mode":"full","type":"full","repos":"1","stanza":"gsdn-pmis"}'::jsonb)`);
    expect((await db.query(`SELECT backup_missing_check() AS n`)).rows[0].n).toBe(0);
  });
});
