import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { applyLimits } from './ops-limits';

const putBody = z.object({
  values: z.record(z.string(), z.number()),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface OpsLimitItem {
  key: string;
  group: 'sessions' | 'rows' | 'exports' | 'media';
  unit: 'hours' | 'seconds' | 'rows' | 'sites' | 'entries' | 'attempts' | 'per_minute';
  default: number;
  min: number;
  max: number;
  value: number;
  is_default: boolean;
}

export interface OpsLimitsDto {
  items: OpsLimitItem[];
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

const REFRESH_MS = 30_000;

/**
 * Operational limits (migration 0402, setting ops.limits). Every signed-in user reads the state; only a System Admin changes it, with a reason, a step-up and If-Match,
 * and the database audits it (ops_limits_update). The code reads the numbers through `limit()` in ./ops-limits, kept fresh here.
 */
@Injectable()
export class OpsLimitsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsLimits');
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reads the effective limits outside any request. A failure keeps the previous values. */
  async refresh(): Promise<void> {
    try {
      const rows = await this.db.client.$queryRaw<{ r: { values: Record<string, unknown>; explicit: string[] } }[]>`SELECT ops_limits_public() AS r`;
      const r = rows[0]?.r;
      if (r) applyLimits(r.values, r.explicit);
    } catch (e) {
      this.log.warn(`could not read the limits, keeping the last values: ${(e as Error).message}`);
    }
  }

  private async one(sql: Prisma.Sql): Promise<OpsLimitsDto> {
    const rows = await this.db.tx.$queryRaw<{ r: OpsLimitsDto }[]>(sql);
    return rows[0]!.r;
  }

  get(): Promise<OpsLimitsDto> {
    return this.one(Prisma.sql`SELECT ops_limits_state() AS r`);
  }

  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<OpsLimitsDto> {
    const b = parse(putBody, raw);
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    const r = await this.one(Prisma.sql`SELECT admin_set_ops_limits(${JSON.stringify(b.values)}::jsonb, ${b.reason}::text, ${etag}::int) AS r`);
    void this.refresh();
    return r;
  }
}
