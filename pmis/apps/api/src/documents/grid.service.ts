import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { ProblemException, problems } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { z } from 'zod';
import { DocumentsService, SITE_DOCS } from './documents.service';

export const GRID_STATUSES = ['missing', 'pending', 'approved', 'expired', 'rejected', 'not_required', 'generatable', 'blocked', 'not_applicable'] as const;
export type GridStatus = (typeof GRID_STATUSES)[number];
const OPEN_TASK_STATES = ['open', 'entry', 'in_review', 'in_approval', 'approved'];
const BATCH = 100;
const MAX_SITE_CODES = 500;

interface Placement { kind: 'task' | 'qc' | 'register'; task: string | null; stage: string | null; register: string | null }
interface GridColumn { id: string; code: string; name_en: string; name_ar: string | null; kind: string; form_kind: string | null; placements: Placement[] }
interface SlotAgg { slots: number; approved: number; expired: number; rejected: number; pending: number; not_required: number }
interface FileAgg { files: number; in_range: number }

const reasonSchema = z.string().trim().min(3).max(1000);
const overrideBody = z.object({ doc_code: z.string().trim().min(1).max(31), reason: reasonSchema }).strict();
const reasonBody = z.object({ reason: reasonSchema }).strict();
const moveBody = z.object({ target_slot_id: z.guid(), reason: reasonSchema }).strict();
const viewBody = z.object({ columns: z.array(z.string().min(1).max(40)).max(300) }).strict();

@Injectable()
export class DocsGridService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly docs: DocumentsService,
    private readonly stepUp: StepUpService,
  ) {}

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT grid_call`;
    try {
      const r = await fn();
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT grid_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT grid_call`;
      throw p;
    }
  }

  // ------------------------------------------------------------------------------------------------------------ grid

  private async columns(stage: string | undefined, docs: string[]): Promise<GridColumn[]> {
    const rows = await this.db.tx.$queryRaw<{ id: string; code: string; name_en: string; name_ar: string | null; kind: string; form_kind: string | null; placements: Placement[] | null }[]>(Prisma.sql`
      SELECT dt.id::text AS id, dt.code, dt.name_en, dt.name_ar, dt.kind::text AS kind, dt.form_kind,
        (SELECT jsonb_agg(jsonb_build_object('kind', p.kind::text, 'task', td.code, 'stage', st.code, 'register', p.register_key) ORDER BY p.kind::text, td.code)
           FROM document_type_placements p LEFT JOIN task_definitions td ON td.id = p.task_def_id LEFT JOIN stage_definitions st ON st.id = td.stage_id
          WHERE p.doc_type_id = dt.id) AS placements
      FROM document_types dt WHERE dt.is_active ORDER BY dt.code`);
    return rows
      .map((r) => ({ id: r.id, code: r.code, name_en: r.name_en, name_ar: r.name_ar, kind: r.kind, form_kind: r.form_kind, placements: r.placements ?? [] }))
      .filter((c) => c.placements.length > 0)
      .filter((c) => (docs.length === 0 || docs.includes(c.code)))
      .filter((c) => stage === undefined || c.placements.some((p) => p.stage === stage));
  }

  static groupOf(c: GridColumn): { key: string; label: string } {
    const t = c.placements.find((p) => p.kind === 'task' && p.stage);
    if (t) return { key: `stage:${t.stage}`, label: `Stage ${t.stage}` };
    const r = c.placements.find((p) => p.kind === 'register' && p.register);
    if (r) return { key: `register:${r.register}`, label: String(r.register) };
    return { key: 'qc', label: 'QC' };
  }

  /** One status per cell, from the site's task instances, its slots and files, and its overrides. Pure, so it can be tested without a database. */
  static cellOf(input: {
    column: GridColumn; taskStates: Map<string, string>; slots: SlotAgg | undefined; files: FileAgg | undefined; override: string | undefined;
  }): { status: GridStatus; reason: string | null; slots: number; files: number; in_range: number } {
    const { column, taskStates, slots, files, override } = input;
    const base = { slots: slots?.slots ?? 0, files: files?.files ?? 0, in_range: files?.in_range ?? 0 };
    if (override !== undefined) return { status: 'not_required', reason: override, ...base };
    if (slots && slots.slots > 0) {
      const approvedOk = slots.approved;
      let status: GridStatus;
      if (slots.expired > 0) status = 'expired';
      else if (slots.rejected > 0) status = 'rejected';
      else if (approvedOk === slots.slots) status = 'approved';
      else if (slots.pending > 0) status = 'pending';
      else if (slots.not_required === slots.slots) status = 'not_required';
      else status = 'missing';
      return { status, reason: null, ...base };
    }
    const taskCodes = column.placements.filter((p) => p.kind === 'task' && p.task).map((p) => p.task as string);
    const taskHere = taskCodes.find((c) => taskStates.has(c));
    if (taskHere === undefined) return { status: 'not_applicable', reason: null, ...base };
    if (column.form_kind) {
      const state = taskStates.get(taskHere) as string;
      if (OPEN_TASK_STATES.includes(state)) return { status: 'generatable', reason: null, ...base };
      return { status: 'blocked', reason: `Task ${taskHere} is ${state}`, ...base };
    }
    return { status: 'missing', reason: null, ...base };
  }

  async grid(auth: AuthContext, q: Query) {
    const regions = await this.access.requireRegions(SITE_DOCS, 'view');
    const downloadable = await this.docs.downloadRegions();
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(typeof q.cursor === 'string' ? q.cursor : undefined, 1);
    const stage = oneParam(q, 'stage_code');
    const docCodes = Array.isArray(q.doc_code) ? (q.doc_code as unknown[]).map(String) : typeof q.doc_code === 'string' ? [q.doc_code] : [];
    const status = oneParam(q, 'status');
    if (status !== undefined && !(GRID_STATUSES as readonly string[]).includes(status)) throw problems.validation([{ path: '/status', code: 'invalid', message: 'Unknown status.' }]);
    const from = oneParam(q, 'uploaded_from');
    const to = oneParam(q, 'uploaded_to');
    for (const [k, v] of [['uploaded_from', from], ['uploaded_to', to]] as const) {
      if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw problems.validation([{ path: `/${k}`, code: 'invalid', message: `${k} is a date (YYYY-MM-DD).` }]);
    }
    const codes = (oneParam(q, 'site_code') ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x !== '');
    if (codes.length > MAX_SITE_CODES) throw problems.validation([{ path: '/site_code', code: 'too_many', message: `At most ${MAX_SITE_CODES} Site IDs.` }]);
    const regionIds = (Array.isArray(q.region_id) ? (q.region_id as unknown[]) : q.region_id !== undefined ? [q.region_id] : []).map((x) => Number(x));
    if (regionIds.some((x) => !Number.isInteger(x))) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is an integer.' }]);

    const columns = await this.columns(stage, docCodes);
    const out: { site_id: string; site_code: string; site_name: string | null; region_id: number; download_allowed: boolean; cells: Record<string, unknown> }[] = [];
    let lastCode: string | null = cur ? cur[0] ?? null : null;
    let exhausted = false;
    while (out.length < limit && !exhausted) {
      const sites = await this.db.tx.$queryRaw<{ id: string; site_code: string; name: string | null; region_id: number }[]>(Prisma.sql`
        SELECT s.id::text AS id, s.site_code, s.name, s.region_id FROM sites s
        WHERE s.is_active
          AND (${regions}::int[] IS NULL OR s.region_id = ANY(${regions}::int[]))
          AND (${regionIds.length === 0}::boolean OR s.region_id = ANY(${regionIds}::int[]))
          AND (${codes.length === 0}::boolean OR s.site_code = ANY(${codes}::text[]))
          AND (${lastCode}::text IS NULL OR s.site_code > ${lastCode}::text)
        ORDER BY s.site_code LIMIT ${BATCH}`);
      if (sites.length < BATCH) exhausted = true;
      if (sites.length === 0) break;
      lastCode = sites[sites.length - 1]!.site_code;
      const built = await this.buildRows(sites, columns, downloadable, from, to);
      for (const r of built) {
        if (status !== undefined && !Object.values(r.cells).some((c) => (c as { status: string }).status === status)) continue;
        if (from !== undefined || to !== undefined) {
          if (!Object.values(r.cells).some((c) => (c as { in_range: number }).in_range > 0)) continue;
        }
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    const more = !exhausted || out.length >= limit;
    const nextCursor = more && out.length > 0 ? encodeCursor([out[out.length - 1]!.site_code]) : null;
    return {
      columns: columns.map((c) => {
        const g = DocsGridService.groupOf(c);
        return { doc_code: c.code, name_en: c.name_en, name_ar: c.name_ar, kind: c.form_kind ? 'generated_form' : c.kind, generated: c.form_kind !== null, group_key: g.key, group_label: g.label };
      }),
      rows: out,
      page: { limit, next_cursor: nextCursor },
    };
  }

  private async buildRows(
    sites: { id: string; site_code: string; name: string | null; region_id: number }[], columns: GridColumn[], downloadable: number[] | null, from: string | undefined, to: string | undefined,
  ) {
    const ids = sites.map((s) => s.id);
    const scope = await this.docs.registerScopeSql();
    const tasks = await this.db.tx.$queryRaw<{ site_id: string; code: string; state: string }[]>(Prisma.sql`
      SELECT ti.site_id::text AS site_id, td.code, ti.state::text AS state FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
      WHERE ti.site_id = ANY(${ids}::uuid[])`);
    const slots = await this.db.tx.$queryRaw<(SlotAgg & { site_id: string; code: string })[]>(Prisma.sql`
      SELECT s.site_id::text AS site_id, dt.code, count(*)::int AS slots,
        count(*) FILTER (WHERE s.status = 'approved' AND (s.valid_to IS NULL OR s.valid_to >= current_date))::int AS approved,
        count(*) FILTER (WHERE s.status = 'approved' AND s.valid_to < current_date)::int AS expired,
        count(*) FILTER (WHERE s.status = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE s.status IN ('uploaded', 'in_review'))::int AS pending,
        count(*) FILTER (WHERE s.status = 'not_required')::int AS not_required
      FROM document_slots s JOIN document_types dt ON dt.id = s.doc_type_id
      WHERE s.site_id = ANY(${ids}::uuid[]) AND ${scope}
      GROUP BY s.site_id, dt.code`);
    const files = await this.db.tx.$queryRaw<(FileAgg & { site_id: string; code: string })[]>(Prisma.sql`
      SELECT s.site_id::text AS site_id, dt.code, count(*)::int AS files,
        count(*) FILTER (WHERE (${from ?? null}::date IS NULL OR f.uploaded_at::date >= ${from ?? null}::date)
                           AND (${to ?? null}::date IS NULL OR f.uploaded_at::date <= ${to ?? null}::date))::int AS in_range
      FROM document_files f JOIN document_slots s ON s.id = f.slot_id JOIN document_types dt ON dt.id = s.doc_type_id
      WHERE s.site_id = ANY(${ids}::uuid[]) AND f.is_current AND f.withdrawn_at IS NULL AND ${scope}
      GROUP BY s.site_id, dt.code`);
    const overrides = await this.db.tx.$queryRaw<{ site_id: string; code: string; reason: string }[]>(Prisma.sql`
      SELECT o.site_id::text AS site_id, dt.code, o.reason FROM document_site_overrides o JOIN document_types dt ON dt.id = o.doc_type_id
      WHERE o.site_id = ANY(${ids}::uuid[]) AND o.reverted_at IS NULL`);
    const taskBy = new Map<string, Map<string, string>>();
    for (const t of tasks) taskBy.set(t.site_id, (taskBy.get(t.site_id) ?? new Map()).set(t.code, t.state));
    const slotBy = new Map<string, SlotAgg>(slots.map((x) => [`${x.site_id}|${x.code}`, x]));
    const fileBy = new Map<string, FileAgg>(files.map((x) => [`${x.site_id}|${x.code}`, x]));
    const ovBy = new Map<string, string>(overrides.map((x) => [`${x.site_id}|${x.code}`, x.reason]));
    return sites.map((s) => {
      const cells: Record<string, unknown> = {};
      for (const c of columns) {
        const k = `${s.id}|${c.code}`;
        cells[c.code] = DocsGridService.cellOf({ column: c, taskStates: taskBy.get(s.id) ?? new Map(), slots: slotBy.get(k), files: fileBy.get(k), override: ovBy.get(k) });
      }
      return {
        site_id: s.id, site_code: s.site_code, site_name: s.name, region_id: s.region_id,
        download_allowed: downloadable === null || downloadable.includes(s.region_id), cells,
      };
    });
  }

  // ------------------------------------------------------------------------------------------------------------ saved view

  async getView(auth: AuthContext): Promise<{ columns: string[] }> {
    void auth; // own row only: the RLS policy on document_grid_views filters by the signed-in user
    const rows = await this.db.tx.$queryRaw<{ columns: string[] }[]>(Prisma.sql`SELECT columns FROM document_grid_views`);
    return { columns: rows[0]?.columns ?? [] };
  }

  async saveView(_auth: AuthContext, raw: unknown): Promise<void> {
    const b = parse(viewBody, raw);
    await this.call(() => this.db.tx.$executeRaw`SELECT docs_grid_view_save(${b.columns}::text[])`);
  }

  // ------------------------------------------------------------------------------------------------------------ site overrides, file move, library delete

  async setOverride(_auth: AuthContext, siteId: string, raw: unknown) {
    if (!uuidSchema.safeParse(siteId).success) throw problems.notFound();
    const b = parse(overrideBody, raw);
    const r = await this.call(() => this.db.tx.$queryRaw<{ r: { id: string; slots_changed: number } }[]>(Prisma.sql`SELECT docs_site_override_set(${siteId}::uuid, ${b.doc_code}::text, ${b.reason}::text) AS r`));
    return (r[0] as { r: { id: string; slots_changed: number } }).r;
  }

  async revertOverride(_auth: AuthContext, id: string, raw: unknown) {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const b = parse(reasonBody, raw);
    const r = await this.call(() => this.db.tx.$queryRaw<{ r: { id: string; slots_changed: number } }[]>(Prisma.sql`SELECT docs_site_override_revert(${id}::uuid, ${b.reason}::text) AS r`));
    return (r[0] as { r: { id: string; slots_changed: number } }).r;
  }

  async moveFile(_auth: AuthContext, fileId: string, raw: unknown) {
    if (!uuidSchema.safeParse(fileId).success) throw problems.notFound();
    const b = parse(moveBody, raw);
    const r = await this.call(() => this.db.tx.$queryRaw<{ r: Record<string, unknown> }[]>(Prisma.sql`SELECT docs_file_move(${fileId}::uuid, ${b.target_slot_id}::uuid, ${b.reason}::text) AS r`));
    return (r[0] as { r: Record<string, unknown> }).r;
  }

  async deleteType(auth: AuthContext, docTypeId: string, raw: unknown) {
    if (!uuidSchema.safeParse(docTypeId).success) throw problems.notFound();
    const b = parse(reasonBody, raw);
    await this.stepUp.require(auth);
    const r = await this.call(() => this.db.tx.$queryRaw<{ r: { mode: string } }[]>(Prisma.sql`SELECT admin_delete_document_type(${docTypeId}::uuid, ${b.reason}::text) AS r`));
    return (r[0] as { r: { mode: string } }).r;
  }
}

