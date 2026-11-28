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
    register_key: z.string().regex(/^[a-z][a-z_]{1,30}$/), link_field: code, target_field: code, source_field: code,
    sort_order: z.number().int().min(0).max(100000).optional(), is_active: z.boolean().optional(),
  }).strict()).max(60),
}).strict();

/**
 * Automation item 9 (migration 0772): "the final approval of a record fills the empty field of the record it links to" (delivery and invoice fields), the rows are
 * edited in Settings. The copy itself is the trigger reg_link_fills_apply (entry records only, empty fields only, audited). Read: Settings view. Write: admin.settings edit.
 */
@Injectable()
export class LinkFillsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT link_fills`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT link_fills`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT link_fills`;
      throw p;
    }
  }

  async list(auth: AuthContext): Promise<Json> {
    await this.access.requireModuleView(auth, 'admin.settings');
    return this.door(Prisma.sql`SELECT register_link_fills_json() AS r`);
  }

  async save(ifMatch: string | undefined, raw: unknown): Promise<Json> {
    await this.access.requireAdmin('admin.settings', 'edit');
    const b = parse(body, raw);
    const v = ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch);
    return this.door(Prisma.sql`SELECT admin_save_register_link_fills(${JSON.stringify(b.rows)}::jsonb, ${b.reason}::text, ${v}::int) AS r`);
  }
}
