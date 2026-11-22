import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import {
  buildColumnBands,
  createColumnBody,
  parseIncludeInactive,
  previewBody,
  reasonBody,
  SITE360_COLUMN_TYPES,
  updateColumnBody,
  type ColumnAdminRow,
  type ColumnBand,
} from './site360-columns';

type Json = Record<string, unknown>;

export interface Site360ColumnListDto {
  items: (ColumnAdminRow & Json)[];
  bands: ColumnBand[];
  types: readonly string[];
}

/**
 * Workflow Studio S2 (contract 0.15.43, migration 0133): the admin of the Site Master columns. Every rule (who may, the protected columns, the placement,
 * the type conversion, the ETag, the audit) is in the SECURITY DEFINER doors site360_column_*; this service checks the permission before the step-up (a plain
 * user gets 403, not 401), parses the request, adds the step-up and translates the database refusals.
 */
@Injectable()
export class Site360ColumnsService {
  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
  ) {}

  /** The doors answer the refusals of the database as problems; a refused statement is rolled back to a savepoint so the request transaction stays usable. */
  private async door<T>(sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT s360_cols`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T | null }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT s360_cols`;
      return (rows[0]?.r ?? {}) as T;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT s360_cols`;
      throw p;
    }
  }

  /** System Admin, or a delegate of `fields` edit for all regions (the same test as the doors). */
  private async requireAdmin(): Promise<void> {
    const r = await this.db.tx.$queryRaw<
      { ok: boolean | null }[]
    >`SELECT site360_col_can_admin() AS ok`;
    if (r[0]?.ok !== true)
      throw new ProblemException(403, 'action_forbidden', {
        detail:
          'Only a System Admin, or a delegate of the custom fields for all regions, manages the Master columns.',
      });
  }

  private ord(raw: unknown): number {
    const s = typeof raw === 'string' ? raw : '';
    const n = /^[0-9]{1,4}$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 1000)
      throw problems.validation([
        {
          path: '/ord',
          code: 'invalid',
          message: 'The column order is 1 to 1000.',
        },
      ]);
    return n;
  }

  async list(q: Record<string, unknown>): Promise<Site360ColumnListDto> {
    const inc = parseIncludeInactive(q.include_inactive);
    if (inc === null)
      throw problems.validation([
        {
          path: '/include_inactive',
          code: 'invalid',
          message: 'true or false.',
        },
      ]);
    await this.requireAdmin();
    const items = await this.door<(ColumnAdminRow & Json)[]>(
      Prisma.sql`SELECT site360_columns_list(${inc}::boolean) AS r`,
    );
    const list = Array.isArray(items) ? items : [];
    return {
      items: list,
      bands: buildColumnBands(list),
      types: SITE360_COLUMN_TYPES,
    };
  }

  async get(rawOrd: unknown): Promise<Json> {
    const ord = this.ord(rawOrd);
    await this.requireAdmin();
    return this.door<Json>(
      Prisma.sql`SELECT site360_column_get(${ord}::integer) AS r`,
    );
  }

  async preview(rawOrd: unknown, raw: unknown): Promise<Json> {
    const ord = this.ord(rawOrd);
    const b = parse(previewBody, raw);
    await this.requireAdmin();
    return this.door<Json>(
      Prisma.sql`SELECT site360_column_type_preview(${ord}::integer, ${b.value_type}::text, ${b.list_catalogue ?? null}::text) AS r`,
    );
  }

  async create(auth: AuthContext, raw: unknown): Promise<Json> {
    const b = parse(createColumnBody, raw);
    await this.requireAdmin();
    await this.stepUp.require(auth);
    const { reason, ...body } = b;
    return this.door<Json>(
      Prisma.sql`SELECT site360_column_create(${JSON.stringify(body)}::jsonb, ${reason}::text) AS r`,
    );
  }

  async update(
    auth: AuthContext,
    rawOrd: unknown,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<Json> {
    const ord = this.ord(rawOrd);
    const b = parse(updateColumnBody, raw);
    await this.requireAdmin();
    const version = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    const { reason, confirm_unconvertible: confirm, ...patch } = b;
    return this.door<Json>(
      Prisma.sql`SELECT site360_column_update(${ord}::integer, ${version}::integer, ${JSON.stringify(patch)}::jsonb, ${confirm ?? false}::boolean, ${reason}::text) AS r`,
    );
  }

  async setActive(
    auth: AuthContext,
    rawOrd: unknown,
    ifMatch: string | undefined,
    raw: unknown,
    active: boolean,
  ): Promise<Json> {
    const ord = this.ord(rawOrd);
    const b = parse(reasonBody, raw);
    await this.requireAdmin();
    const version = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.door<Json>(
      Prisma.sql`SELECT site360_column_set_active(${ord}::integer, ${version}::integer, ${active}::boolean, ${b.reason}::text) AS r`,
    );
  }

  async remove(
    auth: AuthContext,
    rawOrd: unknown,
    ifMatch: string | undefined,
    q: Record<string, unknown>,
  ): Promise<Json> {
    const ord = this.ord(rawOrd);
    const b = parse(reasonBody, { reason: q.reason });
    await this.requireAdmin();
    const version = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.door<Json>(
      Prisma.sql`SELECT site360_column_delete(${ord}::integer, ${version}::integer, ${b.reason}::text) AS r`,
    );
  }
}
