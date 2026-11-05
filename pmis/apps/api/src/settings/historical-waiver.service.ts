import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const putSchema = z.object({
  open: z.boolean(),
  cutoff_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.').optional(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface HistoricalWaiverDto {
  open: boolean;
  cutoff_date: string | null;
  opened_at: string | null;
  expires_at: string | null;
  days_left: number | null;
  window_days: number;
  opened_by: string | null;
  reason: string | null;
  closed_at: string | null;
  closed_how: 'manual' | 'expired' | null;
  can_manage: boolean;
}

/**
 * Q462 (migration 0073): the one-time historical-load document waiver. The state is read through hw_waiver_state (the effective state: 30 days, never a stale "open").
 * Only a System Admin, never a delegate, opens or closes it, with a reason and a step-up (hw_waiver_set); the setting `load.historical_waiver` has no other writer.
 */
@Injectable()
export class HistoricalWaiverService {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  async get(): Promise<HistoricalWaiverDto> {
    const r = await this.db.tx.$queryRaw<{ j: HistoricalWaiverDto }[]>`SELECT hw_waiver_state() AS j`;
    return r[0]!.j;
  }

  async put(auth: AuthContext, raw: unknown): Promise<HistoricalWaiverDto> {
    const b = parse(putSchema, raw);
    // a delegate is refused before any step-up is asked for: the waiver is a System Admin action that cannot be delegated
    const a = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT coalesce(app_actor_is_system_admin(), false) AS ok`;
    if (!a[0]?.ok) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin can open or close the historical-load waiver. It cannot be delegated.' });
    await this.stepUp.require(auth);
    const r = await this.db.tx.$queryRaw<{ j: HistoricalWaiverDto }[]>(Prisma.sql`
      SELECT hw_waiver_set(${b.open}::boolean, ${b.cutoff_date ?? null}::date, ${b.reason}::text) AS j`);
    return r[0]!.j;
  }
}
