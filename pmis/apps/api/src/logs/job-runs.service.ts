import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hostname } from 'node:os';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, Tx } from '../db/db.service';
import { applyContext, jobContext } from './context';

export const ALERT_EVERY_MS = 5 * 60_000;
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
      return null;
    }
  }

  evaluateAlerts(): Promise<number | null> {
    return this.run('security_alerts', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT sec_alerts_evaluate() AS n`)[0]?.n ?? 0));
  }

  /** Q462 (migration 0073): the historical-load waiver closes itself 30 days after it was opened (audited). The effective state never waits for this job. */
  expireHistoricalWaiver(): Promise<number | null> {
    return this.run('historical_waiver_expire', async (tx) => ((await tx.$queryRaw<{ c: boolean }[]>`SELECT hw_waiver_expire() AS c`)[0]?.c ? 1 : 0));
  }

  purge(): Promise<number | null> {
    return this.run('log_purge', async (tx) => {
      // migration 0055: the mail outbox (sent, given up, logged and suppressed mails older than mail.retention_days) goes with the logs
      const r = await tx.$queryRaw<{ a: bigint; b: bigint; c: bigint }[]>`SELECT log_purge_system_log() AS a, log_purge_security_log() AS b, mail_purge() AS c`;
      return Number(r[0]?.a ?? 0) + Number(r[0]?.b ?? 0) + Number(r[0]?.c ?? 0);
    });
  }
}
