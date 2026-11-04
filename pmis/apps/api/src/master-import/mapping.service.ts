import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { ProblemException, problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

/**
 * Q207: the template mapping screen (the task fields the stream templates and the Master sheet carry), and Q8 / Q10: the role and region aliases the
 * legacy import uses. Reads need view on templates; the writes are decided by the database (templates edit for all regions, a reason, audited).
 */

const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'] as const;

const change = z
  .object({
    op: z.enum(['upsert', 'deactivate']),
    task_code: z.string().min(1).max(20),
    field_key: z.string().min(1).max(110),
    label: z.string().max(80).optional(),
    label_ar: z.string().max(80).nullable().optional(),
    field_type: z.enum(['text', 'number', 'date', 'list', 'yes_no']).optional(),
    options: z.array(z.string().min(1).max(80)).max(50).nullable().optional(),
    master_col: z.string().regex(/^[A-Z]{1,3}$/).nullable().optional(),
    read_only: z.boolean().optional(),
    scenarios: z.array(z.enum(SCENARIOS)).min(1).max(5).nullable().optional(),
    projection: z.enum(['earliest', 'latest']).nullable().optional(),
  })
  .strict();
const mappingBody = z.object({ changes: z.array(change).min(1).max(200), reason: z.string().max(500), dry_run: z.boolean().default(false) }).strict();

const aliasBody = z
  .object({
    kind: z.enum(['region', 'role']),
    alias: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(80).optional(),
    target: z.string().max(60).nullable().optional(),
    status: z.enum(['ambiguous', 'unmapped']).optional(),
    is_active: z.boolean().default(true),
    note: z.string().max(500).nullable().optional(),
    reason: z.string().max(500),
  })
  .strict();

@Injectable()
export class MappingService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async call<T>(sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT map_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT map_call`;
      return rows[0]?.r as T;
    } catch (e) {
      const p = e instanceof ProblemException ? e : mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT map_call`;
      throw p;
    }
  }

  private async canEdit(): Promise<boolean> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT app_can('templates', 'edit') AS ok`);
    return r[0]?.ok === true;
  }

  /** GET /template-mapping: every task field (active and not), the Master columns a field may fill, and the tasks of the workflow in force. */
  async get(auth: AuthContext): Promise<Record<string, unknown>> {
    await this.access.requireModuleView(auth, 'templates');
    const fields = await this.db.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT f.id::text AS id, f.task_code, f.field_key, f.label, f.label_ar, f.field_type, f.options, f.master_col, m.header AS master_header, f.read_only, f.is_active,
        f.scenarios, f.projection, f.list_catalogue
      FROM template_task_fields f LEFT JOIN master_columns m ON m.letter = f.master_col
      ORDER BY coalesce(m.ord, 5000), f.task_code COLLATE "C", f.field_key COLLATE "C"`);
    const columns = await this.db.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT m.letter, m.header, m.owner, (SELECT count(*)::int FROM template_task_fields f WHERE f.master_col = m.letter AND f.is_active) AS fields
      FROM master_columns m WHERE m.is_active ORDER BY m.ord`);
    const tasks = await this.db.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT td.code, td.name_en, td.name_ar, sd.stream_code AS stream, tpl_task_mode(td.code) AS mode
      FROM task_definitions td JOIN stage_definitions sd ON sd.id = td.stage_id AND sd.workflow_id = td.workflow_id
      WHERE td.workflow_id = tpl_active_workflow() AND td.is_active ORDER BY sd.seq, td.sort_order, td.code COLLATE "C"`);
    return { fields, master_columns: columns, tasks, can_edit: await this.canEdit() };
  }

  /** POST /template-mapping: test (dry_run) or save. */
  async save(auth: AuthContext, raw: unknown): Promise<Record<string, unknown>> {
    await this.access.requireModuleView(auth, 'templates');
    const body = parse(mappingBody, raw);
    const r = await this.call<Record<string, unknown>>(Prisma.sql`SELECT tpl_mapping_save(${JSON.stringify(body.changes)}::jsonb, ${body.reason}::text, ${body.dry_run}::boolean) AS r`);
    return r;
  }

  /** GET /import-aliases?kind=region|role */
  async aliases(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[]; can_edit: boolean }> {
    await this.access.requireModuleView(auth, 'templates');
    const kind = oneParam(q, 'kind') ?? 'region';
    if (kind !== 'region' && kind !== 'role') throw problems.validation([{ path: '/kind', code: 'invalid', message: 'kind is region or role.' }]);
    const items = kind === 'region'
      ? await this.db.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
          SELECT 'region' AS kind, a.alias, a.label, a.region_id::text AS target, r.name_en AS target_name, 'mapped' AS status, a.is_active, a.note, a.updated_at
          FROM region_aliases a JOIN regions r ON r.id = a.region_id ORDER BY r.id, a.alias`)
      : await this.db.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
          SELECT 'role' AS kind, a.alias, a.label, ro.code AS target, ro.name_en AS target_name, a.status, a.is_active, a.note, a.updated_at
          FROM role_aliases a LEFT JOIN roles ro ON ro.id = a.role_id ORDER BY a.label`);
    return { items, can_edit: await this.canEdit() };
  }

  /** PUT /import-aliases: one alias (create or change). */
  async saveAlias(auth: AuthContext, raw: unknown): Promise<Record<string, unknown>> {
    await this.access.requireModuleView(auth, 'templates');
    const b = parse(aliasBody, raw);
    await this.call<Record<string, unknown>>(Prisma.sql`
      SELECT imp_alias_save(${b.kind}::text, ${b.alias}::text, ${b.label ?? b.alias}::text, ${b.target ?? null}::text, ${b.status ?? null}::text, ${b.is_active}::boolean,
        ${b.note ?? null}::text, ${b.reason}::text) AS r`);
    const list = await this.aliases(auth, { kind: b.kind });
    const item = list.items.find((x) => (x as { alias: string }).alias === b.alias.trim().toLowerCase());
    if (!item) throw problems.notFound();
    return item as Record<string, unknown>;
  }
}
