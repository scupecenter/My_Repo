import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { ListCataloguesService } from './list-catalogues.service';

type Json = Record<string, unknown>;

export const COLUMN_TYPES = [
  'text', 'long_text', 'number', 'currency', 'percentage', 'date', 'datetime', 'yes_no', 'list', 'multi_list', 'user', 'multi_user', 'site', 'multi_site',
  'external_party', 'warehouse_item', 'email', 'phone', 'link', 'document', 'computed', 'child_list',
] as const;

const reason = z.string().trim().min(3).max(1000);
const label = z.string().trim().min(1).max(200);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const formula = z.object({ op: z.enum(['sum', 'diff', 'product', 'ratio', 'days_between']), a: code, b: code }).strict();
const newList = z.object({
  code: z.string().regex(/^[A-Z][A-Za-z0-9]{1,40}$/).optional(), name_en: z.string().trim().min(2).max(200), name_ar: label.nullable().optional(),
  values: z.array(z.object({ label_en: label, label_ar: label.nullable().optional() }).strict()).min(1).max(200),
}).strict();
const visibility = { in_list: z.boolean().optional(), in_filter: z.boolean().optional(), in_template: z.boolean().optional(), in_export: z.boolean().optional() };
const fieldBase = {
  label_en: label.optional(), label_ar: label.nullable().optional(), required: z.boolean().optional(), section: z.string().trim().min(1).max(120).nullable().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(), list_catalogue: z.string().min(1).max(60).nullable().optional(), formula: formula.optional(), ...visibility,
  columns: z.array(z.record(z.string(), z.unknown())).min(1).max(30).optional(),
};
const createBody = z.object({ ...fieldBase, label_en: label, code, field_type: z.enum(COLUMN_TYPES), new_list: newList.optional(), reason }).strict();
const patchBody = z.object({ field_type: z.enum(COLUMN_TYPES).optional(), is_active: z.boolean().optional(), new_list: newList.optional(), confirm_conversion: z.boolean().optional(), reason, ...fieldBase }).strict();
const deleteBody = z.object({ reason }).strict();
const orderBody = z.object({ codes: z.array(code).min(1).max(500), reason }).strict();
const sectionCreate = z.object({ name_en: label, name_ar: label.nullable().optional(), sort_order: z.number().int().min(0).max(100000).optional(), reason }).strict();
const sectionPatch = z.object({ name_en: label.optional(), name_ar: label.nullable().optional(), sort_order: z.number().int().min(0).max(100000).optional(), reason }).strict();
const renameBody = z.object({ name_en: label.optional(), name_ar: label.nullable().optional(), reason }).strict();

const slug = (s: string, max: number): string => s.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('').slice(0, max);

/**
 * Migration 0095: the admin manages the columns, sections and names of every register. Every write is a definer door (admin_reg_*) that checks the System Admin or the
 * delegate of `fields.edit` for all regions, the reason, the ETag, the protected columns and the audit. The API adds the step-up (a delete, a deactivation and a type
 * change), the creation of a new list in the same step and the translation of the database refusals.
 */
@Injectable()
export class RegisterColumnsService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService, private readonly lists: ListCataloguesService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT reg_cols`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json | null }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT reg_cols`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT reg_cols`;
      throw p;
    }
  }

  private optionalVersion(ifMatch: string | undefined): number | null {
    return ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch);
  }

  async screen(key: string): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT reg_fields_admin_json(${key}::text) AS r`);
  }

  /** The list of the new column: an existing catalogue, or a new one with its values (created in the same transaction). */
  private async resolveList(b: { list_catalogue?: string | null; new_list?: z.infer<typeof newList> }, why: string): Promise<string | null | undefined> {
    if (!b.new_list) return b.list_catalogue;
    const nl = b.new_list;
    const lcode = nl.code ?? (slug(nl.name_en, 38) || 'List') + Math.random().toString(36).slice(2, 5).toUpperCase();
    const c = /^[A-Z]/.test(lcode) ? lcode : `L${lcode}`;
    await this.lists.create({ code: c, name_en: nl.name_en, name_ar: nl.name_ar ?? undefined, reason: why });
    const seen = new Set<string>();
    for (const [i, v] of nl.values.entries()) {
      let vc = slug(v.label_en, 40) || `V${i + 1}`;
      while (seen.has(vc.toLowerCase())) vc = `${vc}${i + 1}`;
      seen.add(vc.toLowerCase());
      await this.lists.addValue(c, { code: vc, label_en: v.label_en, label_ar: v.label_ar ?? undefined, sort_order: (i + 1) * 10, reason: why });
    }
    return c;
  }

  async impact(key: string, field: string, q: { field_type?: string; list_catalogue?: string; required?: string }): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    if (q.field_type !== undefined && !(COLUMN_TYPES as readonly string[]).includes(q.field_type)) throw problems.validation([{ path: '/field_type', code: 'invalid', message: 'Not a column type.' }]);
    const patch: Json = {};
    if (q.field_type !== undefined) patch.field_type = q.field_type;
    if (q.list_catalogue !== undefined) patch.list_catalogue = q.list_catalogue;
    if (q.required !== undefined) patch.required = q.required === 'true';
    return this.door(Prisma.sql`SELECT admin_reg_field_impact(${key}::text, ${field}::text, ${JSON.stringify(patch)}::jsonb) AS r`);
  }

  async create(key: string, raw: unknown): Promise<Json> {
    const b = parse(createBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    const { code: c, reason: why, ...rest } = b;
    const catalogue = await this.resolveList(b, why);
    const patch: Json = { ...rest };
    delete patch.new_list;
    if (catalogue !== undefined) patch.list_catalogue = catalogue;
    return this.door(Prisma.sql`SELECT admin_reg_field_save(${key}::text, ${c}::text, true, ${JSON.stringify(patch)}::jsonb, ${why}::text, NULL::int, false) AS r`);
  }

  /** A type change, a change of list, a deactivation and a reactivation need a fresh step-up; the database decides the rest (protected columns, conversion). */
  async update(auth: AuthContext, key: string, field: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(patchBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    const version = this.optionalVersion(ifMatch);
    const { reason: why, confirm_conversion: confirm, ...rest } = b;
    if (b.field_type !== undefined || b.list_catalogue !== undefined || b.new_list !== undefined || b.is_active !== undefined) await this.stepUp.require(auth);
    const catalogue = await this.resolveList(b, why);
    const patch: Json = { ...rest };
    if (catalogue !== undefined) patch.list_catalogue = catalogue;
    return this.door(Prisma.sql`SELECT admin_reg_field_save(${key}::text, ${field}::text, false, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${version}::int, ${confirm ?? false}::boolean) AS r`);
  }

  /** Hard delete when no record ever held a value; otherwise the column is deactivated with the reason (the answer says which). */
  async remove(auth: AuthContext, key: string, field: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(deleteBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    const version = this.optionalVersion(ifMatch);
    await this.stepUp.require(auth);
    return this.door(Prisma.sql`SELECT admin_reg_field_delete(${key}::text, ${field}::text, ${b.reason}::text, ${version}::int) AS r`);
  }

  async order(key: string, raw: unknown): Promise<Json> {
    const b = parse(orderBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT admin_reg_fields_order(${key}::text, ${b.codes}::text[], ${b.reason}::text) AS r`);
  }

  async createSection(key: string, raw: unknown): Promise<Json> {
    const { reason: why, ...b } = parse(sectionCreate, raw);
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT admin_reg_section_save(${key}::text, NULL::uuid, ${JSON.stringify(b)}::jsonb, ${why}::text, NULL::int) AS r`);
  }

  async updateSection(key: string, id: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The section does not exist in this register.');
    const { reason: why, ...b } = parse(sectionPatch, raw);
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT admin_reg_section_save(${key}::text, ${id}::uuid, ${JSON.stringify(b)}::jsonb, ${why}::text, ${this.optionalVersion(ifMatch)}::int) AS r`);
  }

  async deleteSection(key: string, id: string, raw: unknown): Promise<Json> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The section does not exist in this register.');
    const b = parse(deleteBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT admin_reg_section_delete(${key}::text, ${id}::uuid, ${b.reason}::text) AS r`);
  }

  async rename(key: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const { reason: why, ...b } = parse(renameBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT admin_reg_definition_rename(${key}::text, ${JSON.stringify(b)}::jsonb, ${why}::text, ${this.optionalVersion(ifMatch)}::int) AS r`);
  }
}
