import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/jobs/jobs.service';
import { IntegrityService } from '../src/logs/integrity.service';
import { adminApi, makeUser, startApp } from './helpers';
import type { Api } from './helpers';

/**
 * Follow-up B of the technical decisions of 2026-11-04 (migration 0067): Q245 (the calendar confirmation resets every new year), Q253 (mail kept 30 days) and
 * Q257 (every finished integrity check mails its head hash to the System Admins). Runs on its own database (TEST_DATABASE_URL_FB): it runs the daily job and
 * the integrity check and counts the mails it queues. Dates are built from the real current year in the project time zone, so nothing depends on the day.
 */
let app: NestExpressApplication;
let db: PgClient;
let api: Api;
const anchorDir = mkdtempSync(join(tmpdir(), 'pmis-fb-anchor-'));

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_FB as string, anchorDir });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_FB });
  await db.connect();
  api = (await adminApi(app, db)).api;
});
afterAll(async () => {
  await app.get(IntegrityService).idle();
  await db.end();
  await app.close();
});

const year = async (): Promise<number> => Number((await db.query(`SELECT extract(year FROM cal_today())::int AS y`)).rows[0].y);
const confirmedAt = (iso: string | null): Promise<unknown> =>
  db.query(`UPDATE settings SET value = 'true'::jsonb, updated_at = coalesce($1::timestamptz, now()), updated_by = NULL WHERE key = 'calendar.official_confirmed'`, [iso]);
const confirmed = async (): Promise<boolean> => (await db.query(`SELECT value FROM settings WHERE key = 'calendar.official_confirmed'`)).rows[0].value === true;
const resetRuns = async (): Promise<Record<string, any>[]> => (await db.query(`SELECT * FROM job_runs WHERE name = 'calendar_year_reset' ORDER BY started_at`)).rows;
const banner = async (): Promise<boolean> => (await api.call('get', '/settings/holidays')).body.summary.official_calendar_pending;

describe('Q245: calendar.official_confirmed resets when the year changes', () => {
  it('a confirmation made in an earlier year is reset by the daily job: job_runs row, audit row (via job), and the banner returns', async () => {
    const y = await year();
    await confirmedAt(`${y - 1}-12-20T10:00:00Z`);
    expect(await confirmed()).toBe(true);
    expect(await banner()).toBe(false);                                   // confirmed: no banner
    const before = (await resetRuns()).length;
    const run = await app.get(JobsService).runOnce();
    expect(run).not.toBeNull();
    expect(run!.calendarReset).toBe(1);
    expect(await confirmed()).toBe(false);
    expect(await banner()).toBe(true);                                    // the "calendar not confirmed" banner is back
    const runs = await resetRuns();
    expect(runs.length).toBe(before + 1);
    expect(runs[runs.length - 1]).toMatchObject({ outcome: 'ok', rows: '1' });
    const a = (await db.query(`SELECT * FROM audit_log WHERE action = 'calendar_official_confirmed_reset' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(a).toMatchObject({ entity_type: 'setting', entity_id: 'calendar.official_confirmed', actor_id: null, via: 'job', job_name: 'calendar_year_reset' });
    expect(a.before).toMatchObject({ value: true });
    expect(a.after).toMatchObject({ value: false, reset_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(a.reason).toMatch(/new year/i);
    // the daily job's own row carries the count
    const daily = (await db.query(`SELECT detail FROM job_runs WHERE name = 'daily' ORDER BY started_at DESC LIMIT 1`)).rows[0];
    expect(daily.detail).toMatchObject({ calendar_reset: 1 });
  });

  it('a second run the same day changes nothing, and writes a job_runs row with 0 rows and no audit row', async () => {
    const audits = async (): Promise<number> => Number((await db.query(`SELECT count(*) AS n FROM audit_log WHERE action = 'calendar_official_confirmed_reset'`)).rows[0].n);
    const n0 = await audits();
    const before = (await resetRuns()).length;
    const run = await app.get(JobsService).runOnce();
    expect(run!.calendarReset).toBeUndefined();
    expect(await audits()).toBe(n0);
    const runs = await resetRuns();
    expect(runs.length).toBe(before + 1);
    expect(runs[runs.length - 1]).toMatchObject({ outcome: 'ok', rows: '0' });
  });

  it('a confirmation made in the current year stays, also one made just after midnight of 1 January in Tripoli (22:30 UTC of the day before)', async () => {
    const y = await year();
    await confirmedAt(null);
    await app.get(JobsService).runOnce();
    expect(await confirmed()).toBe(true);
    await db.query(`UPDATE settings SET updated_at = make_timestamptz($1, 1, 1, 0, 30, 0, 'Africa/Tripoli') WHERE key = 'calendar.official_confirmed'`, [y]);
    await app.get(JobsService).runOnce();
    expect(await confirmed()).toBe(true);
  });

  it('a confirmation made at 23:30 on 31 December in Tripoli belongs to the old year and is reset (a missed night is caught up)', async () => {
    const y = await year();
    await db.query(`UPDATE settings SET value = 'true'::jsonb, updated_at = make_timestamptz($1, 12, 31, 23, 30, 0, 'Africa/Tripoli') WHERE key = 'calendar.official_confirmed'`, [y - 1]);
    expect((await app.get(JobsService).runOnce())!.calendarReset).toBe(1);
    expect(await confirmed()).toBe(false);
  });

  it('is refused for a signed-in person: the function is the daily job\'s only', async () => {
    const u = await makeUser(db, { assigned: true });
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
      await expect(db.query(`SELECT cal_official_confirmed_reset()`)).rejects.toThrow(/daily job only/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

describe('Q253: mail bodies are kept 30 days', () => {
  const migrationSql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '0067_followup_operations', 'migration.sql'), 'utf8');
  /** The data step of the migration (the first DO block), run again on the current setting. */
  const block = (): string => /DO \$\$\nDECLARE n integer;[\s\S]*?\nEND \$\$;/.exec(migrationSql)![0];
  const setting = async (): Promise<{ value: unknown; updated_by: string | null }> =>
    (await db.query(`SELECT value, updated_by FROM settings WHERE key = 'mail.retention_days'`)).rows[0];

  it('the default of a new database is 30', async () => {
    expect((await setting()).value).toBe(30);
  });

  it('only the old default 90 that nobody saved is changed; a value a person set is kept, also 90', async () => {
    const admin = (await db.query(`SELECT id FROM users LIMIT 1`)).rows[0].id as string;
    await db.query(`UPDATE settings SET value = '90'::jsonb, updated_by = NULL WHERE key = 'mail.retention_days'`);
    await db.query(block());
    expect((await setting()).value).toBe(30);
    await db.query(`UPDATE settings SET value = '45'::jsonb, updated_by = NULL WHERE key = 'mail.retention_days'`);
    await db.query(block());
    expect((await setting()).value).toBe(45);
    await db.query(`UPDATE settings SET value = '90'::jsonb, updated_by = $1 WHERE key = 'mail.retention_days'`, [admin]);
    await db.query(block());
    expect((await setting()).value).toBe(90);
    await db.query(`UPDATE settings SET value = '30'::jsonb, updated_by = NULL WHERE key = 'mail.retention_days'`);
  });

  it('the purge keeps 30 days when the setting is missing, and the setting when present', async () => {
    const mail = async (age: number): Promise<string> =>
      (await db.query(
        `INSERT INTO mail_outbox (kind, to_address, subject, body_text, status, created_at, sent_at) VALUES ('mail.test', 'purge.test@example.test', 'purge test', 'x', 'sent',
           now() - make_interval(days => $1), now()) RETURNING id`, [age])).rows[0].id;
    const exists = async (id: string): Promise<boolean> => (await db.query(`SELECT 1 FROM mail_outbox WHERE id = $1`, [id])).rowCount === 1;
    const saved = (await db.query(`SELECT value, description, updated_by, updated_at FROM settings WHERE key = 'mail.retention_days'`)).rows[0];
    await db.query(`DELETE FROM settings WHERE key = 'mail.retention_days'`);
    try {
      const old31 = await mail(31);
      const new29 = await mail(29);
      await db.query('SELECT mail_purge()');
      expect(await exists(old31)).toBe(false);
      expect(await exists(new29)).toBe(true);
      await db.query(`INSERT INTO settings (key, value, description, updated_at) VALUES ('mail.retention_days', '60'::jsonb, 'test', now())`);
      const old40 = await mail(40);
      const old70 = await mail(70);
      await db.query('SELECT mail_purge()');
      expect(await exists(old40)).toBe(true);
      expect(await exists(old70)).toBe(false);
      await db.query(`DELETE FROM mail_outbox WHERE to_address = 'purge.test@example.test'`).catch(() => undefined);
    } finally {
      await db.query(`DELETE FROM settings WHERE key = 'mail.retention_days'`);
      await db.query(`INSERT INTO settings (key, value, description, updated_by, updated_at) VALUES ('mail.retention_days', $1::jsonb, $2, $3, $4)`,
        [JSON.stringify(saved.value), saved.description, saved.updated_by, saved.updated_at]);
    }
  });
});

describe('Q257: every finished integrity check mails the chain head to the System Admins', () => {
  const adminAddresses = async (): Promise<string[]> =>
    (await db.query(`SELECT DISTINCT lower(u.email) AS e FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
       JOIN users u ON u.id = gm.user_id AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY 1`)).rows.map((r) => r.e as string);
  const headMails = async (runId: string): Promise<Record<string, any>[]> =>
    (await db.query(`SELECT * FROM mail_outbox WHERE kind = 'integrity_head' AND source ->> 'run_id' = $1 ORDER BY to_address`, [runId])).rows;

  it('the nightly check of both chains mails each head hash to every System Admin as a mandatory mail', async () => {
    const admins = await adminAddresses();
    expect(admins.length).toBeGreaterThanOrEqual(2);
    const runs = await app.get(IntegrityService).nightly();
    expect(runs.map((r) => [r.log, r.status])).toEqual([['audit', 'ok'], ['security', 'ok']]);
    for (const r of runs) {
      const mails = await headMails(r.id);
      expect(mails.map((m) => m.to_address)).toEqual(admins);
      for (const m of mails) {
        expect(m.source).toMatchObject({ mandatory: true, log: r.log, status: 'ok', run_id: r.id });
        expect(m.status).not.toBe('suppressed');
        expect(m.body_text).toContain(r.head_hash);                        // the full head hash
        expect(m.body_text).toContain(`Log: ${r.log}`);
        expect(m.body_text).toContain(`${r.from_seq} to ${r.to_seq}`);
        expect(m.subject).toContain(r.head_hash!.slice(0, 12));
        expect(m.sensitive).toBe(false);
      }
      // the same hash is the last line of the anchor file kept off the database
      const lines = readFileSync(join(anchorDir, `anchor-${r.log}.jsonl`), 'utf8').trim().split('\n');
      expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ hash: r.head_hash });
    }
  });

  it('is mandatory: the hourly cap of an address never suppresses it', async () => {
    await db.query(`UPDATE settings SET value = '1'::jsonb WHERE key = 'mail.cap_per_recipient_per_hour'`);
    try {
      const runs = await app.get(IntegrityService).nightly();
      for (const r of runs) {
        const mails = await headMails(r.id);
        expect(mails.length).toBeGreaterThanOrEqual(2);
        expect(mails.every((m) => m.status !== 'suppressed')).toBe(true);
      }
    } finally {
      await db.query(`UPDATE settings SET value = '30'::jsonb WHERE key = 'mail.cap_per_recipient_per_hour'`);
    }
  });

  it('a manual check started by a System Admin mails the head too, once per run', async () => {
    const start = await api.call('post', '/admin/log-integrity/runs', { log: 'audit' });
    expect(start.status).toBe(202);
    await app.get(IntegrityService).idle();
    const run = (await api.call('get', `/admin/log-integrity/runs/${start.body.id}`)).body;
    expect(run.status).toBe('ok');
    const mails = await headMails(run.id);
    expect(mails.length).toBe((await adminAddresses()).length);
    expect(mails[0]!.body_text).toContain(run.head_hash);
    // finishing again (the run is already finished) queues nothing more
    await db.query(`SELECT * FROM log_integrity_finish($1, NULL)`, [run.id]).catch(() => undefined);
    expect((await headMails(run.id)).length).toBe(mails.length);
  });

  it('a broken check is mailed as well, with its result', async () => {
    const runs = await app.get(IntegrityService).nightly();
    const audit = runs.find((r) => r.log === 'audit')!;
    // an anchor that does not match the chain makes the next check broken
    const f = join(anchorDir, 'anchor-audit.jsonl');
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f, `${lines.slice(0, -1).concat(JSON.stringify({ ...last, hash: 'f'.repeat(64) })).join('\n')}\n`);
    try {
      const again = await app.get(IntegrityService).nightly();
      const broken = again.find((r) => r.log === 'audit')!;
      expect(broken.status).toBe('broken');
      const mails = await headMails(broken.id);
      expect(mails.length).toBeGreaterThanOrEqual(2);
      expect(mails[0]!.source).toMatchObject({ status: 'broken' });
      expect(mails[0]!.subject).toContain('broken');
    } finally {
      writeFileSync(f, `${lines.join('\n')}\n`);
    }
    expect(audit.status).toBe('ok');
  });
});
