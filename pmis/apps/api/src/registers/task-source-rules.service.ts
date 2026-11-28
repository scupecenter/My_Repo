import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

type Json = Record<string, unknown>;
const code = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const body = z.object({
  reason: z.string().trim().min(3).max(1000),
  rows: z.array(z.object({
    register_key: z.string().regex(/^[a-z][a-z_]{1,30}$/), task_code: z.string().trim().min(1).max(20), date_field: code,
    data_eq: z.record(code, z.string().max(200)).optional(), data_in: z.record(code, z.array(z.string().max(200)).max(40)).optional(),
    sort_order: z.number().int().min(0).max(100000).optional(), is_active: z.boolean().optional(),
  }).strict()).max(60),
}).strict();

/**
 * Automation item 4 (migration 0770): the rows of register_task_sources (which register record is the source of which task, Q43) are edited in Settings. The
 * workflow itself (link at submission, date and approval at the final approval) is the unchanged 0019 path. Read: Settings view. Write: admin.settings edit.
 */
@Injectable()
export class TaskSourceRulesService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT task_src`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT task_src`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT task_src`;
      throw p;
    }
  }

  async list(auth: AuthContext): Promise<Json> {
    await this.access.requireModuleView(auth, 'admin.settings');
    return this.door(Prisma.sql`SELECT register_task_sources_json() AS r`);
  }

  async save(ifMatch: string | undefined, raw: unknown): Promise<Json> {
    await this.access.requireAdmin('admin.settings', 'edit');
    const b = parse(body, raw);
    const v = ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch);
    return this.door(Prisma.sql`SELECT admin_save_register_task_sources(${JSON.stringify(b.rows)}::jsonb, ${b.reason}::text, ${v}::int) AS r`);
  }
}
