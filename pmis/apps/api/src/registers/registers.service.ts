import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService, DbAction } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { TS_TEXT, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { MatrixAssigneeDto, TaskViewService, UserRefDto, accountStatus } from '../workflow/task-view.service';

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
const noteSchema = z.object({ note: z.string().max(2000).optional() }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(2000), confirm_text: z.string().optional() }).passthrough();

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
  has_open: boolean;
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
}

const FIELD_ENTITY: Record<string, string> = { procurement: 'procurement', gecol: 'gecol', hlc: 'hlc', permits_hse: 'permit' };

@Injectable()
export class RegistersService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly view: TaskViewService,
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
      });
    }
    return { items };
  }

  private async fieldsOf(key: string): Promise<unknown[]> {
    const rows = await this.db.tx.$queryRaw<FieldRow[]>(Prisma.sql`
      SELECT register_key, code, label_en, label_ar, field_type, required, derived, options, in_list
      FROM register_fields WHERE register_key = ${key} AND is_active ORDER BY sort_order, code`);
    let permitTypes: string[] | null = null;
    const out: unknown[] = [];
    for (const f of rows) {
      let options: { value: string; label_en: string }[] | undefined;
      if (Array.isArray(f.options)) options = (f.options as string[]).map((v) => ({ value: v, label_en: v }));
      else if (f.options && typeof f.options === 'object' && (f.options as { source?: string }).source === 'permit_types') {
        permitTypes ??= (await this.db.tx.$queryRaw<{ code: string }[]>(Prisma.sql`SELECT code FROM permit_types WHERE is_active ORDER BY sort_order`)).map((r) => r.code);
        options = permitTypes.map((v) => ({ value: v, label_en: v }));
      }
      out.push({
        code: f.code,
        label_en: f.label_en,
        label_ar: f.label_ar,
        type: f.field_type === 'external_team' ? 'text' : f.field_type,
        required: f.required,
        read_only: f.derived,
        in_list: f.in_list,
        is_custom: false,
        ...(options ? { options } : {}),
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
        r.ball_in_court_user_id::text AS pinned, r.data, r.custom, r.external_party_id::text AS external_party_id, r.return_count, r.last_return_note,
        r.self_approval, r.task_id::text AS task_id, td.code AS task_code, r.created_by::text AS created_by, r.created_at, r.updated_at, r.approved_at,
        r.approved_by::text AS approved_by, r.source, r.version,
        k.kind, k.cell_id::text AS cell_id, k.rule::text AS rule, k.has_holder, k.is_holder, k.votes_needed, k.votes_done,
        EXISTS (SELECT 1 FROM reg_entry_holders(r.register_key, r.region_id) h WHERE h.user_id = ${actor}::uuid) AS entry_holder,
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
    if (text) conds.push(Prisma.sql`(s.site_code ILIKE ${likePattern(text)} OR r.data::text ILIKE ${likePattern(text)})`);
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
      { id: string; level: number; action: string; acted_by: string | null; note: string | null; before_state: string | null; after_state: string | null; self_approval: boolean; stepup_verified: boolean; batch_row_id: string | null; created_at: Date; ts: string }[]
    >(Prisma.sql`
      SELECT w.id::text AS id, w.level, w.action, w.acted_by::text AS acted_by, w.note, w.before_state, w.after_state, w.self_approval, w.stepup_verified,
        w.batch_row_id::text AS batch_row_id, w.created_at, ${Prisma.raw(TS_TEXT('w.created_at'))} AS ts
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
        source: r.source,
        created_at: r.created_at,
        updated_at: r.updated_at,
        approved_at: r.approved_at,
        version: r.version,
      };
      if (r.task_id && r.task_code) dto.task = { id: r.task_id, task_code: r.task_code };
      if (party) dto.external_party = party;
      if (r.created_by && refs.get(r.created_by)) dto.created_by = refs.get(r.created_by);
      if (r.approved_by && refs.get(r.approved_by)) dto.approved_by = refs.get(r.approved_by);
      if (r.kind) {
        dto.ball_in_court = {
          level: Math.max(r.current_level, 1),
          level_kind: r.kind,
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
      if (active && (await can(module, 'delete', r.region_id))) actions.push('void');
      if (r.state === 'approved' && r.is_current && !r.has_open && r.entry_holder && (await can(module, 'edit', r.region_id))) actions.push('new_version');
      dto.allowed_actions = actions;
      out.push(dto);
    }
    return out;
  }

  // ------------------------------------------------------------------ writes
  /** The database decides every transition; a savepoint keeps the request transaction usable after a refusal. */
  private async call<T>(auth: AuthContext, sql: Prisma.Sql): Promise<T> {
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
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    const info = await this.call<TransitionInfo>(
      auth,
      Prisma.sql`SELECT reg_transition_record(${id}::uuid, ${version}::int, ${action}::text, ${body.note ?? null}::text, ${stepOk}::boolean) AS r`,
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

  async void(auth: AuthContext, key: string, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(reasonSchema, rawBody ?? {});
    await this.rowFor(auth, key, id);
    await this.stepUp.require(auth);
    await this.call<boolean>(auth, Prisma.sql`SELECT true AS r FROM (SELECT reg_void_record(${id}::uuid, ${version}::int, ${body.reason}::text)) v`);
    return this.get(auth, key, id);
  }
}
