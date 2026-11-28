import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

type Json = Record<string, unknown>;

const typeChoice = z.object({ in_app: z.boolean().optional(), email: z.boolean().optional() }).strict();
const prefsSchema = z
  .object({
    types: z.record(z.string().min(1).max(80), typeChoice).optional(),
    dnd: z
      .object({
        enabled: z.boolean().optional(),
        start: z.number().int().min(0).max(1439).optional(),
        end: z.number().int().min(0).max(1439).optional(),
        days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        timezone: z.string().max(64).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const snoozeSchema = z.object({ until: z.string().datetime({ offset: true }).nullable() }).strict();
const orgSchema = z
  .object({
    allow_personal: z.boolean().optional(),
    allow_dnd: z.boolean().optional(),
    dedupe_minutes: z.number().int().min(0).max(1440).optional(),
    decision_retention_days: z.number().int().min(1).max(365).optional(),
    reason: z.string().min(3).max(500),
  })
  .strict();

/** Personal notification choices, snooze, test notice and decisions (contract 0.15.531, migration 0583). The database decides; every door works on the caller's own row. */
@Injectable()
export class NotificationPersonalService {
  constructor(private readonly db: DbService) {}

  private async run<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      return rows[0]?.r as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/precondition_failed/.test(msg)) throw new ProblemException(412, 'precondition_failed', { detail: 'The settings changed since you read them. Reload and try again.' });
      if (/wait 30 seconds/.test(msg)) throw new ProblemException(429, 'rate_limited', { detail: 'Wait 30 seconds between tests.' });
      if (/switched off by the administrator/.test(msg)) throw new ProblemException(403, 'field_read_only', { detail: 'The administrator switched personal notification settings off.' });
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  mine(_auth: AuthContext): Promise<Json> {
    return this.run<Json>(Prisma.sql`SELECT notif_my_prefs() AS r`);
  }

  save(_auth: AuthContext, version: number | null, raw: unknown): Promise<Json> {
    const b = parse(prefsSchema, raw);
    const types = b.types === undefined ? null : JSON.stringify(b.types);
    const dnd = b.dnd === undefined ? null : JSON.stringify(b.dnd);
    return this.run<Json>(Prisma.sql`SELECT notif_my_prefs_set(${types}::jsonb, ${dnd}::jsonb, ${version}::integer) AS r`);
  }

  snooze(_auth: AuthContext, raw: unknown): Promise<Json> {
    const b = parse(snoozeSchema, raw);
    return this.run<Json>(Prisma.sql`SELECT notif_my_snooze(${b.until}::timestamptz) AS r`);
  }

  test(_auth: AuthContext): Promise<Json> {
    return this.run<Json>(Prisma.sql`SELECT notif_my_test() AS r`);
  }

  decisions(_auth: AuthContext): Promise<Json> {
    return this.run<Json>(Prisma.sql`SELECT notif_my_decisions(50) AS r`);
  }

  org(_auth: AuthContext): Promise<Json> {
    return this.run<Json>(Prisma.sql`SELECT notif_personal_get() AS r`);
  }

  saveOrg(_auth: AuthContext, version: number | null, raw: unknown): Promise<Json> {
    const { reason, ...cfg } = parse(orgSchema, raw);
    return this.run<Json>(Prisma.sql`SELECT notif_personal_set(${JSON.stringify(cfg)}::jsonb, ${version}::integer, ${reason}::text) AS r`);
  }
}
