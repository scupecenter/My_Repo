import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService, DbAction } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, decodeTypedCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { TS_TEXT, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { setVia, viaSchema } from '../common/via';
import { resolveMentions } from '../common/mentions';
import { DocumentsService } from '../documents/documents.service';
import { WorkflowService } from '../workflow/workflow.service';
import { MatrixAssigneeDto, TaskViewService, UserRefDto, accountStatus, levelCode } from '../workflow/task-view.service';

export type RegisterTransition = 'submit' | 'review' | 'approve' | 'reject';

export interface TransitionInfo {
  step_ids: string[];
  skipped_levels: number[];
  unlocked_task_ids: string[];
  votes_missing?: number;
  returned_to_level?: number;
}

const STATES = ['entry', 'in_review', 'in_approval', 'approved', 'voided'];
const OPEN_STATES = ['entry', 'in_review', 'in_approval'];

const createSchema = z
  .object({
    site_id: z.string().uuid().optional(),
    record_type: z.string().min(1).max(40).optional(),
    data: z.record(z.unknown()),
    custom: z.record(z.unknown()).optional(),
    external_party_id: z.string().uuid().nullable().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    data: z.record(z.unknown()).optional(),
    custom: z.record(z.unknown()).optional(),
    external_party_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field');
const noteSchema = z
  .object({
    note: z.string().max(2000).optional(),
    via: viaSchema.optional(),
    // Q131: a rejection may name document slots of the record, as for a task (RejectRequest.rejected_slots)
    rejected_slots: z.array(z.object({ slot_id: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict()).max(100).optional(),
  })
  .strict();
const commentSchema = z.object({ body: z.string().trim().min(1).max(4000), mention_user_ids: z.array(z.string().uuid()).max(20).optional() }).strict();
const transferSchema = z.object({ note: z.string().trim().max(2000).optional() }).strict();
const convertSchema = z
  .object({
    values: z
      .object({
        organiser: z.string().uuid().optional(),
        attendee_users: z.array(z.string().uuid()).max(200).optional(),
        linked_site_ids: z.array(z.string().uuid()).max(500).optional(),
        action_items_list: z.array(z.record(z.unknown())).max(200).optional(),
      })
      .strict(),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(2000), confirm_text: z.string().optional() }).passthrough();
const cancelSnagSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

interface RecordRow {
  id: string;
  entity_id: string;
  version_no: number;
  supersedes_id: string | null;
  is_current: boolean;
  register_key: string;
  record_type: string | null;
  site_id: string | null;
  site_code: string | null;
  region_id: number | null;
  state: string;
  current_level: number;
  levels_required: number;
  n_levels: number;
  pinned: string | null;
  data: Record<string, unknown>;
  custom: Record<string, unknown>;
  external_party_id: string | null;
  return_count: number;
  last_return_note: string | null;
  self_approval: boolean;
  /** 0088: approved directly by the historical Master import (the Admin override badge) */
  historical_direct_approved: boolean;
  task_id: string | null;
  task_code: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  source: string;
  version: number;
  kind: string | null;
  cell_id: string | null;
  rule: string | null;
  has_holder: boolean | null;
  is_holder: boolean | null;
  votes_needed: bigint | null;
  votes_done: bigint | null;
  entry_holder: boolean;
  pin_holds: boolean | null;
  has_open: boolean;
  warnings: unknown[] | null;
  purchase_requests: Record<string, unknown> | null;
  total: bigint | null;
  ts: string;
}

interface DefRow {
  register_key: string;
  name_en: string;
  name_ar: string | null;
  module_key: string;
  site_scoped: boolean;
  multiple_per_site: boolean;
  record_types: string[];
  approval_levels: number;
}

interface FieldRow {
  register_key: string;
  code: string;
  label_en: string;
  label_ar: string | null;
  field_type: string;
  required: boolean;
  derived: boolean;
  options: unknown;
  in_list: boolean;
  section: string | null;
  list_catalogue: string | null;
}

interface ChildColumn { code: string; label_en?: string; label_ar?: string | null; type: string; required?: boolean; list_catalogue?: string }
interface CatalogueInfo {
  ref: { code: string; status: string; critical: boolean; allow_other: boolean };
  options: { value: string; label_en: string; label_ar: string | null; groups?: string[] }[];
  all: Set<string>;
}
const childColumns = (f: { field_type: string; options: unknown }): ChildColumn[] =>
  f.field_type === 'child_list' && f.options && typeof f.options === 'object' && Array.isArray((f.options as { columns?: unknown }).columns)
    ? ((f.options as { columns: ChildColumn[] }).columns)
    : [];
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const FIELD_ENTITY: Record<string, string> = {
  procurement: 'procurement', gecol: 'gecol', hlc: 'hlc', permits_hse: 'permit',
  quality: 'quality', issues: 'issue', risks: 'risk', change_control: 'change_request', readiness_handover: 'readiness',
  as_built: 'as_built', meetings: 'meeting', rf_design: 'rf_design', acquisition: 'acquisition', contractors: 'external_party',
};

/** 0054 (Q220): the streams a permit is entered on, as the `permit_stream` list shows them. */
const PERMIT_STREAMS: Record<string, { label_en: string; label_ar: string }> = {
  CW: { label_en: 'Civil Works (CW)', label_ar: 'الأعمال المدنية (CW)' },
  TE: { label_en: 'Installation (TE)', label_ar: 'التركيب (TE)' },
  ACQ: { label_en: 'Acquisition / RF & Design', label_ar: 'الاستحواذ / التصميم' },
  OM: { label_en: 'O&M', label_ar: 'التشغيل والصيانة' },
};

@Injectable()
export class RegistersService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly view: TaskViewService,
    private readonly workflow: WorkflowService,
    private readonly documents: DocumentsService,
  ) {}

  // ------------------------------------------------------------------ catalogue
  /** The register of the path: it must exist and be enabled (404 otherwise) and the caller must be able to use its module (403). */
  private async definition(key: string): Promise<DefRow> {
    const rows = await this.db.tx.$queryRaw<DefRow[]>(Prisma.sql`
      SELECT register_key, name_en, name_ar, module_key, site_scoped, multiple_per_site, record_types, approval_levels
      FROM register_definitions WHERE register_key = ${key} AND is_active AND enabled`);
    const d = rows[0];
    if (!d) throw problems.notFound('This register does not exist.');
    return d;
  }

  async list(auth: AuthContext): Promise<{ items: unknown[] }> {
    const defs = await this.db.tx.$queryRaw<DefRow[]>(Prisma.sql`
      SELECT register_key, name_en, name_ar, module_key, site_scoped, multiple_per_site, record_types, approval_levels
      FROM register_definitions WHERE is_active AND enabled ORDER BY sort_order`);
    const items: unknown[] = [];
    for (const d of defs) {
      if (!(await this.access.hasGrant(auth, d.module_key, 'view'))) continue;
      const fields = await this.fieldsOf(d.register_key);
      const regs = await this.access.regions(d.module_key, 'view');
      // 0042: a register whose scopes have their own Matrix rows (Procurement, scope HLC) tells the caller which scopes they may enter
      const scopes = await this.db.tx.$queryRaw<{ s: string[] | null }[]>(Prisma.sql`SELECT reg_entry_scopes(${d.register_key}::text) AS s`);
      const cnt = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT count(*) AS n FROM register_records r WHERE r.register_key = ${d.register_key} AND r.state <> 'voided'
          AND NOT EXISTS (SELECT 1 FROM register_records x WHERE x.entity_id = r.entity_id AND x.version_no > r.version_no)
          ${regs === null ? Prisma.empty : Prisma.sql`AND (r.is_global OR r.region_id = ANY(${regs}::int[]))`}`);
      items.push({
        register_key: d.register_key,
        name_en: d.name_en,
        name_ar: d.name_ar,
        module_key: d.module_key,
        site_scoped: d.site_scoped,
        multiple_per_site: d.multiple_per_site,
        record_types: d.record_types,
        approval_levels: d.approval_levels,
        fields,
        record_count: Number(cnt[0]?.n ?? 0),
        ...(scopes[0]?.s ? { entry_scopes: scopes[0].s } : {}),
        // 0054 (Q222): the permit types the caller may enter, with the streams they may choose (D220b); the database decides again on every write
        ...(d.register_key === 'permits_hse' ? { entry_permit_types: await this.entryPermitTypes() } : {}),
      });
    }
    return { items };
  }

  private async entryPermitTypes(): Promise<unknown[]> {
    const rows = await this.db.tx.$queryRaw<{ r: unknown[] | null }[]>(Prisma.sql`SELECT reg_entry_permit_types() AS r`);
    return rows[0]?.r ?? [];
  }

  /** 0057 (Q104): the lists of the catalogue, active values first (code, labels, groups) and every code ever used (for the `list_other` warning). */
  private async catalogues(codes: string[]): Promise<Map<string, CatalogueInfo>> {
    const out = new Map<string, CatalogueInfo>();
    if (codes.length === 0) return out;
    const cats = await this.db.tx.$queryRaw<{ code: string; status: string; critical: boolean; allow_other: boolean }[]>(Prisma.sql`
      SELECT code, status, critical, allow_other FROM list_catalogues WHERE code = ANY(${codes}::text[])`);
    const vals = await this.db.tx.$queryRaw<{ catalogue_code: string; code: string; label_en: string; label_ar: string | null; groups: string[]; is_active: boolean }[]>(Prisma.sql`
      SELECT catalogue_code, code, label_en, label_ar, groups, is_active FROM list_values WHERE catalogue_code = ANY(${codes}::text[]) ORDER BY sort_order, code COLLATE "C"`);
    for (const c of cats) {
      const mine = vals.filter((v) => v.catalogue_code === c.code);
      out.set(c.code, {
        ref: { code: c.code, status: c.status, critical: c.critical, allow_other: c.allow_other },
        options: mine.filter((v) => v.is_active).map((v) => ({ value: v.code, label_en: v.label_en, label_ar: v.label_ar, ...(v.groups.length ? { groups: v.groups } : {}) })),
        all: new Set(mine.map((v) => v.code)),
      });
    }
    return out;
  }

  /** The raw field rows of a register with the catalogues they read (cached for one request). */
  private async fieldRows(key: string): Promise<{ rows: FieldRow[]; cats: Map<string, CatalogueInfo> }> {
    const rows = await this.db.tx.$queryRaw<FieldRow[]>(Prisma.sql`
      SELECT register_key, code, label_en, label_ar, field_type, required, derived, options, in_list, section, list_catalogue
      FROM register_fields WHERE register_key = ${key} AND is_active ORDER BY sort_order, code COLLATE "C"`);
    const codes = new Set<string>();
    for (const f of rows) {
      if (f.list_catalogue) codes.add(f.list_catalogue);
      for (const c of childColumns(f)) if (c.list_catalogue) codes.add(c.list_catalogue);
    }
    return { rows, cats: await this.catalogues([...codes]) };
  }

  private async fieldsOf(key: string): Promise<unknown[]> {
    const { rows, cats } = await this.fieldRows(key);
    let permitTypes: string[] | null = null;
    const out: unknown[] = [];
    for (const f of rows) {
      let options: { value: string; label_en: string; label_ar?: string | null }[] | undefined;
      const cat = f.list_catalogue ? cats.get(f.list_catalogue) : undefined;
      // the permit streams (0054, Q220) keep their names even when the list catalogue (0057) holds only the codes
      const labels = key === 'permits_hse' && f.code === 'permit_stream' ? PERMIT_STREAMS : undefined;
      if (cat) options = cat.options.map((o) => (labels?.[o.value] ? { ...o, ...labels[o.value] } : o));
      else if (Array.isArray(f.options)) {
        options = (f.options as string[]).map((v) => (labels?.[v] ? { value: v, ...labels[v] } : { value: v, label_en: v }));
      }
      else if (f.options && typeof f.options === 'object' && (f.options as { source?: string }).source === 'permit_types') {
        permitTypes ??= (await this.db.tx.$queryRaw<{ code: string }[]>(Prisma.sql`SELECT code FROM permit_types WHERE is_active ORDER BY sort_order`)).map((r) => r.code);
        options = permitTypes.map((v) => ({ value: v, label_en: v }));
      }
      const multiple = f.field_type === 'list_code' && (f.options as { multiple?: boolean } | null)?.multiple === true;
      out.push({
        code: f.code,
        label_en: f.label_en,
        label_ar: f.label_ar,
        type: f.field_type === 'external_team' ? 'text' : f.field_type === 'list_code' ? (multiple ? 'multi_list' : 'list') : f.field_type,
        required: f.required,
        read_only: f.derived,
        in_list: f.in_list,
        is_custom: false,
        ...(f.section ? { section: f.section } : {}),
        ...(options ? { options } : {}),
        ...(cat ? { list: cat.ref } : {}),
        ...(f.field_type === 'child_list'
          ? {
              columns: childColumns(f).map((c) => {
                const cc = c.list_catalogue ? cats.get(c.list_catalogue) : undefined;
                return {
                  code: c.code, label_en: c.label_en ?? c.code, label_ar: c.label_ar ?? null, type: c.type === 'list_code' ? 'list' : c.type, required: c.required === true,
                  ...(cc ? { list: cc.ref, options: cc.options } : {}),
                };
              }),
            }
          : {}),
      });
    }
    const entity = FIELD_ENTITY[key];
    if (entity) {
      const custom = await this.db.tx.$queryRaw<{ code: string; label_en: string; label_ar: string | null; data_type: string; required: boolean; in_list_filters: boolean }[]>(Prisma.sql`
        SELECT code, label_en, label_ar, data_type::text AS data_type, required, in_list_filters FROM field_definitions
        WHERE entity_type = ${entity}::"FieldEntityType" AND is_active AND task_code IS NULL ORDER BY sort_order, code`);
      for (const c of custom) out.push({ code: c.code, label_en: c.label_en, label_ar: c.label_ar, type: c.data_type, required: c.required, in_list: c.in_list_filters, is_custom: true });
    }
    return out;
  }

  // ------------------------------------------------------------------ reads
  private baseSelect(auth: AuthContext, where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Prisma.Sql {
    const actor = auth.user.id;
    return Prisma.sql`
      SELECT r.id::text AS id, r.entity_id::text AS entity_id, r.version_no, r.supersedes_id::text AS supersedes_id, r.is_current, r.register_key, r.record_type,
        r.site_id::text AS site_id, s.site_code, r.region_id, r.state, r.current_level, r.levels_required, reg_levels(r.id) AS n_levels,
        r.ball_in_court_user_id::text AS pinned, reg_data_for(r.id, r.register_key, r.record_type, r.entity_id, r.data) AS data, r.custom, r.external_party_id::text AS external_party_id, r.return_count, r.last_return_note,
        r.self_approval, r.historical_direct_approved, r.task_id::text AS task_id, td.code AS task_code, r.created_by::text AS created_by, r.created_at, r.updated_at, r.approved_at,
        r.approved_by::text AS approved_by, r.source, r.version,
        k.kind, k.cell_id::text AS cell_id, k.rule::text AS rule, k.has_holder, k.is_holder, k.votes_needed, k.votes_done,
        reg_is_eligible(r.id, 'entry', ${actor}::uuid) AS entry_holder,
        CASE WHEN r.ball_in_court_user_id IS NOT NULL AND r.state = 'entry' THEN reg_is_eligible(r.id, 'entry', r.ball_in_court_user_id) END AS pin_holds,
        reg_warnings(r.id) AS warnings,
        CASE WHEN r.register_key = 'hlc' THEN hlc_pr_view(r.id) END AS purchase_requests,
        EXISTS (SELECT 1 FROM register_records o WHERE o.entity_id = r.entity_id AND o.state IN ('entry', 'in_review', 'in_approval')) AS has_open,
        ${Prisma.raw(TS_TEXT('r.created_at'))} AS ts
      FROM register_records r
      LEFT JOIN sites s ON s.id = r.site_id
      LEFT JOIN task_instances ti ON ti.id = r.task_id
      LEFT JOIN task_definitions td ON td.id = ti.task_def_id
      LEFT JOIN LATERAL (
        SELECT x.kind, reg_cell(r.id, x.kind) AS cell_id, reg_rule(r.id, x.kind) AS rule, reg_has_holder(r.id, x.kind) AS has_holder,
          reg_is_eligible(r.id, x.kind, ${actor}::uuid) AS is_holder,
          (SELECT count(*) FROM register_level_voters v WHERE v.record_id = r.id AND v.level = r.current_level AND v.round = r.level_round) AS votes_needed,
          (SELECT count(*) FROM register_level_voters v WHERE v.record_id = r.id AND v.level = r.current_level AND v.round = r.level_round AND v.voted_at IS NOT NULL) AS votes_done
        FROM (SELECT CASE WHEN r.state IN ('entry', 'in_review', 'in_approval') THEN wf_kind(reg_levels(r.id), greatest(r.current_level, 1)) END AS kind) x
        WHERE x.kind IS NOT NULL
      ) k ON true
      WHERE ${where}
      ${tail}`;
  }

  /** Rows visible to the caller in the module of the register (404 for others). */
  private visibility(regs: number[] | null): Prisma.Sql {
    return regs === null ? Prisma.sql`true` : Prisma.sql`(r.is_global OR r.region_id = ANY(${regs}::int[]))`;
  }

  private async rowFor(auth: AuthContext, key: string, id: string): Promise<{ row: RecordRow; def: DefRow }> {
    const def = await this.definition(key);
    const regs = await this.access.requireRegions(def.module_key, 'view');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const rows = await this.db.tx.$queryRaw<RecordRow[]>(this.baseSelect(auth, Prisma.sql`r.id = ${id}::uuid AND r.register_key = ${key} AND ${this.visibility(regs)}`));
    const row = rows[0];
    if (!row) throw problems.notFound('The record does not exist or is not visible to you.');
    return { row, def };
  }

  async listRecords(auth: AuthContext, key: string, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    const def = await this.definition(key);
    const regs = await this.access.requireRegions(def.module_key, 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const conds: Prisma.Sql[] = [Prisma.sql`r.register_key = ${key}`, this.visibility(regs)];
    const site = oneParam(q, 'site_id');
    if (site !== undefined) {
      if (!uuidSchema.safeParse(site).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a uuid.' }]);
      conds.push(Prisma.sql`r.site_id = ${site}::uuid`);
    }
    const region = oneParam(q, 'region_id');
    if (region !== undefined) {
      if (!/^[0-9]{1,2}$/.test(region)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is a number.' }]);
      conds.push(Prisma.sql`r.region_id = ${Number(region)}::int`);
    }
    const state = oneParam(q, 'state');
    if (state !== undefined) {
      if (!STATES.includes(state)) throw problems.validation([{ path: '/state', code: 'invalid', message: `state is one of ${STATES.join(', ')}.` }]);
      conds.push(Prisma.sql`r.state = ${state}`);
    }
    const rtype = oneParam(q, 'record_type');
    if (rtype !== undefined) conds.push(Prisma.sql`r.record_type = ${rtype}`);
    const entity = oneParam(q, 'entity_id');
    if (entity !== undefined) {
      if (!uuidSchema.safeParse(entity).success) throw problems.validation([{ path: '/entity_id', code: 'invalid', message: 'entity_id is a uuid.' }]);
      conds.push(Prisma.sql`r.entity_id = ${entity}::uuid`);
    }
    const text = oneParam(q, 'q');
    if (text) conds.push(Prisma.sql`(s.site_code ILIKE ${likePattern(text)} OR reg_data_for(r.id, r.register_key, r.record_type, r.entity_id, r.data)::text ILIKE ${likePattern(text)})`);
    if (oneParam(q, 'all_versions') !== 'true' && entity === undefined) {
      conds.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM register_records n WHERE n.entity_id = r.entity_id AND n.version_no > r.version_no)`);
    }
    if (cursor) conds.push(Prisma.sql`(r.created_at, r.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`);
    const rows = await this.db.tx.$queryRaw<RecordRow[]>(
      this.baseSelect(auth, Prisma.join(conds, ' AND '), Prisma.sql`ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.dtos(auth, page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null } };
  }

  async get(auth: AuthContext, key: string, id: string, info?: TransitionInfo): Promise<Record<string, unknown>> {
    const { row } = await this.rowFor(auth, key, id);
    const [dto] = await this.dtos(auth, [row]);
    if (!dto) throw problems.notFound();
    if (info) dto.last_transition = info;
    return dto;
  }

  async versions(auth: AuthContext, key: string, id: string): Promise<{ items: unknown[] }> {
    const { row, def } = await this.rowFor(auth, key, id);
    const regs = await this.access.requireRegions(def.module_key, 'view');
    const rows = await this.db.tx.$queryRaw<RecordRow[]>(
      this.baseSelect(auth, Prisma.sql`r.entity_id = ${row.entity_id}::uuid AND ${this.visibility(regs)}`, Prisma.sql`ORDER BY r.version_no DESC`));
    return { items: await this.dtos(auth, rows) };
  }

  async history(auth: AuthContext, key: string, id: string, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    const { row } = await this.rowFor(auth, key, id);
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const after = cursor ? Prisma.sql`AND (w.created_at, w.id) > (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<
      { id: string; level: number; action: string; acted_by: string | null; note: string | null; before_state: string | null; after_state: string | null; self_approval: boolean; stepup_verified: boolean; batch_row_id: string | null; previous_path: boolean; created_at: Date; ts: string }[]
    >(Prisma.sql`
      SELECT w.id::text AS id, w.level, w.action, w.acted_by::text AS acted_by, w.note, w.before_state, w.after_state, w.self_approval, w.stepup_verified,
        w.batch_row_id::text AS batch_row_id, w.created_at, ${Prisma.raw(TS_TEXT('w.created_at'))} AS ts,
        EXISTS (SELECT 1 FROM levels_conversions c WHERE c.entity_type = 'register_record' AND c.entity_id = w.record_id AND c.levels_before = 3
                AND w.level >= 2 AND w.created_at <= c.converted_at) AS previous_path
      FROM register_steps w WHERE w.record_id = ${row.id}::uuid ${after} ORDER BY w.created_at, w.id LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const refs = await this.view.userRefs([...new Set(page.map((r) => r.acted_by).filter((x): x is string => !!x))]);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => {
        const item: Record<string, unknown> = {
          id: r.id,
          level: r.level,
          action: r.action,
          note: r.note,
          self_approval: r.self_approval,
          stepup_verified: r.stepup_verified,
          batch_row_id: r.batch_row_id,
          previous_path: r.previous_path,
          created_at: r.created_at,
        };
        if (r.acted_by && refs.get(r.acted_by)) item.acted_by = refs.get(r.acted_by);
        if (r.before_state) item.before_state = r.before_state;
        if (r.after_state) item.after_state = r.after_state;
        return item;
      }),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null },
    };
  }

  // ------------------------------------------------------------------ DTOs
  private async dtos(auth: AuthContext, rows: RecordRow[]): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    const cells = [...new Set(rows.map((r) => r.cell_id).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.flatMap((r) => [r.pinned, r.created_by, r.approved_by]).filter((x): x is string => !!x))];
    const partyIds = [...new Set(rows.map((r) => r.external_party_id).filter((x): x is string => !!x))];
    const assignees = cells.length
      ? await this.db.tx.$queryRaw<{ cell_id: string; kind: string; ref_id: string; label: string; employee_id: string | null; status: string | null; deleted: boolean | null }[]>(Prisma.sql`
          SELECT a.cell_id::text AS cell_id, a.kind::text AS kind, a.ref_id::text AS ref_id,
            coalesce(u.display_name, ro.name_en, g.name, '') AS label, u.employee_id, u.status::text AS status, (u.deleted_at IS NOT NULL) AS deleted
          FROM matrix_cell_assignees a
          LEFT JOIN users u ON a.kind = 'user' AND u.id = a.ref_id
          LEFT JOIN roles ro ON a.kind = 'role' AND ro.id = a.ref_id
          LEFT JOIN groups g ON a.kind = 'group' AND g.id = a.ref_id
          WHERE a.cell_id = ANY(${cells}::uuid[]) ORDER BY label, a.ref_id`)
      : [];
    const refs = await this.view.userRefs(userIds);
    const parties = partyIds.length
      ? await this.db.tx.$queryRaw<{ id: string; name: string; type: string }[]>(Prisma.sql`SELECT id::text AS id, name, type::text AS type FROM external_parties WHERE id = ANY(${partyIds}::uuid[])`)
      : [];
    const byCell = new Map<string, MatrixAssigneeDto[]>();
    for (const a of assignees) {
      const dto: MatrixAssigneeDto = { kind: a.kind as MatrixAssigneeDto['kind'], ref_id: a.ref_id, label: a.label, employee_id: a.kind === 'user' ? (a.employee_id?.trim() ?? null) : null };
      if (a.kind === 'user') {
        dto.user_id = a.ref_id;
        dto.account_status = accountStatus(a.status, a.deleted);
      }
      byCell.set(a.cell_id, [...(byCell.get(a.cell_id) ?? []), dto]);
    }
    const defs = new Map<string, DefRow>();
    const grants = new Map<string, number[] | null>();
    const grant = async (module: string, action: DbAction): Promise<number[] | null> => {
      const k = `${module}:${action}`;
      if (!grants.has(k)) grants.set(k, await this.access.regions(module, action));
      return grants.get(k) as number[] | null;
    };
    const can = async (module: string, action: DbAction, region: number | null): Promise<boolean> => {
      const g = await grant(module, action);
      return g === null || (g.length > 0 && (region === null || g.includes(region)));
    };
    // Q234 (migration 0056): a Quality snag record and its QC snag are one work item; the record shows the snag's state (the snag is closed only by
    // the QC photo flow). An approved snag record without a snag could not be linked (no Stage / stream): it shows as needs_review.
    const snagRecs = rows.filter((r) => r.register_key === 'quality' && r.record_type === 'snag').map((r) => r.entity_id);
    const qcSnags = new Map(snagRecs.length
      ? (await this.db.tx.$queryRaw<{ entity_id: string; id: string; status: string; scope: string }[]>(Prisma.sql`
          SELECT register_entity_id::text AS entity_id, id::text AS id, status::text AS status, scope FROM snags WHERE register_entity_id = ANY(${snagRecs}::uuid[])`)).map((x) => [x.entity_id, x])
      : []);
    const QC_STATE: Record<string, string> = { open: 'open', fix_uploaded: 'fix_submitted', in_review: 'in_review', closed: 'closed', cancelled: 'cancelled' };
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      if (!defs.has(r.register_key)) defs.set(r.register_key, await this.definition(r.register_key));
      const module = (defs.get(r.register_key) as DefRow).module_key;
      const pinned = r.pinned ? refs.get(r.pinned) : undefined;
      const party = r.external_party_id ? parties.find((p) => p.id === r.external_party_id) : undefined;
      const dto: Record<string, unknown> = {
        id: r.id,
        entity_id: r.entity_id,
        version_no: r.version_no,
        supersedes_id: r.supersedes_id,
        is_current: r.is_current,
        register_key: r.register_key,
        record_type: r.record_type,
        site_id: r.site_id,
        site_code: r.site_code,
        region_id: r.region_id,
        state: r.state,
        current_level: r.current_level,
        levels_required: r.n_levels,
        data: r.data,
        custom: r.custom,
        return_count: r.return_count,
        last_return_note: r.last_return_note,
        self_approval: r.self_approval,
        historical_direct_approved: r.historical_direct_approved,
        source: r.source,
        created_at: r.created_at,
        updated_at: r.updated_at,
        approved_at: r.approved_at,
        version: r.version,
        warnings: Array.isArray(r.warnings) ? r.warnings : [],
      };
      if (r.task_id && r.task_code) dto.task = { id: r.task_id, task_code: r.task_code };
      if (r.register_key === 'quality' && r.record_type === 'snag') {
        const qs = qcSnags.get(r.entity_id);
        dto.qc_snag = qs ? { id: qs.id, state: QC_STATE[qs.status] ?? qs.status, scope: qs.scope, link: 'linked' }
          : { id: null, state: null, scope: null, link: r.state === 'approved' ? 'needs_review' : 'on_approval' };
      }
      // 0063 (Q150): the HLC purchase requests the record covers, and whether all are approved by HLC (C3)
      if (r.purchase_requests) dto.purchase_requests = r.purchase_requests;
      if (party) dto.external_party = party;
      if (r.created_by && refs.get(r.created_by)) dto.created_by = refs.get(r.created_by);
      if (r.approved_by && refs.get(r.approved_by)) dto.approved_by = refs.get(r.approved_by);
      if (r.kind) {
        dto.ball_in_court = {
          level: Math.max(r.current_level, 1),
          level_kind: r.kind,
          level_code: levelCode(r.kind),
          holders: r.cell_id ? (byCell.get(r.cell_id) ?? []) : [],
          rule: r.rule ?? 'any_one',
          no_eligible_holder: r.has_holder === false,
          ...(pinned ? { claimed_by: pinned } : {}),
          ...(r.rule === 'all_members' ? { votes_needed: Number(r.votes_needed ?? 0), votes_done: Number(r.votes_done ?? 0) } : {}),
        };
      }
      // allowed actions: a hint for the screen; the database decides again on every call
      const actions: string[] = [];
      const holds = r.is_holder === true || (auth.state.isAdmin && r.has_holder === false);
      const claimedByOther = r.pinned !== null && r.pinned !== auth.user.id;
      const active = OPEN_STATES.includes(r.state);
      if (active && holds && !claimedByOther) {
        if (r.kind === 'entry' && (await can(module, 'edit', r.region_id))) actions.push('edit', 'submit');
        if (r.kind === 'review' && (await can(module, 'view', r.region_id))) actions.push('review', 'reject');
        if (r.kind === 'approve' && (await can(module, 'approve', r.region_id))) actions.push('approve', 'reject');
        if (r.pinned === null && r.rule !== 'all_members') actions.push('claim');
      }
      if (active && r.pinned === auth.user.id) actions.push('release');
      // 0054 (Q221): a permit draft held by somebody who no longer holds L1 of its row is handed over (by that person) or taken over (by a qualified holder)
      if (r.register_key === 'permits_hse' && r.state === 'entry' && r.kind === 'entry') {
        const mine = (r.pinned ?? r.created_by) === auth.user.id;
        if ((!r.is_holder && mine && !(auth.state.isAdmin && r.has_holder === false)) || (r.is_holder && r.pinned !== null && r.pinned !== auth.user.id && r.pin_holds === false)) actions.push('transfer');
      }
      if (active && (await can(module, 'delete', r.region_id))) actions.push('void');
      if (r.state === 'approved' && r.is_current && !r.has_open && r.entry_holder && (await can(module, 'edit', r.region_id))) actions.push('new_version');
      // Q267: a System Admin cancels an approved Quality snag record entered by mistake (its QC snag is cancelled with it; a closed QC snag is history)
      if (auth.state.isAdmin && r.register_key === 'quality' && r.record_type === 'snag' && r.state === 'approved' && r.is_current && !r.has_open
        && qcSnags.get(r.entity_id)?.status !== 'closed') actions.push('cancel_snag');
      dto.allowed_actions = actions;
      out.push(dto);
    }
    await this.attachRefs(out);
    return out;
  }

  /**
   * 0057: the display data of the ids a record holds (people, sites, Warehouse items, files, tasks) and the `list_other` warning of a value that is not in its
   * list (accepted while the list allows another value, Q104).
   */
  private async attachRefs(out: Record<string, unknown>[]): Promise<void> {
    const meta = new Map<string, { rows: FieldRow[]; cats: Map<string, CatalogueInfo> }>();
    for (const d of out) if (!meta.has(d.register_key as string)) meta.set(d.register_key as string, await this.fieldRows(d.register_key as string));
    const ids = { users: new Set<string>(), sites: new Set<string>(), items: new Set<string>(), files: new Set<string>(), tasks: new Set<string>() };
    const add = (set: Set<string>, v: unknown) => { if (isUuid(v)) set.add(v.toLowerCase()); };
    for (const d of out) {
      const data = (d.data ?? {}) as Record<string, unknown>;
      const m = meta.get(d.register_key as string) as { rows: FieldRow[]; cats: Map<string, CatalogueInfo> };
      const warnings = (d.warnings as unknown[]) ?? [];
      for (const f of m.rows) {
        const v = data[f.code];
        if (v === undefined || v === null) continue;
        if (f.field_type === 'user') add(ids.users, v);
        else if (f.field_type === 'multi_user' && Array.isArray(v)) v.forEach((x) => add(ids.users, x));
        else if (f.field_type === 'multi_site' && Array.isArray(v)) v.forEach((x) => add(ids.sites, x));
        else if (f.field_type === 'warehouse_item') add(ids.items, v);
        else if (f.field_type === 'file') add(ids.files, v);
        else if (f.field_type === 'child_list' && Array.isArray(v)) {
          for (const row of v as Record<string, unknown>[]) for (const c of childColumns(f)) {
            if (c.type === 'user') add(ids.users, row[c.code]);
            if (c.type === 'task') add(ids.tasks, row[c.code]);
          }
        }
        const cat = f.list_catalogue ? m.cats.get(f.list_catalogue) : undefined;
        if (cat && cat.ref.allow_other) {
          for (const x of Array.isArray(v) ? v : [v]) {
            if (typeof x === 'string' && !cat.all.has(x)) {
              warnings.push({ path: `/data/${f.code}`, code: 'list_other', message: `"${x}" is not a value of the list ${cat.ref.code} (accepted while the list allows another value).` });
            }
          }
        }
      }
      d.warnings = warnings;
    }
    const refs = {
      users: ids.users.size ? await this.view.userRefs([...ids.users]) : new Map<string, UserRefDto>(),
      sites: ids.sites.size ? await this.db.tx.$queryRaw<{ id: string; site_code: string }[]>(Prisma.sql`SELECT id::text AS id, site_code FROM sites WHERE id = ANY(${[...ids.sites]}::uuid[])`) : [],
      items: ids.items.size ? await this.db.tx.$queryRaw<{ id: string; item_code: string; name: string; is_active: boolean }[]>(Prisma.sql`SELECT id::text AS id, item_code, name, is_active FROM warehouse_items WHERE id = ANY(${[...ids.items]}::uuid[])`) : [],
      // a file name is shown only for a file of a slot of the same logical record
      files: ids.files.size ? await this.db.tx.$queryRaw<{ id: string; entity: string; name: string }[]>(Prisma.sql`
        SELECT f.id::text AS id, s.register_entity_id::text AS entity, f.original_name AS name FROM document_files f JOIN document_slots s ON s.id = f.slot_id
        WHERE f.id = ANY(${[...ids.files]}::uuid[]) AND s.register_entity_id IS NOT NULL`) : [],
      tasks: ids.tasks.size ? await this.db.tx.$queryRaw<{ id: string; code: string }[]>(Prisma.sql`
        SELECT t.id::text AS id, td.code FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.id = ANY(${[...ids.tasks]}::uuid[])`) : [],
    };
    for (const d of out) {
      const data = JSON.stringify(d.data ?? {}).toLowerCase();
      const has = (id: string) => data.includes(id.toLowerCase());
      const r: Record<string, Record<string, unknown>> = {};
      const users = [...refs.users.entries()].filter(([id]) => has(id));
      if (users.length) r.users = Object.fromEntries(users.map(([id, u]) => [id, { display_name: u.display_name, employee_id: u.employee_id }]));
      const sites = refs.sites.filter((x) => has(x.id));
      if (sites.length) r.sites = Object.fromEntries(sites.map((x) => [x.id, x.site_code]));
      const items = refs.items.filter((x) => has(x.id));
      if (items.length) r.warehouse_items = Object.fromEntries(items.map((x) => [x.id, { item_code: x.item_code, name: x.name, is_active: x.is_active }]));
      const files = refs.files.filter((x) => has(x.id) && x.entity === d.entity_id);
      if (files.length) r.files = Object.fromEntries(files.map((x) => [x.id, x.name]));
      const tasks = refs.tasks.filter((x) => has(x.id));
      if (tasks.length) r.tasks = Object.fromEntries(tasks.map((x) => [x.id, x.code]));
      if (Object.keys(r).length) d.refs = r;
    }
  }

  // ------------------------------------------------------------------ writes
  /** The database decides every transition; a savepoint keeps the request transaction usable after a refusal. */
  async call<T>(auth: AuthContext, sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT reg_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      const r = rows[0]?.r;
      if (r === undefined || r === null) throw new ProblemException(500, 'internal_error', {});
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT reg_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT reg_call`;
      if (p.code === 'step_up_required') {
        throw new ProblemException(401, 'step_up_required', {
          detail: 'Confirm your password to continue.',
          step_up_method: auth.session.authMethod === 'local' ? 'password' : 'm365',
        });
      }
      if (p.code === 'already_claimed') {
        const id = (p.opts.extra?.claimed_by as { id?: string } | undefined)?.id;
        const ref: UserRefDto | undefined = id ? (await this.view.userRefs([id])).get(id) : undefined;
        if (ref) throw new ProblemException(409, 'already_claimed', { ...p.opts, extra: { claimed_by: ref } });
      }
      throw p;
    }
  }

  async create(auth: AuthContext, key: string, rawBody: unknown): Promise<Record<string, unknown>> {
    const def = await this.definition(key);
    const body = parse(createSchema, rawBody);
    const id = await this.call<string>(
      auth,
      Prisma.sql`SELECT reg_save_record(${key}::text, NULL::uuid, NULL::int, ${body.site_id ?? null}::uuid, ${body.record_type ?? null}::text, ${JSON.stringify(body.data)}::jsonb,
        ${body.custom ? JSON.stringify(body.custom) : null}::jsonb, ${body.external_party_id ?? null}::uuid, false)::text AS r`,
    );
    void def;
    return this.get(auth, key, id);
  }

  async update(auth: AuthContext, key: string, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(patchSchema, rawBody);
    await this.rowFor(auth, key, id);
    await this.call<string>(
      auth,
      Prisma.sql`SELECT reg_save_record(${key}::text, ${id}::uuid, ${version}::int, NULL::uuid, NULL::text, ${body.data ? JSON.stringify(body.data) : null}::jsonb,
        ${body.custom ? JSON.stringify(body.custom) : null}::jsonb, ${body.external_party_id ?? null}::uuid, ${body.external_party_id === null}::boolean)::text AS r`,
    );
    return this.get(auth, key, id);
  }

  async newVersion(auth: AuthContext, key: string, id: string, ifMatch: string | undefined): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.rowFor(auth, key, id);
    const rid = await this.call<string>(auth, Prisma.sql`SELECT reg_new_version(${id}::uuid, ${version}::int)::text AS r`);
    return this.get(auth, key, rid);
  }

  async transition(auth: AuthContext, key: string, id: string, action: RegisterTransition, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(noteSchema, rawBody ?? {});
    if (action === 'reject' && (!body.note || body.note.trim() === '')) {
      throw new ProblemException(422, 'note_required', { detail: 'A rejection needs a note.', errors: [{ path: '/note', code: 'required', message: 'A note is required.' }] });
    }
    await this.rowFor(auth, key, id);
    await setVia(this.db.tx, body.via);
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    if (body.rejected_slots && action !== 'reject') {
      throw problems.validation([{ path: '/rejected_slots', code: 'invalid', message: 'Slots are named only with a rejection.' }]);
    }
    // the conditional documents that apply now are slots before the database gate counts the missing ones (Q131)
    if (action === 'submit') await this.documents.syncRecordById(id);
    const info = await this.call<TransitionInfo>(
      auth,
      action === 'reject' && body.rejected_slots && body.rejected_slots.length > 0
        ? Prisma.sql`SELECT doc_record_reject(${id}::uuid, ${version}::int, ${body.note ?? null}::text, ${JSON.stringify(body.rejected_slots)}::jsonb) AS r`
        : Prisma.sql`SELECT reg_transition_record(${id}::uuid, ${version}::int, ${action}::text, ${body.note ?? null}::text, ${stepOk}::boolean) AS r`,
    );
    return this.get(auth, key, id, info);
  }

  async claim(auth: AuthContext, key: string, id: string, ifMatch: string | undefined, release: boolean): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.rowFor(auth, key, id);
    const info = await this.call<TransitionInfo>(
      auth,
      release ? Prisma.sql`SELECT reg_release_record(${id}::uuid, ${version}::int) AS r` : Prisma.sql`SELECT reg_claim_record(${id}::uuid, ${version}::int) AS r`,
    );
    return this.get(auth, key, id, info);
  }

  /** 0054 (Q221): move a permit draft to a qualified entry holder (the database decides who may and to whom). */
  async transfer(auth: AuthContext, key: string, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(transferSchema, rawBody ?? {});
    await this.rowFor(auth, key, id);
    const info = await this.call<TransitionInfo>(auth, Prisma.sql`SELECT reg_permit_transfer(${id}::uuid, ${version}::int, ${body.note ?? null}::text) AS r`);
    return this.get(auth, key, id, info);
  }

  async void(auth: AuthContext, key: string, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(reasonSchema, rawBody ?? {});
    await this.rowFor(auth, key, id);
    await this.stepUp.require(auth);
    await this.call<boolean>(auth, Prisma.sql`SELECT true AS r FROM (SELECT reg_void_record(${id}::uuid, ${version}::int, ${body.reason}::text)) v`);
    return this.get(auth, key, id);
  }

  /**
   * Q267: a System Admin cancels an approved Quality register record of type snag that was entered by mistake. A reason and step-up are required; the
   * record is voided, its QC snag is cancelled with it, and the database audits it (register_record_cancel_snag). The database decides again.
   */
  async cancelSnagRecord(auth: AuthContext, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(cancelSnagSchema, rawBody ?? {});
    await this.rowFor(auth, 'quality', id);
    if (!auth.state.isAdmin) throw problems.forbidden('action_forbidden', 'Only a System Admin cancels an approved Quality snag record.');
    await this.stepUp.require(auth);
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    await this.call(auth, Prisma.sql`SELECT qc_cancel_snag_record(${id}::uuid, ${version}::int, ${body.reason}::text, ${stepOk}::boolean) AS r`);
    return this.get(auth, 'quality', id);
  }

  // ------------------------------------------------------------------ Q111: the explicit conversion of the old free text of a meeting
  async legacyProposal(auth: AuthContext, key: string, id: string): Promise<Record<string, unknown>> {
    if (key !== 'meetings') throw problems.notFound('Only a meeting has old text to convert.');
    const { row } = await this.rowFor(auth, key, id);
    const d = row.data as Record<string, unknown>;
    const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
    const done = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n FROM register_records WHERE entity_id = ${row.entity_id}::uuid AND data ? 'legacy_converted_at'`);
    const tokens = (t: string | null, re: RegExp) => [...new Set((t ?? '').split(re).map((x) => x.trim()).filter(Boolean))];
    const attendees: Record<string, unknown>[] = [], sites: Record<string, unknown>[] = [];
    const unmatched = { attendees: [] as string[], sites: [] as string[] };
    for (const t of tokens(str('attendees'), /[,;\n]+/)) {
      const u = await this.db.tx.$queryRaw<{ id: string; display_name: string; employee_id: string | null }[]>(Prisma.sql`
        SELECT id::text AS id, display_name, employee_id FROM users WHERE deleted_at IS NULL
          AND (lower(display_name) = lower(${t}) OR lower(email) = lower(${t}) OR btrim(employee_id) = ${t}) LIMIT 2`);
      if (u.length === 1 && u[0]) attendees.push({ text: t, user_id: u[0].id, display_name: u[0].display_name, employee_id: u[0].employee_id?.trim() ?? null });
      else unmatched.attendees.push(t);
    }
    // the sites the caller may link: those of the regions of the register's module (the same rule as the multi-site field)
    const regs = await this.access.regions('meetings', 'view');
    for (const t of tokens(str('linked_sites'), /[,;\s]+/)) {
      const s2 = await this.db.tx.$queryRaw<{ id: string; site_code: string }[]>(Prisma.sql`
        SELECT id::text AS id, site_code FROM sites WHERE upper(site_code) = upper(${t})
          ${regs === null ? Prisma.empty : Prisma.sql`AND region_id = ANY(${regs}::int[])`} LIMIT 1`);
      if (s2[0]) sites.push({ text: t, site_id: s2[0].id, site_code: s2[0].site_code });
      else unmatched.sites.push(t);
    }
    // each line of the old action text is one proposed action; the owner and the due date are for the person to fill (nothing becomes a task by itself)
    const actions = (str('action_items') ?? '').split(/\n+/).map((x) => x.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim()).filter(Boolean)
      .map((description) => ({ description, status: 'Open' }));
    return {
      record_id: row.id,
      converted: Number(done[0]?.n ?? 0) > 0,
      legacy: { attendees: str('attendees'), linked_sites: str('linked_sites'), minutes_ref: str('minutes_ref'), action_items: str('action_items') },
      attendees, sites, action_items: actions, unmatched,
      minutes_note: str('minutes_ref'),
    };
  }

  async legacyApply(auth: AuthContext, key: string, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    if (key !== 'meetings') throw problems.notFound('Only a meeting has old text to convert.');
    const version = parseIfMatch(ifMatch);
    const body = parse(convertSchema, rawBody);
    await this.rowFor(auth, key, id);
    await this.call<string>(auth, Prisma.sql`SELECT reg_meeting_convert(${id}::uuid, ${version}::int, ${JSON.stringify(body.values)}::jsonb, ${body.reason}::text)::text AS r`);
    return this.get(auth, key, id);
  }

  // ------------------------------------------------------------------ comments (X3)
  async comments(auth: AuthContext, key: string, id: string, q: Record<string, unknown>) {
    const { row } = await this.rowFor(auth, key, id);
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeTypedCursor(oneParam(q, 'cursor'), ['ts', 'uuid']);
    const after = cursor ? Prisma.sql`AND (c.created_at, c.id) > (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<{ id: string; author_id: string; body: string; is_rejection_note: boolean; created_at: Date; ts: string }[]>(Prisma.sql`
      SELECT c.id::text AS id, c.author_id::text AS author_id, c.body, c.is_rejection_note, c.created_at, ${Prisma.raw(TS_TEXT('c.created_at'))} AS ts
      FROM comments c JOIN register_records r ON r.id = ${row.id}::uuid
      WHERE c.entity_type = 'register_record' AND c.entity_id = r.entity_id ${after} ORDER BY c.created_at, c.id LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.workflow.commentDtos(page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null } };
  }

  async addComment(auth: AuthContext, key: string, id: string, rawBody: unknown) {
    const body = parse(commentSchema, rawBody);
    const { row } = await this.rowFor(auth, key, id);
    const mentions = await resolveMentions(this.db.tx, body.body, body.mention_user_ids);
    const cid = await this.call<string>(auth, Prisma.sql`SELECT reg_add_comment(${key}::text, ${row.id}::uuid, ${body.body}::text, ${mentions}::uuid[])::text AS r`);
    const rows = await this.db.tx.$queryRaw<{ id: string; author_id: string; body: string; is_rejection_note: boolean; created_at: Date }[]>(
      Prisma.sql`SELECT id::text AS id, author_id::text AS author_id, body, is_rejection_note, created_at FROM comments WHERE id = ${cid}::uuid`);
    const [dto] = await this.workflow.commentDtos(rows);
    return dto;
  }
}
