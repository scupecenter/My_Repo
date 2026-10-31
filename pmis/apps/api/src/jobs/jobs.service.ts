import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SyslogService } from '../auth/syslog.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';

export const JOB_HOUR = 2;
export const JOB_TIME_ZONE = 'Africa/Tripoli';
export const REMINDER_DAYS = 14;

export interface DailyJobResult {
  /** open tasks whose SLA terms changed because a future-dated SLA version took effect */
  slaApplied: number;
  /** tentative-holiday reminders sent to the System Admins */
  reminders: number;
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
    try {
      const result = await this.db.client.$transaction(async (tx) => {
        const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pmis.daily_job')) AS ok`;
        if (!lock[0]?.ok) return null;
        const applied = await tx.$queryRaw<{ n: number }[]>`SELECT sla_apply_due_sets() AS n`;
        const reminded = await tx.$queryRaw<{ n: number }[]>`SELECT cal_tentative_reminders(${REMINDER_DAYS}::integer) AS n`;
        return { slaApplied: Number(applied[0]?.n ?? 0), reminders: Number(reminded[0]?.n ?? 0) };
      }, { maxWait: 10_000, timeout: 60_000 });
      this.lastRun = { at: new Date(), result };
      if (result && (result.slaApplied > 0 || result.reminders > 0)) {
        await this.syslog.write('info', 'daily job ran', { sla_applied: result.slaApplied, holiday_reminders: result.reminders });
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      this.lastRun = { at: new Date(), result: null, error: message };
      this.log.warn(`daily job failed: ${message}`);
      await this.syslog.write('error', 'daily job failed', { error: message });
      return null;
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
