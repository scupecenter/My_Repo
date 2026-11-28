import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { parseIfMatch } from '../common/etag';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { mapDbError } from '../common/db-errors';
import { DbService } from '../db/db.service';
import { applyContext, jobContext } from '../logs/context';
import { MasterExportService } from './master-export.service';

const itemSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  weekday: z.number().int().min(0).max(6).optional(),
  day_of_month: z.number().int().min(1).max(28).optional(),
  // 0659: `view` is one register or Master view, the same body as POST /exports/master (checked again when the schedule starts)
  spec: z.object({
    parts: z.array(z.string().max(60)).max(40).optional(),
    regions: z.array(z.number().int().min(1).max(99)).min(1).max(7).optional(),
    view: z.object({ source: z.string().max(60), filters: z.record(z.string(), z.unknown()), columns: z.array(z.string().max(80)).min(1).max(400), sort: z.string().max(100).optional() }).strict().optional(),
  }).strict().default({}),
  enabled: z.boolean().optional(),
  mail: z.boolean().optional(),
  unattended: z.boolean().optional(),
}).strict();

interface ScheduleSpec { parts?: string[]; regions?: number[]; view?: unknown }
interface ScheduleRow { id: string; name: string; spec: ScheduleSpec; due: boolean; next_due_at: string; enabled: boolean; mail?: boolean }
interface UnattendedRow { id: string; owner_id: string; name: string; spec: ScheduleSpec; mail: boolean; next_due_at: string }
const UNATTENDED_EVERY_MS = 60 * 60 * 1000;
const bodyOf = (spec: ScheduleSpec): Record<string, unknown> => ({ ...(spec.parts?.length ? { parts: spec.parts } : {}), ...(spec.regions ? { regions: spec.regions } : {}), ...(spec.view ? { view: spec.view } : {}) });

/**
 * Scheduled recurring Master export (contract 0.15.99, migration 0251). No job runs as a person: when the owner opens Exports, each due schedule of the
 * owner starts in that same request through the normal start path (the owner's own session, grants and region rules are checked again by it). A schedule
 * that cannot start records its error and moves to the next due day. The idempotency key is the schedule and its due instant, so a second open does not
 * start it twice.
 */
@Injectable()
export class ExportSchedulesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('ExportSchedules');
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<number> | null = null;

  constructor(private readonly db: DbService, private readonly exports: MasterExportService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    this.timer = setInterval(() => void this.runUnattended(), UNATTENDED_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** GET /exports/unattended: the system switch (0659). Read by every signed-in user (the schedule dialog shows it); changed by a System Admin. */
  async unattendedSwitch(): Promise<Record<string, unknown> & { version: number }> {
    const r = await this.db.tx.$queryRaw<{ j: Record<string, unknown> & { version: number } }[]>(Prisma.sql`SELECT export_unattended_json() AS j`);
    return r[0]!.j;
  }

  /** PUT /exports/unattended: the database checks the System Admin right, the reason and the version, and audits the change. */
  async setUnattendedSwitch(ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown> & { version: number }> {
    const version = ifMatch === undefined ? null : parseIfMatch(ifMatch);
    const b = parse(z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(1000) }).strict(), raw);
    await this.db.tx.$executeRaw`SAVEPOINT export_unattended_set`;
    try {
      const r = await this.db.tx.$queryRaw<{ j: Record<string, unknown> & { version: number } }[]>(Prisma.sql`SELECT admin_set_export_unattended(${b.enabled}::boolean, ${b.reason}::text, ${version}::int) AS j`);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT export_unattended_set`;
      return r[0]!.j;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT export_unattended_set`;
      throw p;
    }
  }

  async list(): Promise<{ items: unknown[] }> {
    return this.one(Prisma.sql`SELECT export_schedules_json() AS r`);
  }

  async save(raw: unknown): Promise<{ items: unknown[] }> {
    const b = parse(itemSchema, raw);
    return this.one(Prisma.sql`SELECT export_schedule_save(${JSON.stringify(b)}::jsonb) AS r`);
  }

  async remove(id: string): Promise<{ items: unknown[] }> {
    const u = parse(z.string().uuid(), id);
    return this.one(Prisma.sql`SELECT export_schedule_delete(${u}::uuid) AS r`);
  }

  /** Starts the due schedules of the caller. Never throws: a failure is recorded on the schedule. */
  async runDue(auth: AuthContext, onStarted: (go: () => void) => void): Promise<void> {
    let items: ScheduleRow[];
    try { items = ((await this.list()).items as ScheduleRow[]).filter((i) => i.due); } catch { return; }
    if (!items.length) return;
    // The lock key `disable_export` (Settings > Security > Lock keys) stops scheduled exports too: nothing is started and the schedules stay due.
    try {
      const lock = await this.db.tx.$queryRaw<{ on: boolean }[]>(Prisma.sql`SELECT security_lock_active('disable_export') AS "on"`);
      if (lock[0]?.on) return;
    } catch { return; }
    for (const s of items) {
      const body = bodyOf(s.spec);
      await this.db.tx.$executeRaw`SAVEPOINT export_sched`;
      try {
        const r = await this.exports.start(auth, body, `sched-${s.id}-${new Date(s.next_due_at).toISOString()}`, onStarted, s.mail ? { name: s.name } : undefined);
        await this.db.tx.$executeRaw`RELEASE SAVEPOINT export_sched`;
        await this.db.tx.$executeRaw(Prisma.sql`SELECT export_schedule_mark(${s.id}::uuid, ${String(r.id)}::uuid, NULL)`);
      } catch (e) {
        await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT export_sched`;
        const msg = e instanceof ProblemException ? ((e.getResponse() as { detail?: string; code?: string }).detail ?? e.message) : (e instanceof Error ? e.message : 'failed');
        await this.db.tx.$executeRaw(Prisma.sql`SELECT export_schedule_mark(${s.id}::uuid, NULL, ${String(msg).slice(0, 300)}::text)`);
      }
    }
  }

  /**
   * The unattended run (0659), every hour from the API job. For each due schedule that its owner marked unattended (and only while the system switch is ON) it opens
   * a transaction as the owner with via = job and no session: the grants and region rules of the owner are derived live by the database, exactly as for the
   * owner's own request, and the start path is the same one. The lock `disable_export` stops it. A failure is recorded on the schedule (export_schedule_mark)
   * and the schedule moves to its next due day. The idempotency key (schedule and due instant) keeps a second run, or a run beside the owner opening Exports,
   * from starting it twice. Returns the number started. Never throws.
   */
  runUnattended(): Promise<number> {
    if (this.inflight) return this.inflight;
    const p = this.unattendedStep().catch((e) => { this.log.warn(`unattended exports: ${e instanceof Error ? e.message : String(e)}`); return 0; }).finally(() => { this.inflight = null; });
    this.inflight = p;
    return p;
  }

  private async unattendedStep(): Promise<number> {
    const due = await this.db.client.$transaction(async (tx) => {
      await applyContext(tx, jobContext('export_schedules'));
      const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pmis.export_schedules')) AS ok`;
      if (!lock[0]?.ok) return [] as UnattendedRow[];
      return (await tx.$queryRaw<{ r: UnattendedRow[] }[]>`SELECT export_schedules_due_unattended() AS r`)[0]?.r ?? [];
    }, { maxWait: 10_000, timeout: 30_000 });
    let started = 0;
    for (const s of due) {
      const gos: (() => void)[] = [];
      try {
        const ok = await this.db.client.$transaction(async (tx) => {
          await applyContext(tx, { ...jobContext('export_schedules'), userId: s.owner_id });
          return this.db.runIn(tx, async () => {
            const lock = await this.db.tx.$queryRaw<{ on: boolean }[]>(Prisma.sql`SELECT security_lock_active('disable_export') AS "on"`);
            if (lock[0]?.on) return false;
            // no session: the worker and the start path read only the user id of the actor
            const auth = { user: { id: s.owner_id } } as unknown as AuthContext;
            await this.db.tx.$executeRaw`SAVEPOINT export_sched`;
            try {
              const r = await this.exports.start(auth, bodyOf(s.spec), `sched-${s.id}-${new Date(s.next_due_at).toISOString()}`, (go) => { gos.push(go); }, s.mail ? { name: s.name } : undefined);
              await this.db.tx.$executeRaw`RELEASE SAVEPOINT export_sched`;
              await this.db.tx.$executeRaw(Prisma.sql`SELECT export_schedule_mark(${s.id}::uuid, ${String(r.id)}::uuid, NULL)`);
            } catch (e) {
              await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT export_sched`;
              const msg = e instanceof ProblemException ? ((e.getResponse() as { detail?: string }).detail ?? e.message) : (e instanceof Error ? e.message : 'failed');
              await this.db.tx.$executeRaw(Prisma.sql`SELECT export_schedule_mark(${s.id}::uuid, NULL, ${String(msg).slice(0, 300)}::text)`);
              gos.length = 0;
            }
            return true;
          });
        }, { maxWait: 10_000, timeout: 60_000 });
        if (ok) { for (const go of gos) go(); started += gos.length; }
      } catch (e) {
        this.log.warn(`unattended export ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return started;
  }

  private async one(sql: Prisma.Sql): Promise<{ items: unknown[] }> {
    await this.db.tx.$executeRaw`SAVEPOINT export_sched_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: { items: unknown[] } }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT export_sched_call`;
      return (rows[0] as { r: { items: unknown[] } }).r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT export_sched_call`;
      throw p;
    }
  }
}
