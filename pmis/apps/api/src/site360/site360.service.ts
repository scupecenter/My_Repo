import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { buildSite360, SITE360_MOVABLE, type Site360ColumnRow, type Site360MenuItem } from './site360-sections';

const moveSchema = z.object({
  section: z.enum(SITE360_MOVABLE),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface Site360ColumnDto extends Site360ColumnRow {
  is_phase_gate: boolean;
}

/** SITE 360 menus (contract 0.15.21, F15). The column metadata is the one source; no second store. */
@Injectable()
export class Site360Service {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  async sections(): Promise<{ items: Site360MenuItem[]; can_move: boolean }> {
    const rows = await this.db.tx.$queryRaw<Site360ColumnRow[]>`
      SELECT ord, letter, group_top, group_mid, header, site360_section AS section
      FROM master_columns WHERE is_active ORDER BY ord`;
    const admin = await this.db.tx.$queryRaw<{ ok: boolean }[]>`
      SELECT coalesce(app_actor_is_admin('admin.settings', 'edit'), false) AS ok`;
    return { items: buildSite360(rows), can_move: admin[0]?.ok ?? false };
  }

  async move(auth: AuthContext, rawOrd: unknown, raw: unknown): Promise<Site360ColumnDto> {
    const ord = Number(rawOrd);
    if (!Number.isInteger(ord) || ord < 1 || ord > 187) {
      throw new ProblemException(422, 'validation_failed', { detail: 'The column order must be 1 to 187.', errors: [{ path: '/ord', code: 'invalid' }] });
    }
    const b = parse(moveSchema, raw);
    await this.stepUp.require(auth);
    await this.db.tx.$queryRaw(Prisma.sql`
      SELECT site360_move_column(${ord}::integer, ${b.section}::text, ${b.reason}::text) AS j`);
    const rows = await this.db.tx.$queryRaw<Site360ColumnRow[]>`
      SELECT ord, letter, group_top, group_mid, header, site360_section AS section FROM master_columns WHERE ord = ${ord}`;
    const r = rows[0]!;
    return { ...r, is_phase_gate: r.group_top === 'Phase Gate' };
  }
}
