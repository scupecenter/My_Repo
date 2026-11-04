import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { boolParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const CODE = /^[A-Z][A-Za-z0-9]{1,40}$/;
const reason = z.string().trim().min(3).max(1000);
const text = (max: number) => z.string().trim().min(1).max(max);
const catalogueCreate = z
  .object({
    code: z.string().regex(CODE),
    name_en: z.string().trim().min(2).max(200),
    name_ar: text(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    critical: z.boolean().optional(),
    allow_other: z.boolean().optional(),
    reason,
  })
  .strict();
const cataloguePatch = z
  .object({
    name_en: z.string().trim().min(2).max(200).optional(),
    name_ar: text(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    critical: z.boolean().optional(),
    status: z.enum(['pending', 'confirmed']).optional(),
    allow_other: z.boolean().optional(),
    is_active: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine((b) => Object.keys(b).length >= 2, { message: 'Change at least one field.', path: [] });
const valueFields = {
  label_en: text(200).optional(),
  label_ar: text(200).nullable().optional(),
  aliases: z.array(text(80)).max(20).optional(),
  groups: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_ -]{0,30}$/)).max(10).optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
  is_active: z.boolean().optional(),
  reason,
};
const valueCreate = z.object({ code: z.string().min(1).max(80), ...valueFields }).strict();
const valuePatch = z
  .object(valueFields)
  .strict()
  .refine((b) => Object.keys(b).length >= 2, { message: 'Change at least one field.', path: [] });

interface CatalogueRow {
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  critical: boolean;
  status: string;
  allow_other: boolean;
  is_active: boolean;
  version: number;
}
interface ValueRow {
  catalogue_code: string;
  id: string;
  code: string;
  label_en: string;
  label_ar: string | null;
  aliases: string[];
  groups: string[];
  sort_order: number;
  is_active: boolean;
  version: number;
}

/**
 * The list catalogue (Q104, migration 0057): every list of a register is data. Anyone signed in reads it (the values appear in the forms); the System
 * Admin or a delegate of `fields` edit for all regions writes it through admin_save_list_catalogue / admin_save_list_value, which the database checks again.
 */
@Injectable()
export class ListCataloguesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async rows(code: string | null, inactive: boolean): Promise<Record<string, unknown>[]> {
    const cats = await this.db.tx.$queryRaw<CatalogueRow[]>(Prisma.sql`
      SELECT code, name_en, name_ar, description, critical, status, allow_other, is_active, version FROM list_catalogues
      WHERE ${code === null ? Prisma.sql`true` : Prisma.sql`code = ${code}`} ${inactive ? Prisma.empty : Prisma.sql`AND is_active`}
      ORDER BY code COLLATE "C"`);
    if (cats.length === 0) return [];
    const codes = cats.map((c) => c.code);
    const values = await this.db.tx.$queryRaw<ValueRow[]>(Prisma.sql`
      SELECT catalogue_code, id::text AS id, code, label_en, label_ar, aliases, groups, sort_order, is_active, version FROM list_values
      WHERE catalogue_code = ANY(${codes}::text[]) ${inactive ? Prisma.empty : Prisma.sql`AND is_active`}
      ORDER BY catalogue_code, sort_order, code COLLATE "C"`);
    const used = await this.db.tx.$queryRaw<{ catalogue: string; register_key: string; field_code: string; col: string | null }[]>(Prisma.sql`
      SELECT f.list_catalogue AS catalogue, f.register_key, f.code AS field_code, NULL::text AS col FROM register_fields f
      WHERE f.is_active AND f.list_catalogue = ANY(${codes}::text[])
      UNION ALL
      SELECT c ->> 'list_catalogue', f.register_key, f.code, c ->> 'code' FROM register_fields f, jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) c
      WHERE f.is_active AND f.field_type = 'child_list' AND c ->> 'list_catalogue' = ANY(${codes}::text[])
      ORDER BY 2, 3`);
    return cats.map((c) => ({
      ...c,
      values: values.filter((v) => v.catalogue_code === c.code).map((v) => ({ id: v.id, code: v.code, label_en: v.label_en, label_ar: v.label_ar, aliases: v.aliases, groups: v.groups, sort_order: v.sort_order, is_active: v.is_active, version: v.version })),
      used_by: used.filter((u) => u.catalogue === c.code).map((u) => ({ register_key: u.register_key, field_code: u.field_code, ...(u.col ? { column: u.col } : {}) })),
    }));
  }

  async list(q: Query): Promise<{ items: Record<string, unknown>[] }> {
    return { items: await this.rows(null, boolParam(q, 'include_inactive') === true) };
  }

  async get(code: string): Promise<Record<string, unknown>> {
    if (!CODE.test(code)) throw problems.notFound('The list does not exist.');
    const [row] = await this.rows(code, true);
    if (!row) throw problems.notFound('The list does not exist.');
    return row;
  }

  private async call(sql: Prisma.Sql): Promise<void> {
    await this.db.tx.$executeRaw`SAVEPOINT list_call`;
    try {
      await this.db.tx.$queryRaw(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT list_call`;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT list_call`;
      throw p;
    }
  }

  async create(raw: unknown): Promise<Record<string, unknown>> {
    await this.access.requireAdmin('fields', 'edit');
    const { code, reason: why, ...b } = parse(catalogueCreate, raw);
    await this.call(Prisma.sql`SELECT admin_save_list_catalogue(${code}::text, true, ${JSON.stringify(b)}::jsonb, ${why}::text, NULL::int)`);
    return this.get(code);
  }

  async update(code: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin('fields', 'edit');
    await this.get(code);
    const { reason: why, ...b } = parse(cataloguePatch, raw);
    await this.call(Prisma.sql`SELECT admin_save_list_catalogue(${code}::text, false, ${JSON.stringify(b)}::jsonb, ${why}::text, ${version}::int)`);
    return this.get(code);
  }

  async addValue(code: string, raw: unknown): Promise<Record<string, unknown>> {
    await this.access.requireAdmin('fields', 'edit');
    await this.get(code);
    const { reason: why, ...b } = parse(valueCreate, raw);
    await this.call(Prisma.sql`SELECT admin_save_list_value(${code}::text, NULL::uuid, ${JSON.stringify(b)}::jsonb, ${why}::text, NULL::int)`);
    return this.get(code);
  }

  async updateValue(code: string, rawId: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin('fields', 'edit');
    await this.get(code);
    if (!uuidSchema.safeParse(rawId).success) throw problems.notFound('The value does not exist in this list.');
    const { reason: why, ...b } = parse(valuePatch, raw);
    await this.call(Prisma.sql`SELECT admin_save_list_value(${code}::text, ${rawId}::uuid, ${JSON.stringify(b)}::jsonb, ${why}::text, ${version}::int)`);
    return this.get(code);
  }
}
