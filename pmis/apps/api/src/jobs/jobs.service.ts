import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SyslogService } from '../auth/syslog.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { JobRunsService } from '../logs/job-runs.service';
import { DashboardExtrasService } from '../dashboard/dashboard-extras.service';

export const JOB_HOUR = 2;
export const JOB_TIME_ZONE = 'Africa/Tripoli';
export const REMINDER_DAYS = 14;

/** 0530 (B1): what one hourly policy step wrote (counts by name) and the digests it ran. */
export type PolicyTickResult = Record<string, number>;
const POLICY_TICK_MS = 3_600_000;

export interface DailyJobResult {
  /** open tasks whose SLA terms changed because a future-dated SLA version took effect */
  slaApplied: number;
  /** tentative-holiday reminders sent to the System Admins */
  reminders: number;
  /** sites stored by the weekly dashboard snapshot of this run (absent when no snapshot was due) */
  snapshots?: number;
  /** P4b (migration 0061): team safety certificate alerts (D145b, information only) and running-order mismatch alerts (Q145) written by this run */
  contractorAlerts?: number;
  /** Q245 (migration 0067): 1 when calendar.official_confirmed was reset because a new year began (job_runs row `calendar_year_reset`, audited) */
  calendarReset?: number;
  /** 0165: SLA escalation notifications (notify only) written by this run */
  slaEscalations?: number;
  /** 0166: weekly digest notifications (in-app only) written by this run; only on the week's Sunday */
  digests?: number;
  /** 0342: alert rule notifications (in-app only) written by this run */
  alertRules?: number;
  /** 0702 (L8): first-time notices to the System Admins about a module with registers and no permission grants */
  noGrantNotices?: number;
  /** 0360 (A3): expiry radar notices (in-app only) written by this run */
  expiryNotices?: number;
  /** 0362 (A9): approval digest notices written by this run */
  approvalDigests?: number;
  templateNotices?: number;
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
  private policyTimer: NodeJS.Timeout | undefined;
  private policyInflight: Promise<PolicyTickResult | null> | undefined;
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
    private readonly dash: DashboardExtrasService,
  ) {}

  get enabled(): boolean {
    return this.config.jobsEnabled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobsEnabled) return;
    await this.scheduleNext();
    void this.runOnce();                                    // once at start-up; never blocks the listen
    this.policyTimer = setInterval(() => void this.runPolicyTick(), POLICY_TICK_MS);   // 0530 (B1): the notification policy, every hour
    this.policyTimer.unref();
    void this.runPolicyTick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.policyTimer) clearInterval(this.policyTimer);
    this.policyTimer = undefined;
    if (this.policyInflight) await this.policyInflight.catch(() => undefined);
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
        const reset = await this.calendarYearReset();
        if (reset > 0) result.calendarReset = reset;
        const escalated = await this.slaEscalations();
        if (escalated > 0) result.slaEscalations = escalated;
        const ruleNotes = await this.alertRules();
        if (ruleNotes > 0) result.alertRules = ruleNotes;
        const noGrants = await this.noGrantNotices();
        if (noGrants > 0) result.noGrantNotices = noGrants;
        const expiring = await this.expiryRadar();
        if (expiring > 0) result.expiryNotices = expiring;
        const changed = await this.templateChanges();
        if (changed > 0) result.templateNotices = changed;
      }
      this.lastRun = { at: new Date(), result };
      await this.runs.finish(run, result ? 'ok' : 'skipped', result ? result.slaApplied + result.reminders + (result.snapshots ?? 0) + (result.contractorAlerts ?? 0) + (result.calendarReset ?? 0) : null, null,
        result ? { sla_applied: result.slaApplied, holiday_reminders: result.reminders, dashboard_snapshot_sites: result.snapshots ?? 0, contractor_alerts: result.contractorAlerts ?? 0, calendar_reset: result.calendarReset ?? 0 } : { reason: 'locked' });
      if (result && (result.slaApplied > 0 || result.reminders > 0 || (result.snapshots ?? 0) > 0 || (result.calendarReset ?? 0) > 0)) {
        await this.syslog.write('info', 'daily job ran', { sla_applied: result.slaApplied, holiday_reminders: result.reminders, dashboard_snapshot_sites: result.snapshots ?? 0, calendar_reset: result.calendarReset ?? 0 });
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

  /**
   * 0530 (B1): the hourly step of the notification policy (setting notifications.policy): approval reminders and escalations, the no-holder alert, the idle-task alert and the
   * retention of old notices (database function notif_policy_tick), then, once the policy digest hour has come in the policy time zone, the approval digest (0362) and the
   * weekly digest (0166, Sundays only). All of it is idempotent: a later run of the same day writes nothing twice. Never throws; null when it failed.
   */
  runPolicyTick(): Promise<PolicyTickResult | null> {
    if (this.policyInflight) return this.policyInflight;
    const p = this.policyStep().finally(() => {
      this.policyInflight = undefined;
    });
    this.policyInflight = p;
    return p;
  }

  private async policyStep(): Promise<PolicyTickResult | null> {
    let counts: Record<string, number> = {};
    let due = false;
    const tick = await this.runs.run('notification_policy', async (tx) => {
      const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pmis.notification_policy')) AS ok`;
      if (!lock[0]?.ok) return 0;
      const r = await tx.$queryRaw<{ t: Record<string, number> }[]>`SELECT notif_policy_tick() AS t`;
      counts = r[0]?.t ?? {};
      due = (await tx.$queryRaw<{ d: boolean }[]>`SELECT notif_digest_due() AS d`)[0]?.d === true;
      return Object.values(counts).reduce((x, y) => x + Number(y), 0);
    });
    if (tick === null) {
      this.log.warn('notification policy tick failed or was locked');
      return null;
    }
    const result: PolicyTickResult = { ...counts };
    if (due) {
      const approvals = await this.approvalDigest();
      if (approvals > 0) result.approvalDigests = approvals;
      const digests = await this.weeklyDigest();
      if (digests > 0) result.digests = digests;
    }
    return result;
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

  /** 0165: the SLA escalation ladder, notify only: one in-app notification per person and task for the escalation role of an overdue task's SLA rule. A failure is logged and leaves the other steps alone. */
  private async slaEscalations(): Promise<number> {
    try {
      return await this.db.client.$transaction(async (tx) => {
        const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pmis.sla_escalation')) AS ok`;
        if (!lock[0]?.ok) return 0;
        await this.runs.context(tx, 'sla_escalation');
        const r = await tx.$queryRaw<{ n: number }[]>`SELECT sla_escalation_notify() AS n`;
        return Number(r[0]?.n ?? 0);
      }, { maxWait: 10_000, timeout: 60_000 });
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      this.log.warn(`sla escalation failed: ${message}`);
      await this.syslog.write('error', 'sla escalation failed', { error: message });
      return 0;
    }
  }

  /**
   * Q245 (migration 0067): the setting calendar.official_confirmed goes back to false when a new year began (1 January, Africa/Tripoli), so the "calendar not
   * confirmed" banner returns until the new year's dates are confirmed. A job of its own: its own job_runs row `calendar_year_reset` (rows = 1 when it reset)
   * and an audit row written by the database; a failure is logged and leaves the other steps alone.
   */
  private async calendarYearReset(): Promise<number> {
    const n = await this.runs.run('calendar_year_reset', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT cal_official_confirmed_reset() AS n`)[0]?.n ?? 0));
    if (n === null) {
      this.log.warn('calendar year reset failed');
      await this.syslog.write('error', 'calendar year reset failed', {});
      return 0;
    }
    return n;
  }

  /** 0166: the weekly digest, in-app only; the database function does nothing except on a Sunday and writes one notification per person per week. A failure is logged and leaves the other steps alone. */
  private async weeklyDigest(): Promise<number> {
    const n = await this.runs.run('weekly_digest', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT weekly_digest_notify() AS n`)[0]?.n ?? 0));
    if (n === null) {
      this.log.warn('weekly digest failed');
      await this.syslog.write('error', 'weekly digest failed', {});
      return 0;
    }
    return n;
  }

  /** 0342: the generic alert rules, in-app notifications only; alert_rules_run finds the targets of the day and writes one notification per
   * recipient per rule per period and target (deduped), so a second run the same day adds nothing. A failure is logged and leaves the other steps alone. */
  private async alertRules(): Promise<number> {
    const n = await this.runs.run('alert_rules', async (tx) => {
      const base = Number((await tx.$queryRaw<{ n: number }[]>`SELECT alert_rules_run() AS n`)[0]?.n ?? 0);
      // 0348: the kpi_threshold rules compare the live system-wide KPI values with each rule's own editable threshold.
      const values = await this.dash.kpiValuesForJob();
      const kpi = Number((await tx.$queryRaw<{ n: number }[]>`SELECT alert_rules_kpi_run(${JSON.stringify(values)}::jsonb) AS n`)[0]?.n ?? 0);
      return base + kpi;
    });
    if (n === null) {
      this.log.warn('alert rules failed');
      await this.syslog.write('error', 'alert rules failed', {});
      return 0;
    }
    return n;
  }

  /** 0702 (L8): one in-app notice per System Admin and module, the first time a module with registers has no permission grant. Notify only; grants nothing. A failure is logged and leaves the other steps alone. */
  private async noGrantNotices(): Promise<number> {
    const n = await this.runs.run('module_no_grants', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT modules_no_grants_notify() AS n`)[0]?.n ?? 0));
    if (n === null) {
      this.log.warn('module no-grants notice failed');
      await this.syslog.write('error', 'module no-grants notice failed', {});
      return 0;
    }
    return n;
  }

  /** 0360 (A3): the expiry radar (permit valid to, lease expiry, billing conversion), in-app notices to the Matrix holders; lead times are the setting expiry.radar. */
  private async expiryRadar(): Promise<number> {
    const n = await this.runs.run('expiry_radar', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT expiry_radar_notify() AS n`)[0]?.n ?? 0));
    if (n === null) {
      this.log.warn('expiry radar failed');
      await this.syslog.write('error', 'expiry radar failed', {});
      return 0;
    }
    return n;
  }

  /** 0367 (P3): in-app notice to the entry holders when a register template gets a new version; the setting is templates.change_notice. */
  private async templateChanges(): Promise<number> {
    const n = await this.runs.run('template_change_notice', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT template_change_notify() AS n`)[0]?.n ?? 0));
    if (n === null) {
      this.log.warn('template change notice failed');
      await this.syslog.write('error', 'template change notice failed', {});
      return 0;
    }
    return n;
  }

  /** 0362 (A9): the daily approval digest, in-app notices to the Matrix holders of what waits at their level; stale days are the setting approvals.digest. */
  private async approvalDigest(): Promise<number> {
    const n = await this.runs.run('approval_digest', async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT approval_digest_notify() AS n`)[0]?.n ?? 0));
    if (n === null) {
      this.log.warn('approval digest failed');
      await this.syslog.write('error', 'approval digest failed', {});
      return 0;
    }
    return n;
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
