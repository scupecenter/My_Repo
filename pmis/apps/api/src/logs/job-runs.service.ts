import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hostname } from 'node:os';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, Tx } from '../db/db.service';
import { applyContext, jobContext } from './context';

export const ALERT_EVERY_MS = 5 * 60_000;
/** 0240: the backup check runs every 6 hours (it raises at most one alert a calendar day). */
export const BACKUP_CHECK_EVERY_MS = 6 * 60 * 60_000;
export const PURGE_EVERY_MS = 24 * 3600_000;

/**
 * The job run log (migration 0045, `GET /admin/job-runs`) and the two log jobs: the security alert rules (every 5 minutes) and the retention purge of
 * the System Log and the security log (daily). Both run only when JOBS_ENABLED is on; the tests call them directly. Recording never throws.
 */
@Injectable()
export class JobRunsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('JobRuns');
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly db: DbService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    const a = setInterval(() => void this.evaluateAlerts(), ALERT_EVERY_MS);
    const p = setInterval(() => void this.purge(), PURGE_EVERY_MS);
    const w = setInterval(() => void this.expireHistoricalWaiver(), ALERT_EVERY_MS);
    // 0149 (W7): the automatic lock of the Daily Plan and the reminder of an empty next working day (dp_tick, idempotent)
    const dp = setInterval(() => void this.dailyPlanTick(), ALERT_EVERY_MS);
    // 0240: the backup check (alert `backup_missing`, one alert a day; the dedup key makes every run after the first of the day a no-op)
    const bk = setInterval(() => void this.backupMissingCheck(), BACKUP_CHECK_EVERY_MS);
    bk.unref();
    this.timers.push(bk);
    setTimeout(() => void this.backupMissingCheck(), 120_000).unref();
    dp.unref();
    this.timers.push(dp);
    a.unref();
    p.unref();
    w.unref();
    this.timers.push(a, p, w);
    setTimeout(() => void this.purge(), 60_000).unref();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async start(name: string): Promise<string | null> {
    try {
      const r = await this.db.client.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT job_run_start(${name}::text, ${hostname().slice(0, 100)}::text)::text AS id`);
      return r[0]?.id ?? null;
    } catch (e) {
      this.log.warn(`job run start failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
      return null;
    }
  }

  async finish(id: string | null, outcome: 'ok' | 'failed' | 'skipped', rows: number | null, error: string | null, detail: Record<string, unknown> | null = null): Promise<void> {
    if (!id) return;
    try {
      await this.db.client.$executeRaw(Prisma.sql`SELECT job_run_finish(${id}::uuid, ${outcome}::text, ${rows}::bigint, ${error}::text, ${detail ? JSON.stringify(detail) : null}::jsonb)`);
    } catch (e) {
      this.log.warn(`job run finish failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
    }
  }

  /** Marks the job's transaction: its audit rows carry via = job and the job name. */
  async context(tx: Tx, name: string): Promise<void> {
    await applyContext(tx, jobContext(name));
  }

  /** Runs `fn` as one recorded job in its own transaction. Returns its count, or null when it failed. */
  async run(name: string, fn: (tx: Tx) => Promise<number>): Promise<number | null> {
    const id = await this.start(name);
    try {
      const n = await this.db.client.$transaction(async (tx) => {
        await this.context(tx, name);
        return fn(tx);
      }, { maxWait: 10_000, timeout: 300_000 });
      await this.finish(id, 'ok', n, null);
      return n;
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      await this.finish(id, 'failed', null, msg);
      await this.alertFailure(name, msg);
      return null;
    }
  }

  /** 0421: a failed job raises the security alert `job_failed` (one per job and day; bell and mail to the System Admins by the alert settings). Never throws. */
  private async alertFailure(name: string, msg: string): Promise<void> {
    if (name === 'security_alerts') return; // the alert job itself: its failure is in job_runs and the System Log; raising from it could loop
    try {
      await this.db.client.$executeRaw(Prisma.sql`SELECT job_failed_alert(${name}::text, ${msg}::text)`);
    } catch (e) {
      this.log.warn(`job failure alert failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
    }
  }

  evaluateAlerts(): Promise<number | null> {
    return this.run('security_alerts', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT sec_alerts_evaluate() AS n`)[0]?.n ?? 0));
  }

  /** Q462 (migration 0073): the historical-load waiver closes itself 30 days after it was opened (audited). The effective state never waits for this job. */
  expireHistoricalWaiver(): Promise<number | null> {
    return this.run('historical_waiver_expire', async (tx) => ((await tx.$queryRaw<{ c: boolean }[]>`SELECT hw_waiver_expire() AS c`)[0]?.c ? 1 : 0));
  }

  /** 0149 (W7): dp_tick locks today's Daily Plans after the set time and reminds the L1 holders of an empty next working day (once per region and day). */
  dailyPlanTick(): Promise<number | null> {
    return this.run('daily_plan', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT dp_tick() AS n`)[0]?.n ?? 0));
  }

  /** 0240: raises the security alert `backup_missing` when no backup succeeded in the last 24 hours (once a calendar day). */
  backupMissingCheck(): Promise<number | null> {
    return this.run('backup_check', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT backup_missing_check() AS n`)[0]?.n ?? 0));
  }

  purge(): Promise<number | null> {
    return this.run('log_purge', async (tx) => {
      // migration 0055: the mail outbox (sent, given up, logged and suppressed mails older than mail.retention_days) goes with the logs
      const r = await tx.$queryRaw<{ a: bigint; b: bigint; c: bigint }[]>`SELECT log_purge_system_log() AS a, log_purge_security_log() AS b, mail_purge() AS c`;
      return Number(r[0]?.a ?? 0) + Number(r[0]?.b ?? 0) + Number(r[0]?.c ?? 0);
    });
  }
}
