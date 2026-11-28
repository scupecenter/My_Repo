import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

type Json = Record<string, unknown>;
const key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const linkBody = z.object({
  from_register: key, field: key, to_register: key,
  enforce: z.boolean().optional(), same_site: z.boolean().optional(), enabled: z.boolean().optional(),
}).strip();
const saveBody = z.object({ links: z.array(linkBody).max(300), reason: z.string().trim().min(3).max(1000) }).strict();

/**
 * Migration 0713: Settings > Register links, on the D60 table `register_links`. Every signed-in user reads it (the record form needs it to draw
 * the pickers); only the System Admin or an all-regions delegate of `settings` edits it, with a reason, the ETag and the audit (the database decides).
 */
@Injectable()
export class RegisterLinksService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT reg_links`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json | null }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT reg_links`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT reg_links`;
      throw p;
    }
  }

  list(): Promise<Json> {
    return this.door(Prisma.sql`SELECT register_link_catalogue() AS r`);
  }

  async save(ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(saveBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const v = ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch);
    return this.door(Prisma.sql`SELECT admin_register_link_catalogue_save(${JSON.stringify(b.links)}::jsonb, ${b.reason}::text, ${v}::int) AS r`);
  }
}
