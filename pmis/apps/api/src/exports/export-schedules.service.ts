import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { mapDbError } from '../common/db-errors';
import { DbService } from '../db/db.service';
import { MasterExportService } from './master-export.service';

const itemSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  weekday: z.number().int().min(0).max(6).optional(),
  day_of_month: z.number().int().min(1).max(28).optional(),
  spec: z.object({ parts: z.array(z.string().max(60)).max(40).optional(), regions: z.array(z.number().int().min(1).max(99)).min(1).max(7).optional() }).strict().default({}),
  enabled: z.boolean().optional(),
}).strict();

interface ScheduleRow { id: string; spec: { parts?: string[]; regions?: number[] }; due: boolean; next_due_at: string; enabled: boolean }

/**
 * Scheduled recurring Master export (contract 0.15.99, migration 0251). No job runs as a person: when the owner opens Exports, each due schedule of the
 * owner starts in that same request through the normal start path (the owner's own session, grants and region rules are checked again by it). A schedule
 * that cannot start records its error and moves to the next due day. The idempotency key is the schedule and its due instant, so a second open does not
 * start it twice.
 */
@Injectable()
export class ExportSchedulesService {
  constructor(private readonly db: DbService, private readonly exports: MasterExportService) {}

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
      const body: Record<string, unknown> = { ...(s.spec.parts?.length ? { parts: s.spec.parts } : {}), ...(s.spec.regions ? { regions: s.spec.regions } : {}) };
      await this.db.tx.$executeRaw`SAVEPOINT export_sched`;
      try {
        const r = await this.exports.start(auth, body, `sched-${s.id}-${new Date(s.next_due_at).toISOString()}`, onStarted);
        await this.db.tx.$executeRaw`RELEASE SAVEPOINT export_sched`;
        await this.db.tx.$executeRaw(Prisma.sql`SELECT export_schedule_mark(${s.id}::uuid, ${String(r.id)}::uuid, NULL)`);
      } catch (e) {
        await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT export_sched`;
        const msg = e instanceof ProblemException ? ((e.getResponse() as { detail?: string; code?: string }).detail ?? e.message) : (e instanceof Error ? e.message : 'failed');
        await this.db.tx.$executeRaw(Prisma.sql`SELECT export_schedule_mark(${s.id}::uuid, NULL, ${String(msg).slice(0, 300)}::text)`);
      }
    }
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
