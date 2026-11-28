import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { limit } from '../ops/ops-limits';

type Json = Record<string, unknown>;

const reason = z.string().trim().min(3).max(1000);
const name = z.string().trim().min(2).max(80);
const createBody = z
  .object({ name_en: name, name_ar: name.nullable().optional(), site_scoped: z.boolean(), multiple_per_site: z.boolean().optional(), reason })
  .strict();
const patchBody = z.object({ name_en: name.optional(), name_ar: name.nullable().optional(), is_active: z.boolean().optional(), reason }).strict();
const enableBody = z.object({ reason }).strict();

interface Row {
  register_key: string;
  module_key: string;
  name_en: string;
  name_ar: string | null;
  site_scoped: boolean;
  multiple_per_site: boolean;
  enabled: boolean;
  is_active: boolean;
  version: number;
  created_at: Date | null;
  field_count: number;
  required_count: number;
  record_count: number;
  template_id: string | null;
}

/**
 * Migration 0531: admin-defined custom registers. A custom register is a row of register_definitions (is_custom) run by the generic register framework: the columns are added with
 * the existing column door (POST /registers/{key}/fields), the records are the ordinary register records. These doors (admin_register_*) create it disabled, rename or hide it
 * and enable it (menu key and upload/download template). System Admin or an all-regions delegate of the custom fields is checked in the database; the API adds the step-up.
 */
@Injectable()
export class CustomRegistersService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT custom_reg`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json | null }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT custom_reg`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT custom_reg`;
      throw p;
    }
  }

  private optionalVersion(ifMatch: string | undefined): number | null {
    return ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch);
  }

  private dto(r: Row): Json {
    return {
      register_key: r.register_key,
      module_key: r.module_key,
      name_en: r.name_en,
      name_ar: r.name_ar,
      site_scoped: r.site_scoped,
      multiple_per_site: r.multiple_per_site,
      enabled: r.enabled,
      is_active: r.is_active,
      version: r.version,
      created_at: r.created_at ? r.created_at.toISOString() : null,
      field_count: Number(r.field_count),
      required_count: Number(r.required_count),
      record_count: Number(r.record_count),
      template_id: r.template_id,
    };
  }

  private async one(key: string): Promise<Json> {
    const rows = await this.read(key);
    const r = rows[0];
    if (!r) throw new ProblemException(404, 'not_found', { detail: 'This is not a custom register.' });
    return this.dto(r);
  }

  private read(key: string | null): Promise<Row[]> {
    return this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT d.register_key, d.module_key, d.name_en, d.name_ar, d.site_scoped, d.multiple_per_site, d.enabled, d.is_active, d.version, d.created_at,
             (SELECT count(*) FROM register_fields f WHERE f.register_key = d.register_key AND f.is_active)::int AS field_count,
             (SELECT count(*) FROM register_fields f WHERE f.register_key = d.register_key AND f.is_active AND f.required)::int AS required_count,
             (SELECT count(*) FROM register_records r WHERE r.register_key = d.register_key AND r.state <> 'voided')::int AS record_count,
             (SELECT t.template_id FROM template_definitions t WHERE t.register_key = d.register_key AND t.kind = 'register' LIMIT 1) AS template_id
        FROM register_definitions d
       WHERE d.is_custom ${key === null ? Prisma.empty : Prisma.sql`AND d.register_key = ${key}`}
       ORDER BY d.sort_order, d.register_key`);
  }

  /** GET /custom-registers: the custom registers (hidden ones too) with their usage, and the limit. */
  async list(): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    const rows = await this.read(null);
    return { items: rows.map((r) => this.dto(r)), limit: { max: limit('registers.custom_max'), active: rows.filter((r) => r.is_active).length } };
  }

  async get(key: string): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    return this.one(key);
  }

  async create(auth: AuthContext, raw: unknown): Promise<Json> {
    const b = parse(createBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    await this.stepUp.require(auth);
    const multiple = b.multiple_per_site ?? true;
    const made = await this.door(
      Prisma.sql`SELECT admin_register_create(${b.name_en}::text, ${b.name_ar ?? null}::text, ${b.site_scoped}::boolean, ${multiple}::boolean, ${b.reason}::text) AS r`,
    );
    return this.one(String(made.register_key));
  }

  /** Rename, hide or show. Hiding and showing need a fresh step-up; nothing is deleted. */
  async update(auth: AuthContext, key: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(patchBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    if (b.is_active !== undefined) await this.stepUp.require(auth);
    const { reason: why, ...patch } = b;
    await this.door(Prisma.sql`SELECT admin_register_update(${key}::text, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${this.optionalVersion(ifMatch)}::int) AS r`);
    return this.one(key);
  }

  /** Enable: the register must have columns and a required column; the menu key and the template are issued. */
  async enable(auth: AuthContext, key: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(enableBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    await this.stepUp.require(auth);
    await this.door(Prisma.sql`SELECT admin_register_enable(${key}::text, ${b.reason}::text, ${this.optionalVersion(ifMatch)}::int) AS r`);
    return this.one(key);
  }
}
