import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

/** The contract names (CustomFieldEntity) and the database enum (FieldEntityType). Types with no contract name (warehouse_serial) are not listed. */
const TO_CONTRACT: Record<string, string> = {
  site: 'site', milestone: 'milestone', gate: 'gate', task_instance: 'task', rf_design: 'rf_design', acquisition: 'acquisition', procurement: 'procurement',
  external_party: 'contractors', gecol: 'gecol', hlc: 'hlc', permit: 'permits_hse', warehouse_item: 'warehouse', quality: 'quality', issue: 'issues', risk: 'risks',
  change_request: 'change_control', readiness: 'readiness_handover', as_built: 'as_built', meeting: 'meetings',
};
const TO_DB = Object.fromEntries(Object.entries(TO_CONTRACT).map(([db, c]) => [c, db]));

const query = z.object({
  entity_type: z.enum(Object.keys(TO_DB) as [string, ...string[]]).optional(),
  task_code: z.string().trim().min(1).max(80).optional(),
  include_inactive: z.enum(['true', 'false']).optional(),
}).strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string; entity_type: string; task_code: string | null; code: string; label_en: string; label_ar: string | null; data_type: string; required: boolean;
  validation: unknown; default_value: unknown; section: string | null; sort_order: number; in_templates: boolean; in_exports: boolean; in_list_filters: boolean;
  master_export_column: string | null; is_active: boolean; version: number; list_values: { value: string; label_en: string; label_ar: string | null; is_active: boolean }[] | null;
  visible_to: string[] | null; editable_by: string[] | null; has_values: boolean | null;
}

/**
 * GET /custom-fields and /custom-fields/{id}: the field definitions of the sites, tasks, milestones, gates and registers (table field_definitions, list values in
 * field_list_values). Everyone who is signed in reads the active fields the caller's field rules do not hide (app_resolve_field_access, the same rule as the
 * records themselves). Inactive fields and the role lists (who sees and who edits a field) are for a System Admin or a delegate of the custom fields for all
 * regions (site_master_col_can_admin, the rule of the Master column doors). Writes stay with admin_save_field, which is not built yet (the contract lists them).
 */
@Injectable()
export class CustomFieldsService {
  constructor(private readonly db: DbService) {}

  private async isAdmin(): Promise<boolean> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean | null }[]>(Prisma.sql`SELECT site_master_col_can_admin() AS ok`);
    return r[0]?.ok === true;
  }

  private async rows(where: Prisma.Sql, admin: boolean): Promise<Row[]> {
    return this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT fd.id::text AS id, fd.entity_type::text AS entity_type, fd.task_code, fd.code, fd.label_en, fd.label_ar, fd.data_type::text AS data_type, fd.required,
        fd.validation, fd.default_value, fd.section, fd.sort_order, fd.in_templates, fd.in_exports, fd.in_list_filters, fd.master_export_column, fd.is_active, fd.version,
        (SELECT jsonb_agg(jsonb_build_object('value', l.code, 'label_en', l.label_en, 'label_ar', l.label_ar, 'is_active', l.is_active) ORDER BY l.sort_order, l.code)
           FROM field_list_values l WHERE l.field_id = fd.id) AS list_values,
        CASE WHEN ${admin} THEN (SELECT coalesce(array_agg(p.role_id::text ORDER BY p.role_id::text), '{}') FROM field_permissions p WHERE p.field_id = fd.id AND p.role_id IS NOT NULL AND p.access::text IN ('read', 'edit')) END AS visible_to,
        CASE WHEN ${admin} THEN (SELECT coalesce(array_agg(p.role_id::text ORDER BY p.role_id::text), '{}') FROM field_permissions p WHERE p.field_id = fd.id AND p.role_id IS NOT NULL AND p.access::text = 'edit') END AS editable_by,
        NULL::boolean AS has_values
      FROM field_definitions fd
      WHERE fd.entity_type::text = ANY(${Object.keys(TO_CONTRACT)}::text[])
        AND coalesce(app_resolve_field_access(app_actor(), fd.id)::text, 'edit') <> 'hidden' AND ${where}
      ORDER BY fd.entity_type::text, fd.sort_order, fd.code COLLATE "C"`);
  }

  private dto(r: Row) {
    return {
      id: r.id, entity_type: TO_CONTRACT[r.entity_type]!, task_code: r.task_code, code: r.code, label_en: r.label_en, label_ar: r.label_ar, data_type: r.data_type === 'bool' ? 'yes_no' : r.data_type,
      required: r.required, ...(r.validation ? { validation: r.validation } : {}), ...(r.default_value !== null && r.default_value !== undefined ? { default_value: r.default_value } : {}),
      section: r.section, sort_order: r.sort_order, ...(r.list_values ? { list_values: r.list_values } : {}),
      ...(r.visible_to ? { visible_to_role_ids: r.visible_to } : {}), ...(r.editable_by ? { editable_by_role_ids: r.editable_by } : {}),
      in_templates: r.in_templates, in_exports: r.in_exports, in_list_filters: r.in_list_filters, master_export_column: r.master_export_column,
      is_active: r.is_active, ...(r.has_values === null ? {} : { has_values: r.has_values }), version: r.version,
    };
  }

  /** GET /custom-fields */
  async list(_auth: AuthContext, raw: Record<string, unknown>) {
    const q = parse(query, raw);
    const admin = await this.isAdmin();
    const inactive = q.include_inactive === 'true';
    if (inactive && !admin) throw problems.forbidden('action_forbidden', 'Only a System Admin, or a delegate of the custom fields for all regions, reads the inactive fields.');
    const where = Prisma.sql`(${inactive} OR fd.is_active)
      AND (${q.entity_type ?? null}::text IS NULL OR fd.entity_type::text = ${q.entity_type ? TO_DB[q.entity_type] : null}::text)
      AND (${q.task_code ?? null}::text IS NULL OR fd.task_code = ${q.task_code ?? null}::text)`;
    const rows = await this.rows(where, admin);
    const v = await this.db.tx.$queryRaw<{ v: number }[]>(Prisma.sql`SELECT (coalesce(sum(version), 0) + count(*))::int AS v FROM field_definitions`);
    return { items: rows.map((r) => this.dto(r)), field_set_version: v[0]?.v ?? 0 };
  }

  /** GET /custom-fields/{id} */
  async one(_auth: AuthContext, id: string) {
    if (!UUID.test(id)) throw problems.notFound();
    const admin = await this.isAdmin();
    const rows = await this.rows(Prisma.sql`fd.id = ${id}::uuid AND (fd.is_active OR ${admin})`, admin);
    if (!rows[0]) throw problems.notFound();
    return this.dto(rows[0]);
  }
}
