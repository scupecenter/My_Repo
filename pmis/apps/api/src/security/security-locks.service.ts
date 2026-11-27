import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const putBody = z.object({
  block_public_sharing: z.boolean(),
  disable_export: z.boolean(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface SecurityLocksDto {
  block_public_sharing: boolean;
  disable_export: boolean;
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

export type LockKey = 'block_public_sharing' | 'disable_export';
export const SHARING_LOCKED_DETAIL = 'Public sharing is switched off by a System Admin (Settings > Security > Lock keys).';

/**
 * Admin lock keys (migration 0290, setting security.locks): block public sharing, disable export. Both are off until a System Admin turns one on. Every signed-in user reads
 * the state (the UI hides what is locked); only a System Admin changes it, with a reason, a step-up and If-Match, and the database audits it (security_locks_update).
 * A feature that creates a public link MUST call `assertSharingAllowed()` before it does; exports are enforced by the `@ExportAction()` decorator.
 */
@Injectable()
export class SecurityLocksService {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  private async one(sql: Prisma.Sql): Promise<SecurityLocksDto> {
    const rows = await this.db.tx.$queryRaw<{ r: SecurityLocksDto }[]>(sql);
    return rows[0]!.r;
  }

  get(): Promise<SecurityLocksDto> {
    return this.one(Prisma.sql`SELECT security_locks_state() AS r`);
  }

  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<SecurityLocksDto> {
    const b = parse(putBody, raw);
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_set_security_locks(${b.block_public_sharing}::boolean, ${b.disable_export}::boolean, ${b.reason}::text, ${etag}::int) AS r`);
  }

  /** True while the lock is on. Runs in the request transaction. */
  async isOn(key: LockKey): Promise<boolean> {
    const rows = await this.db.tx.$queryRaw<{ on: boolean }[]>(Prisma.sql`SELECT security_lock_active(${key}::text) AS "on"`);
    return rows[0]?.on === true;
  }

  /** For any feature that would create a public link: refuses with 403 `action_forbidden` (`errors[0].code = sharing_locked`) while the lock is on. */
  async assertSharingAllowed(): Promise<void> {
    if (await this.isOn('block_public_sharing')) {
      throw new ProblemException(403, 'action_forbidden', { detail: SHARING_LOCKED_DETAIL, errors: [{ path: '', code: 'sharing_locked', message: SHARING_LOCKED_DETAIL }] });
    }
  }
}
