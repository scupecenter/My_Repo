import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseIfMatch } from '../common/etag';
import { mapDbError } from '../common/db-errors';
import { problems } from '../common/problem';
import { DbService } from '../db/db.service';

/** Assignment rules (0.15.481, migration 0622): who a level opens to when a rule matches. System Admin only; the database judges it and checks nothing is widened. */
@Injectable()
export class AssignmentRulesService {
  constructor(private readonly db: DbService) {}

  list(): Promise<unknown> {
    return this.call(Prisma.sql`SELECT assignment_rules_json() AS j`);
  }

  create(body: unknown): Promise<unknown> {
    return this.call(Prisma.sql`SELECT assignment_rule_save(NULL::uuid, NULL::integer, ${JSON.stringify(body ?? null)}::jsonb) AS j`);
  }

  update(id: string, ifMatch: string | undefined, body: unknown): Promise<unknown> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw problems.notFound();
    const version = parseIfMatch(ifMatch);
    return this.call(Prisma.sql`SELECT assignment_rule_save(${id}::uuid, ${version}::integer, ${JSON.stringify(body ?? null)}::jsonb) AS j`);
  }

  private async call(sql: Prisma.Sql): Promise<unknown> {
    try {
      const rows = await this.db.tx.$queryRaw<{ j: unknown }[]>(sql);
      return rows[0]?.j ?? null;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }
}
