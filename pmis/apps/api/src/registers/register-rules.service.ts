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
const rulesBody = z.object({ rules: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.union([z.boolean(), z.string().max(20)])), reason: z.string().trim().min(3).max(1000) }).strict();

/**
 * Migration 0430: the per-register rules (register_definitions.rules) that the database enforces, edited from Settings > Register rules. The database lists the keys that
 * can be edited (register_rule_catalogue), checks the System Admin gate, the reason, the ETag and the type of each value, and audits the change.
 */
@Injectable()
export class RegisterRulesService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT reg_rules`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json | null }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT reg_rules`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT reg_rules`;
      throw p;
    }
  }

  async list(): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT reg_rules_json() AS r`);
  }

  async set(key: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(rulesBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    const v = ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch);
    return this.door(Prisma.sql`SELECT admin_register_rules(${key}::text, ${JSON.stringify(b.rules)}::jsonb, ${b.reason}::text, ${v}::int) AS r`);
  }
}
