import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');
const reason = z.string().trim().min(3).max(1000);
const setBody = z.object({ starts_on: date, ends_on: date, reason }).strict();
const liftBody = z.object({ reason, confirm_text: z.string().max(200) }).strict();
export const FREEZE_CONFIRM = 'structural-freeze';
type Json = Record<string, unknown>;

/**
 * Decision B9 (migration 0090): the structural freeze of the workflow. Set (and set again after a lift, which re-locks) needs `workflow_versions.administer`
 * for all regions; lifting is System Admin only with the typed confirmation `structural-freeze`. Both need a reason, a step-up and If-Match; the database audits.
 */
@Injectable()
export class StructuralFreezeService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async one(sql: Prisma.Sql): Promise<Json> {
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(sql);
    return rows[0]?.r ?? {};
  }

  get(): Promise<Json> {
    return this.one(Prisma.sql`SELECT wf_freeze_state() AS r`);
  }

  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(setBody, raw);
    await this.access.requireAdmin('workflow_versions', 'administer');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_set_structural_freeze(${b.starts_on}::date, ${b.ends_on}::date, ${b.reason}::text, ${etag}::int) AS r`);
  }

  async lift(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(liftBody, raw);
    const a = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT coalesce(app_actor_is_system_admin(), false) AS ok`;
    if (!a[0]?.ok) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin lifts the structural freeze.' });
    if (b.confirm_text !== FREEZE_CONFIRM) {
      throw new ProblemException(422, 'confirmation_mismatch', { detail: `Type ${FREEZE_CONFIRM} to confirm.`, errors: [{ path: '/confirm_text', code: 'confirmation_mismatch' }] });
    }
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_lift_structural_freeze(${b.reason}::text, ${etag}::int) AS r`);
  }
}
