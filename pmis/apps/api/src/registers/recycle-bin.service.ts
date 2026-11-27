import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { RegistersService } from './registers.service';

const restoreSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
const retentionSchema = z.object({ retention_days: z.number().int().min(30).max(730), reason: z.string().trim().min(3).max(1000) }).strict();
const uuid = z.string().uuid();

/**
 * Recycle bin for voided register records (contract 0.15.98). A voided record is never deleted; the bin lists those voided inside the retention window
 * and a System Admin restores one back to a draft (`admin_restore_register_record`, audited). The retention is a setting (30 to 730 days, default 90).
 * Every gate (System Admin only, retention, one open version, one record per site) is in the SQL door.
 */
@Injectable()
export class RecycleBinService {
  constructor(private readonly registers: RegistersService, private readonly stepUp: StepUpService) {}

  list(auth: AuthContext): Promise<Record<string, unknown>> {
    return this.registers.call<Record<string, unknown>>(auth, Prisma.sql`SELECT recycle_bin_json() AS r`);
  }

  async restore(auth: AuthContext, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const rid = parse(uuid, id);
    const version = parseIfMatch(ifMatch);
    const body = parse(restoreSchema, rawBody ?? {});
    await this.stepUp.require(auth);
    return this.registers.call<Record<string, unknown>>(auth, Prisma.sql`SELECT admin_restore_register_record(${rid}::uuid, ${version}::int, ${body.reason}::text) AS r`);
  }

  async setRetention(auth: AuthContext, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(retentionSchema, rawBody);
    return this.registers.call<Record<string, unknown>>(auth, Prisma.sql`SELECT admin_set_recycle_retention(${body.retention_days}::int, ${body.reason}::text, ${version}::int) AS r`);
  }
}
