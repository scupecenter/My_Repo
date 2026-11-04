import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SyslogService } from '../auth/syslog.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { JobRunsService } from '../logs/job-runs.service';

export const JOB_HOUR = 2;
export const JOB_TIME_ZONE = 'Africa/Tripoli';
export const REMINDER_DAYS = 14;

export interface DailyJobResult {
  /** open tasks whose SLA terms changed because a future-dated SLA version took effect */
  slaApplied: number;
  /** tentative-holiday reminders sent to the System Admins */
  reminders: number;
  /** sites stored by the weekly dashboard snapshot of this run (absent when no snapshot was due) */
  snapshots?: number;
  /** P4b (migration 0061): team safety certificate alerts (D145b, information only) and running-order mismatch alerts (Q145) written by this run */
  contractorAlerts?: number;
}

/** The wall-clock parts of an instant in a time zone, and the zone's offset from UTC at that instant (milliseconds). */
function zoneParts(at: Date, tz: string): { y: number; m: number; d: number; offset: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(at)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year as number, (p.month as number) - 1, p.day as number, p.hour as number, p.minute as number, p.second as number);
  return { y: p.year as number, m: p.month as number, d: p.day as number, offset: asUtc - Math.floor(at.getTime() / 1000) * 1000 };
}

/** The next instant, after `now`, at which the wall clock of the zone shows `hour`:00. */
export function nextRunAt(now: Date, tz: string = JOB_TIME_ZONE, hour: number = JOB_HOUR): Date {
  const here = zoneParts(now, tz);
  for (let k = 0; k < 3; k++) {
    const wall = Date.UTC(here.y, here.m - 1, here.d + k, hour, 0, 0);
    let at = wall - here.offset;
    at = wall - zoneParts(new Date(at), tz).offset;         // the offset of that day (a zone with daylight saving time)
    if (at > now.getTime()) return new Date(at);
  }
  return new Date(now.getTime() + 86_400_000);
}

/**
 * The daily job (owner answer Q84): applies the SLA versions whose date has come (sla_apply_due_sets) and sends the 14-day reminder of tentative
 * holidays to the System Admins (cal_tentative_reminders). It runs once at start-up and then every day at 02:00 Africa/Tripoli, only when
 * JOBS_ENABLED is on (default on, off when NODE_ENV=test). It is a plain timer inside the API process: the stack names BullMQ with Redis, which is
 * not installed on the server yet; the two database functions are idempotent, so a later move to BullMQ changes only who calls them.
 * The dashboard snapshots (dash_snapshot_weekly, migration 0046, Q127) are taken by the same run: the weekly one on Thursday (setting dashboard.snapshot_weekday, 4 since 0059, D186)
 * and the month-end one on the last day of the month, each date once, with a catch-up of a due date missed in the last dashboard.snapshot_catchup_days (7);
 * a failure there is logged and does not stop the rest.
 * Safe to repeat: a second run the same day finds nothing to apply and nobody left to remind. An advisory lock keeps two API processes from running it together.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<DailyJobResult | null> | undefined;
  private stopped = false;
  /** The outcome of the last run (also when it did nothing); null until the first run ends. */
  lastRun: { at: Date; result: DailyJobResult | null; error?: string } | null = null;
  nextRun: Date | null = null;

  constructor(
    private readonly db: DbService,
    private readonly syslog: SyslogService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly runs: JobRunsService,
  ) {}

  get enabled(): boolean {
    return this.config.jobsEnabled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobsEnabled) return;
    await this.scheduleNext();
    void this.runOnce();                                    // once at start-up; never blocks the listen
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inflight) await this.inflight.catch(() => undefined);
  }

  /** Runs the job now. Never throws; returns null when another process holds the lock or the run failed. */
  runOnce(): Promise<DailyJobResult | null> {
    if (this.inflight) return this.inflight;
    const p = this.execute().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = p;
    return p;
  }

  private async execute(): Promise<DailyJobResult | null> {
    // migration 0045: every run is a job_runs row, and its audit rows say via = job, job_name = daily
    const run = await this.runs.start('daily');
    try {
      const result: DailyJobResult | null = await this.db.client.$transaction(async (tx): Promise<DailyJobResult | null> => {
        const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pmis.daily_job')) AS ok`;
        if (!lock[0]?.ok) return null;
        await this.runs.context(tx, 'daily');
        const applied = await tx.$queryRaw<{ n: number }[]>`SELECT sla_apply_due_sets() AS n`;
        const reminded = await tx.$queryRaw<{ n: number }[]>`SELECT cal_tentative_reminders(${REMINDER_DAYS}::integer) AS n`;
        return { slaApplied: Number(applied[0]?.n ?? 0), reminders: Number(reminded[0]?.n ?? 0) };
      }, { maxWait: 10_000, timeout: 60_000 });
      if (result) {
        const snapshots = await this.snapshot();
        if (snapshots > 0) result.snapshots = snapshots;
        const alerts = await this.contractorAlerts();
        if (alerts > 0) result.contractorAlerts = alerts;
      }
      this.lastRun = { at: new Date(), result };
      await this.runs.finish(run, result ? 'ok' : 'skipped', result ? result.slaApplied + result.reminders + (result.snapshots ?? 0) + (result.contractorAlerts ?? 0) : null, null,
        result ? { sla_applied: result.slaApplied, holiday_reminders: result.reminders, dashboard_snapshot_sites: result.snapshots ?? 0, contractor_alerts: result.contractorAlerts ?? 0 } : { reason: 'locked' });
      if (result && (result.slaApplied > 0 || result.reminders > 0 || (result.snapshots ?? 0) > 0)) {
        await this.syslog.write('info', 'daily job ran', { sla_applied: result.slaApplied, holiday_reminders: result.reminders, dashboard_snapshot_sites: result.snapshots ?? 0 });
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      this.lastRun = { at: new Date(), result: null, error: message };
      await this.runs.finish(run, 'failed', null, message);
      this.log.warn(`daily job failed: ${message}`);
      await this.syslog.write('error', 'daily job failed', { error: message });
      return null;
    }
  }

  /** The scheduled dashboard snapshots (migrations 0039, 0046); its own transaction and its own lock, so a failure leaves the other job steps alone. Returns the sites stored. */
  private async snapshot(): Promise<number> {
    try {
      return await this.db.client.$transaction(async (tx) => {
        const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pmis.dashboard_snapshot')) AS ok`;
        if (!lock[0]?.ok) return 0;
        await this.runs.context(tx, 'dashboard_snapshot');
        const r = await tx.$queryRaw<{ n: number }[]>`SELECT dash_snapshot_weekly() AS n`;
        return Number(r[0]?.n ?? 0);
      }, { maxWait: 10_000, timeout: 120_000 });
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      this.log.warn(`dashboard snapshot failed: ${message}`);
      await this.syslog.write('error', 'dashboard snapshot failed', { error: message });
      return 0;
    }
  }

  /** P4b (migration 0061): contractors_daily_alerts in its own transaction and lock; a failure is logged and leaves the other steps alone. */
  private async contractorAlerts(): Promise<number> {
    try {
      return await this.db.client.$transaction(async (tx) => {
        const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pmis.contractor_alerts')) AS ok`;
        if (!lock[0]?.ok) return 0;
        await this.runs.context(tx, 'contractor_alerts');
        const r = await tx.$queryRaw<{ n: number }[]>`SELECT contractors_daily_alerts() AS n`;
        return Number(r[0]?.n ?? 0);
      }, { maxWait: 10_000, timeout: 60_000 });
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      this.log.warn(`contractor alerts failed: ${message}`);
      await this.syslog.write('error', 'contractor alerts failed', { error: message });
      return 0;
    }
  }

  private async timeZone(): Promise<string> {
    try {
      const r = await this.db.client.$queryRaw<{ tz: string | null }[]>`SELECT calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}' AS tz`;
      const tz = r[0]?.tz ?? JOB_TIME_ZONE;
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });   // throws for an unknown zone
      return tz;
    } catch {
      return JOB_TIME_ZONE;
    }
  }

  private async scheduleNext(): Promise<void> {
    if (this.stopped) return;
    const at = nextRunAt(new Date(), await this.timeZone());
    this.nextRun = at;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.scheduleNext());
    }, Math.max(1_000, at.getTime() - Date.now()));
    this.timer.unref();
  }
}
