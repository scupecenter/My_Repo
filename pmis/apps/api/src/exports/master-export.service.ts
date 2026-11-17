import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { SyslogService } from '../auth/syslog.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { IdempotencyService } from '../common/idempotency.service';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { ProjectStatusService } from '../dashboard/project-status.service';
import { DbService } from '../db/db.service';
import { attachmentHeader } from '../documents/naming';
import { StorageService, newObjectKey } from '../documents/storage.service';
import { applyContext, jobContext } from '../logs/context';
import { loadRegisterMaps, type RegisterMap } from '../master-import/register-sheets';
import { RegistersService } from '../registers/registers.service';
import { SitesService } from '../sites/sites.service';
import {
  MASTER_FIRST_DATA_ROW, MASTER_SHEET, MASTER_SHEET_PARTS, NON_REGISTER, NOT_IN_MASTER, PART_KEYS, PART_LABELS, columnPart, masterHeaderRows, partSheet,
  registerLayout, SheetWriter, workbookWriter, type MasterColumn, type PartKey, type RegisterSheetColumn, type TplCol,
} from './master-layout';

const CODE = /^(cf:)?[a-z][a-z0-9_]{1,60}$/;
const viewSchema = z.object({
  source: z.enum(PART_KEYS),
  filters: z.record(z.unknown()),
  columns: z.array(z.string().regex(CODE)).min(1).max(400),
  sort: z.string().max(100).optional(),
}).strict();
const bodySchema = z.object({
  parts: z.array(z.enum(PART_KEYS)).max(PART_KEYS.length).optional(),
  view: viewSchema.optional(),
  regions: z.array(z.number().int().min(1).max(99)).min(1).max(7).optional(),
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
type Body = z.infer<typeof bodySchema>;
type View = z.infer<typeof viewSchema>;

export interface ExportColumnDto { code: string; label_en: string; label_ar: string; master_column: string | null; custom?: boolean; default_visible?: boolean }
export interface ExportPartDto { key: PartKey; label_en: string; label_ar: string; master_sheet: string; columns?: ExportColumnDto[] }

/** The job row of a Master export (document_export_jobs, scope.kind = master_export; migration 0038: owner-only RLS, writes through doc_job_*). */
interface JobRow {
  id: string;
  requested_by: string;
  scope: Scope;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string | number;
  file_count: number | null;
  size_bytes: bigint | null;
  storage_key: string | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
}
/** What the job does, as stored in document_export_jobs.scope. */
interface Scope {
  kind: 'master_export';
  export_kind: 'full' | 'partial' | 'view';
  parts: PartKey[];
  view: View | null;
  regions: number[] | null;
  as_of: string;
}

interface PartInfo { key: PartKey; label_en: string; label_ar: string; module: string; register: string | null; site_scoped: boolean; map: RegisterMap | undefined }
interface SheetCount { sheet: string; part: string; rows: number }

const MASTER_ROW_BATCH = 200;
const LIST_PAGE = '200';
const SITE_FIXED: Record<string, { ord: number | null; en: string; ar: string }> = {
  site_code: { ord: 2, en: 'Site ID', ar: 'رمز الموقع' },
  site_name: { ord: 4, en: 'Site Name', ar: 'اسم الموقع' },
  region: { ord: 5, en: 'Region', ar: 'المنطقة' },
  scenario: { ord: 26, en: 'Delivery Scenario', ar: 'سيناريو التسليم' },
  overall_status: { ord: 182, en: 'Overall Status', ar: 'الحالة العامة' },
  current_stage: { ord: null, en: 'Current Stage', ar: 'المرحلة الحالية' },
};
const TASK_COLUMNS: Record<string, [string, string]> = {
  site_code: ['Site ID', 'رمز الموقع'], task_code: ['Task Code', 'رمز المهمة'], task_name: ['Task', 'المهمة'], stage: ['Stage', 'المرحلة'],
  task_state: ['State', 'الحالة'], holder: ['Holder', 'المسؤول'], due_date: ['Due Date', 'تاريخ الاستحقاق'], sla_status: ['SLA', 'SLA'], approved_at: ['Approved', 'تاريخ الاعتماد'],
};
const REG_FIXED: Record<string, [string, string]> = { site_code: ['Site ID', 'رمز الموقع'], region: ['Region', 'المنطقة'], record_type: ['Record Type', 'نوع السجل'], state: ['State', 'الحالة'] };
const PS_COLUMNS: Record<string, [string, string]> = {
  activity_code: ['Activity', 'النشاط'], activity_name: ['Activity Name', 'اسم النشاط'], weight: ['Weight (%)', 'الوزن (%)'], progress_pct: ['Progress (%)', 'الإنجاز (%)'], planned_pct: ['Planned (%)', 'المخطط (%)'],
};
/** Filters the export passes to a list endpoint must be plain query values; paging is the export's own. */
const NOT_A_FILTER = new Set(['limit', 'cursor', 'offset']);

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const letterCode = (letter: string) => `m_${letter.toLowerCase()}`;

/**
 * Master-format export (contract 0.2.2, 0.2.3, 0.2.5, 0.15.34; CLAUDE.md "Full project export to a Master file, on demand"). The request checks the `export`
 * grant per part (B3) and records a job; the workbook is written after the response, outside the request transaction, by a worker that runs with the
 * requester's own verified context (so row-level security and the read paths limit the content exactly as they limit the screens), streams the file to a
 * temporary file with the exceljs streaming writer and stores it in object storage, encrypted. The caller downloads it for 7 days. Start, completion and
 * every download are audited with the parts, the filters and the row counts.
 */
@Injectable()
export class MasterExportService {
  private readonly log = new Logger('MasterExport');
  private readonly running = new Set<Promise<void>>();
  private maps: Map<string, RegisterMap> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly idem: IdempotencyService,
    private readonly syslog: SyslogService,
    private readonly sites: SitesService,
    private readonly registers: RegistersService,
    private readonly projectStatus: ProjectStatusService,
  ) {}

  /** Waits for the jobs started by this process (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private registerMaps(): Map<string, RegisterMap> {
    if (!this.maps) {
      try {
        this.maps = new Map(loadRegisterMaps().map((m) => [m.register, m]));
      } catch {
        this.maps = new Map();
      }
    }
    return this.maps;
  }

  // ------------------------------------------------------------------ parts and their columns
  /** Every part of the Master export, in dialog order (Car Dispatcher and Financial Advances are not part of the Master). */
  private async catalogue(): Promise<PartInfo[]> {
    const defs = new Map((await this.db.tx.$queryRaw<{ register_key: string; name_en: string; name_ar: string | null; module_key: string; site_scoped: boolean }[]>(Prisma.sql`
      SELECT register_key, name_en, name_ar, module_key, site_scoped FROM register_definitions WHERE is_active AND enabled`)).map((d) => [d.register_key, d]));
    const out: PartInfo[] = [];
    for (const key of PART_KEYS) {
      if (NOT_IN_MASTER.includes(key)) continue;
      const fixed = PART_LABELS[key];
      if (fixed) {
        out.push({ key, label_en: fixed[0], label_ar: fixed[1], module: key === 'project_status' ? 'dashboard' : 'sites', register: null, site_scoped: true, map: undefined });
        continue;
      }
      const d = defs.get(key);
      if (!d) continue;
      out.push({ key, label_en: d.name_en, label_ar: d.name_ar ?? d.name_en, module: d.module_key, register: key, site_scoped: d.site_scoped, map: this.registerMaps().get(key) });
    }
    return out;
  }

  /** The parts the caller may not export in any region: their Master columns are not offered in a view export. */
  private async blockedParts(): Promise<Set<PartKey>> {
    const cat = await this.catalogue();
    const out = new Set<PartKey>(PART_KEYS.filter((k) => !cat.some((p) => p.key === k)));
    for (const p of cat) {
      const r = await this.exportRegions(p);
      if (r !== null && r.length === 0) out.add(p.key);
    }
    return out;
  }

  /** The regions in which the caller may export a part (B3): null = all, [] = none. */
  private exportRegions(p: PartInfo): Promise<number[] | null> {
    return this.access.regions(p.module, 'export');
  }

  private async masterColumns(): Promise<MasterColumn[]> {
    return this.db.tx.$queryRaw<MasterColumn[]>(Prisma.sql`
      SELECT ord, letter, group_top, group_mid, NULLIF(name, '') AS name, header, owner FROM master_columns WHERE is_active ORDER BY ord`);
  }

  private async milestoneLetters(): Promise<Set<string>> {
    const r = await this.db.tx.$queryRaw<{ l: string }[]>(Prisma.sql`
      SELECT DISTINCT master_export_column AS l FROM stage_definitions WHERE master_export_column IS NOT NULL
      UNION SELECT DISTINCT master_export_column FROM phase_gate_rules WHERE master_export_column IS NOT NULL`);
    return new Set(r.map((x) => x.l));
  }

  /** Site custom fields that carry a Master export column and that the caller may read (field-level rules; System Admin sees all). */
  private async siteCustomFields(auth: AuthContext): Promise<{ code: string; label_en: string; label_ar: string | null; letter: string }[]> {
    return this.db.tx.$queryRaw(Prisma.sql`
      SELECT fd.code, fd.label_en, fd.label_ar, fd.master_export_column AS letter FROM field_definitions fd
      WHERE fd.entity_type = 'site' AND fd.is_active AND fd.master_export_column IS NOT NULL
        AND coalesce(app_resolve_field_access(${auth.user.id}::uuid, fd.id)::text, 'edit') <> 'hidden'
      ORDER BY length(fd.master_export_column), fd.master_export_column, fd.code`);
  }

  private async tplColumns(register: string): Promise<TplCol[]> {
    const r = await this.db.tx.$queryRaw<{ cols: TplCol[] | null }[]>(Prisma.sql`SELECT tpl_columns(${register}) AS cols`);
    return r[0]?.cols ?? [];
  }

  /** The stable column codes of a part (GET /exports/parts?include_columns=true and the check of ExportView.columns). */
  private async columnsOf(auth: AuthContext, p: PartInfo, cols?: MasterColumn[], ms?: Set<string>): Promise<ExportColumnDto[]> {
    if (p.key === 'tasks') return Object.entries(TASK_COLUMNS).map(([code, [en, ar]]) => ({ code, label_en: en, label_ar: ar, master_column: null, default_visible: true }));
    if (p.key === 'project_status') return Object.entries(PS_COLUMNS).map(([code, [en, ar]]) => ({ code, label_en: en, label_ar: ar, master_column: null, default_visible: true }));
    if (p.key === 'sites' || p.key === 'milestones') {
      const mcols = cols ?? (await this.masterColumns());
      const byOrd = new Map(mcols.map((c) => [c.ord, c]));
      const letters = ms ?? (await this.milestoneLetters());
      const out: ExportColumnDto[] = [];
      const fixed = p.key === 'sites' ? Object.entries(SITE_FIXED) : [['site_code', SITE_FIXED.site_code!] as const];
      for (const [code, f] of fixed) out.push({ code, label_en: f.en, label_ar: f.ar, master_column: f.ord ? (byOrd.get(f.ord)?.letter ?? null) : null, default_visible: true });
      const blocked = await this.blockedParts();
      for (const c of mcols) {
        if (p.key === 'milestones' && !letters.has(c.letter)) continue;
        const own = columnPart(c, letters);
        if (own !== 'all' && blocked.has(own)) continue; // a column of another part needs that part's export grant
        out.push({ code: letterCode(c.letter), label_en: c.header, label_ar: c.header, master_column: c.letter, default_visible: false });
      }
      if (p.key === 'sites') {
        for (const f of await this.siteCustomFields(auth)) out.push({ code: `cf:${f.code}`, label_en: f.label_en, label_ar: f.label_ar ?? f.label_en, master_column: f.letter, custom: true, default_visible: false });
      }
      return out.filter((c) => CODE.test(c.code));
    }
    const out: ExportColumnDto[] = Object.entries(REG_FIXED).map(([code, [en, ar]]) => ({ code, label_en: en, label_ar: ar, master_column: null, default_visible: true }));
    const layout = registerLayout(p.key, await this.tplColumns(p.register as string), p.map, p.site_scoped);
    for (const c of layout.columns) {
      if ((c.source !== 'field' && c.source !== 'custom') || !c.code || !CODE.test(c.code) || out.some((x) => x.code === c.code)) continue;
      out.push({ code: c.code, label_en: c.header, label_ar: c.header, master_column: null, custom: c.source === 'custom', default_visible: true });
    }
    return out;
  }

  /** GET /exports/parts: only the parts for which the caller holds the export grant in at least one region (B3); a System Admin sees all. */
  async parts(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: ExportPartDto[] }> {
    const withCols = q.include_columns === 'true' || q.include_columns === true;
    const items: ExportPartDto[] = [];
    const cols = withCols ? await this.masterColumns() : undefined;
    const ms = withCols ? await this.milestoneLetters() : undefined;
    for (const p of await this.catalogue()) {
      const r = await this.exportRegions(p);
      if (r !== null && r.length === 0) continue;
      const dto: ExportPartDto = { key: p.key, label_en: p.label_en, label_ar: p.label_ar, master_sheet: p.key === 'dismantle' ? MASTER_SHEET : partSheet(p.key, p.map) };
      if (withCols) dto.columns = await this.columnsOf(auth, p, cols, ms);
      items.push(dto);
    }
    return { items };
  }

  // ------------------------------------------------------------------ start
  async start(auth: AuthContext, raw: unknown, idemKey: string | undefined, onStarted: (go: () => void) => void): Promise<Record<string, unknown>> {
    const body: Body = parse(bodySchema, raw ?? {});
    if (body.parts?.length && body.view) {
      throw problems.validation([{ path: '/view', code: 'parts_and_view_exclusive', message: 'Send parts or view, not both.' }]);
    }
    if (body.parts && new Set(body.parts).size !== body.parts.length) throw problems.validation([{ path: '/parts', code: 'duplicate', message: 'A part is listed twice.' }]);
    if (body.regions && new Set(body.regions).size !== body.regions.length) throw problems.validation([{ path: '/regions', code: 'duplicate', message: 'A region is listed twice.' }]);
    const today = (await this.db.tx.$queryRaw<{ d: string }[]>(Prisma.sql`SELECT cal_today()::text AS d`))[0]?.d ?? new Date().toISOString().slice(0, 10);
    if (body.as_of && body.as_of > today) throw problems.validation([{ path: '/as_of', code: 'future_date', message: 'The date is in the future.' }]);
    if (body.as_of && body.as_of < today) {
      // the Master values are the live read model (site360_master_values); there is no history to rebuild an earlier day from (contract 0.15.34)
      throw problems.validation([{ path: '/as_of', code: 'as_of_unsupported', message: 'Only today can be exported: past values are not kept.' }]);
    }
    const asked = [...(body.parts ?? []), ...(body.view ? [body.view.source] : [])];
    const outside = asked.filter((k) => NOT_IN_MASTER.includes(k));
    if (outside.length) throw problems.validation(outside.map((k) => ({ path: `/parts/${k}`, code: 'not_in_master', message: 'This register is not part of the Master-format export.' })));

    const cat = await this.catalogue();
    const info = new Map(cat.map((p) => [p.key, p]));
    const regionsOf = new Map<PartKey, number[] | null>();
    for (const p of cat) regionsOf.set(p.key, await this.exportRegions(p));
    const allowed = (k: PartKey) => info.has(k) && !(Array.isArray(regionsOf.get(k)) && (regionsOf.get(k) as number[]).length === 0);

    let exportKind: Scope['export_kind'];
    let parts: PartKey[];
    if (body.view) {
      exportKind = 'view';
      parts = [body.view.source];
    } else if (body.parts?.length) {
      exportKind = 'partial';
      parts = body.parts;
    } else {
      exportKind = 'full';
      parts = cat.filter((p) => allowed(p.key)).map((p) => p.key);
      if (parts.length === 0) throw problems.forbidden('action_forbidden', 'You hold the export grant on no part of the project.');
    }
    const denied = parts.filter((k) => !allowed(k));
    if (denied.length) {
      throw new ProblemException(403, 'action_forbidden', {
        detail: 'You may not export these parts.',
        errors: denied.map((k) => ({ path: `/parts/${k}`, code: 'export_denied', message: 'You need the export grant on this part.' })),
      });
    }
    if (body.regions) {
      const scopes = parts.map((k) => regionsOf.get(k) ?? null);
      const bad = body.regions.filter((r) => !scopes.some((s) => s === null || s.includes(r)));
      if (bad.length) throw problems.validation(bad.map((r) => ({ path: '/regions', code: 'out_of_scope', message: `Region ${r} is outside your export regions.` })));
    }
    let view: View | null = null;
    if (body.view) {
      const offered = await this.columnsOf(auth, info.get(body.view.source) as PartInfo);
      const codes = new Set(offered.map((c) => c.code));
      const wrong = body.view.columns.map((c, i) => [c, i] as const).filter(([c]) => !codes.has(c));
      if (wrong.length) throw problems.validation(wrong.map(([c, i]) => ({ path: `/view/columns/${i}`, code: 'unknown_column', message: `${c} is not a column of ${body.view?.source}.` })));
      if (new Set(body.view.columns).size !== body.view.columns.length) throw problems.validation([{ path: '/view/columns', code: 'duplicate', message: 'A column is listed twice.' }]);
      if (body.view.source === 'tasks' && typeof body.view.filters.site_id !== 'string') {
        throw problems.validation([{ path: '/view/filters/site_id', code: 'required', message: 'The task list of a site is exported with its site_id.' }]);
      }
      view = body.view;
    }
    const scope: Scope = { kind: 'master_export', export_kind: exportKind, parts: exportKind === 'view' ? [] : parts, view, regions: body.regions ?? null, as_of: body.as_of ?? today };
    return this.idem.run(auth.user.id, 'startMasterExport', idemKey, body, async () => {
      const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT doc_job_create(${JSON.stringify(scope)}::jsonb)::text AS id`);
      const id = (r[0] as { id: string }).id;
      await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('master_export.start', 'master_export', ${id}::text, NULL,
        ${JSON.stringify({ kind: exportKind, parts, view, regions: scope.regions, as_of: scope.as_of })}::jsonb, NULL)`);
      onStarted(() => this.schedule(id, auth, scope));
      return { id, kind: 'master_export', status: 'queued', progress: 0, result_file_id: null, created_at: new Date(), finished_at: null };
    });
  }

  // ------------------------------------------------------------------ list and download
  private toDto(j: JobRow): Record<string, unknown> {
    const expired = j.status === 'done' && j.expires_at !== null && j.expires_at.getTime() < Date.now();
    return {
      id: j.id,
      kind: j.scope.export_kind,
      parts: j.scope.parts ?? [],
      ...(j.scope.view ? { view: j.scope.view } : {}),
      job_id: j.id,
      created_at: j.created_at,
      status: expired ? 'expired' : j.status,
      regions: j.scope.regions ?? [],
      as_of: j.scope.as_of,
      row_count: j.status === 'done' ? j.file_count : null,
      expires_at: j.status === 'done' ? j.expires_at : null,
      progress: Number(j.progress),
      ...(j.status === 'failed' && j.error ? { error: j.error } : {}),
    };
  }

  /** GET /exports/master: the caller's own exports, newest first (only the requester sees a job; the table's RLS lets admins read, this list does not). */
  async list(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    const limit = parseLimit(typeof q.limit === 'string' ? q.limit : undefined);
    const cursor = decodeCursor(typeof q.cursor === 'string' ? q.cursor : undefined, 2);
    const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`
      SELECT * FROM document_export_jobs
      WHERE requested_by = ${auth.user.id}::uuid AND scope ->> 'kind' = 'master_export' AND purged_at IS NULL
        AND (expires_at IS NULL OR expires_at > now() - interval '1 day')
        ${cursor ? Prisma.sql`AND (created_at, id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)` : Prisma.empty}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map((j) => this.toDto(j)), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null } };
  }

  /** The file name: the full Master, one part, or several parts. */
  private fileName(s: Scope, at: Date): string {
    if (s.export_kind === 'full') return `GSDN_Site_Master_${ymd(at)}.xlsx`;
    const parts = s.export_kind === 'view' && s.view ? [s.view.source] : s.parts;
    const tag = parts.length === 1 ? (parts[0] as string).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') : 'Parts';
    return `GSDN_${tag}_${ymd(at)}.xlsx`;
  }

  /** GET /exports/master/{id}/download: the requester's own finished file only (anyone else: 404), audited before the first byte. */
  async download(auth: AuthContext, rawId: string): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    if (!uuidSchema.safeParse(rawId).success) throw problems.notFound('The export does not exist.');
    const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT * FROM document_export_jobs WHERE id = ${rawId}::uuid`);
    const j = rows[0];
    if (!j || j.scope?.kind !== 'master_export' || j.requested_by !== auth.user.id) throw problems.notFound('The export does not exist.');
    if (j.status !== 'done' || !j.storage_key) throw new ProblemException(409, 'invalid_transition', { detail: `The export is ${j.status}.` });
    if ((j.expires_at && j.expires_at.getTime() < Date.now()) || (j as unknown as { purged_at: Date | null }).purged_at) {
      throw new ProblemException(410, 'export_expired', { detail: 'The export has expired: start it again.' });
    }
    const name = this.fileName(j.scope, j.created_at);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('master_export.download', 'master_export', ${j.id}::text, NULL,
      ${JSON.stringify({ export_id: j.id, download_name: name, kind: j.scope.export_kind, parts: j.scope.parts, view: j.scope.view, regions: j.scope.regions,
        row_count: j.file_count, size_bytes: j.size_bytes === null ? null : Number(j.size_bytes) })}::jsonb, NULL)`);
    return {
      file: new StreamableFile(await this.storage.store.get(j.storage_key), {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: attachmentHeader(name), length: Number(j.size_bytes),
      }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }

  // ------------------------------------------------------------------ the worker
  private schedule(id: string, auth: AuthContext, scope: Scope): void {
    const p = this.work(id, auth, scope).catch((e) => this.log.warn(`master export ${id}: ${e instanceof Error ? e.message : String(e)}`)).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  /** A transaction that carries the requester's verified context, exactly like a request (via = job). */
  private inContext<T>(auth: AuthContext, fn: () => Promise<T>, timeout = 30_000): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      await applyContext(tx, { ...jobContext('master_export'), userId: auth.user.id, sessionId: auth.session.id });
      return this.db.runIn(tx, fn);
    }, { maxWait: 10_000, timeout });
  }

  /** Progress in its own short transaction, so the dialog sees it while the long read runs. */
  private async progress(id: string, auth: AuthContext, value: number): Promise<void> {
    await this.db.client.$transaction(async (tx) => {
      await applyContext(tx, { ...jobContext('master_export'), userId: auth.user.id, sessionId: auth.session.id });
      await tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${id}::uuid, 'running', ${Math.min(0.99, value)}::numeric, NULL, NULL, NULL, NULL)`);
    }, { maxWait: 10_000, timeout: 10_000 }).catch(() => undefined);
  }

  private async work(id: string, auth: AuthContext, scope: Scope): Promise<void> {
    await new Promise((r) => setTimeout(r, 25)); // the request transaction that created the job commits first
    const tmp = join(tmpdir(), `pmis-master-${id}.xlsx`);
    let key: string | null = null;
    try {
      await this.inContext(auth, () => this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${id}::uuid, 'running', 0, NULL, NULL, NULL, NULL)`));
      await this.inContext(auth, async () => {
        const wb = workbookWriter(tmp);
        const counts = await this.writeBook(wb, id, auth, scope);
        await wb.commit();
        const size = (await fs.stat(tmp)).size;
        key = newObjectKey('exports');
        // generated by GSDN Workspace from database values only: stored encrypted, not sent to the virus scanner (Q195, as the log exports)
        await this.storage.store.putStream(key, createReadStream(tmp), size);
        const master = counts.find((c) => c.sheet === MASTER_SHEET);
        const rowCount = master ? master.rows : counts.reduce((n, c) => n + c.rows, 0);
        await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${id}::uuid, 'done', 1, ${rowCount}::int, ${size}::bigint, ${key}::text, NULL)`);
        await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('master_export.done', 'master_export', ${id}::text, NULL,
          ${JSON.stringify({ kind: scope.export_kind, parts: scope.parts, view: scope.view, regions: scope.regions, row_count: rowCount, sheets: counts, size_bytes: size })}::jsonb, NULL)`);
      }, 600_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      if (key) await this.storage.store.remove(key).catch(() => undefined);
      await this.inContext(auth, () => this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${id}::uuid, 'failed', NULL, NULL, NULL, NULL, ${msg.slice(0, 300)}::text)`)).catch(() => undefined);
      await this.syslog.write('error', 'master export failed', { job_id: id, error: msg });
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Writes every sheet of the export; returns the data rows per sheet. */
  private async writeBook(wb: ReturnType<typeof workbookWriter>, id: string, auth: AuthContext, scope: Scope): Promise<SheetCount[]> {
    const cat = await this.catalogue();
    const info = new Map(cat.map((p) => [p.key, p]));
    const regionsOf = new Map<PartKey, number[] | null>();
    for (const p of cat) regionsOf.set(p.key, intersect(await this.exportRegions(p), scope.regions));
    const counts: SheetCount[] = [];
    const regionNames = new Map((await this.db.tx.$queryRaw<{ id: number; name_en: string }[]>(Prisma.sql`SELECT id, name_en FROM regions`)).map((r) => [r.id, r.name_en]));

    if (scope.export_kind === 'view' && scope.view) {
      const v = scope.view;
      const p = info.get(v.source) as PartInfo;
      const regs = regionsOf.get(v.source) ?? null;
      if (v.source === 'sites' || v.source === 'milestones') counts.push(await this.masterViewSheet(wb, auth, v, regs, regionsOf));
      else if (v.source === 'tasks') counts.push(await this.tasksViewSheet(wb, auth, v, regs));
      else if (v.source === 'project_status') counts.push(await this.projectStatusSheet(wb, auth, regs, v.columns));
      else counts.push(await this.registerSheet(wb, auth, p, regs, regionNames, { filters: v.filters, columns: v.columns }));
    } else {
      const parts = scope.parts.filter((k) => info.has(k));
      const masterParts = parts.filter((k) => MASTER_SHEET_PARTS.includes(k));
      const steps = (masterParts.length ? 1 : 0) + parts.filter((k) => !NON_REGISTER.includes(k) || k === 'project_status').length;
      let done = 0;
      const tick = async () => { done++; await this.progress(id, auth, done / Math.max(1, steps)); };
      if (masterParts.length) {
        counts.push(await this.masterSheet(wb, auth, masterParts, regionsOf));
        await tick();
      }
      if (parts.includes('project_status')) {
        counts.push(await this.projectStatusSheet(wb, auth, regionsOf.get('project_status') ?? null, null));
        await tick();
      }
      for (const k of parts) {
        if (NON_REGISTER.includes(k)) continue;
        counts.push(await this.registerSheet(wb, auth, info.get(k) as PartInfo, regionsOf.get(k) ?? null, regionNames, null));
        await tick();
      }
    }
    // the last sheet says what the file holds (it is not a Master sheet: the comparison reads the sheets above)
    const about = new SheetWriter(wb.addWorksheet('Export Info'));
    const me = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${auth.user.id}::uuid`);
    const lines: [string, unknown][] = [
      ['Export', scope.export_kind], ['Parts', scope.export_kind === 'view' ? scope.view?.source : scope.parts.join(', ')],
      ['Filters', scope.view ? JSON.stringify(scope.view.filters) : ''], ['Columns', scope.view ? scope.view.columns.join(', ') : 'Master layout'],
      ['Regions', scope.regions ? scope.regions.map((r) => regionNames.get(r) ?? r).join(', ') : 'All of your export regions'], ['As of', scope.as_of],
      ['Generated at', new Date().toISOString()], ['Generated by', `${me[0]?.display_name ?? ''} ${me[0]?.employee_id?.trim() ?? ''}`.trim()],
      ['Personal columns', 'Landlord and contact columns are left empty (decision Q469).'],
      ...counts.map((c): [string, unknown] => [`Rows: ${c.sheet}`, c.rows]),
    ];
    let n = 1;
    for (const l of lines) about.write(n++, l, false);
    await about.commit();
    return counts;
  }

  // ------------------------------------------------------------------ the Master sheet
  /** The values of the Master columns of some sites, from the read model of SITE 360 (site360_master_values); register-owned values need the register's view grant in the site's region. */
  private async masterValues(auth: AuthContext, ids: string[], ords: number[], siteRegion: Map<string, number>): Promise<Map<string, Map<number, string | null>>> {
    const vals = await this.db.tx.$queryRaw<{ site_id: string; ord: number; value: string | null; register_key: string | null }[]>(Prisma.sql`
      SELECT v.site_id::text AS site_id, v.ord, v.value, v.register_key FROM site360_master_values v
      WHERE v.site_id = ANY(${ids}::uuid[]) AND v.ord = ANY(${ords}::int[])`);
    const keys = [...new Set(vals.map((v) => v.register_key).filter((k): k is string => k !== null))];
    const regs = new Map<string, number[] | null | false>();
    if (keys.length) {
      const modules = await this.db.tx.$queryRaw<{ register_key: string; module_key: string }[]>(Prisma.sql`SELECT register_key, module_key FROM register_definitions WHERE register_key = ANY(${keys}::text[])`);
      for (const m of modules) regs.set(m.register_key, await this.access.regions(m.module_key, 'view'));
    }
    const out = new Map<string, Map<number, string | null>>();
    for (const v of vals) {
      if (v.register_key !== null) {
        const r = regs.get(v.register_key);
        if (r === undefined || r === false || (r !== null && !r.includes(siteRegion.get(v.site_id) ?? -1))) continue;
      }
      const m = out.get(v.site_id) ?? new Map<number, string | null>();
      if (m.get(v.ord) == null) m.set(v.ord, v.value);
      out.set(v.site_id, m);
    }
    void auth;
    return out;
  }

  /**
   * The Master sheet of a full or partial export: the 187 columns in the Master's order and header rows, plus the site custom fields with a Master export
   * column. Every column is kept (the layout can be pasted into the Master); a part not chosen, or not exportable in the site's region, stays empty.
   */
  private async masterSheet(wb: ReturnType<typeof workbookWriter>, auth: AuthContext, parts: PartKey[], regionsOf: Map<PartKey, number[] | null>): Promise<SheetCount> {
    const cols = await this.masterColumns();
    const ms = await this.milestoneLetters();
    const custom = parts.includes('sites') ? await this.siteCustomFields(auth) : [];
    const owner = cols.map((c) => columnPart(c, ms));
    const sheet = new SheetWriter(wb.addWorksheet(MASTER_SHEET, { views: [{ state: 'frozen', xSplit: 2, ySplit: MASTER_FIRST_DATA_ROW - 1 }] }));
    const head = masterHeaderRows([...cols, ...custom.map((f, i) => ({ group_top: i === 0 ? 'CUSTOM FIELDS' : null, group_mid: null, name: `${f.label_en} (${f.letter})` }))]);
    head.forEach((r, i) => sheet.write(i + 1, r, false));
    const union = unionRegions(parts.map((k) => regionsOf.get(k) ?? null));
    const sites = await this.db.tx.$queryRaw<{ id: string; site_code: string; region_id: number; custom: Record<string, unknown> | null }[]>(Prisma.sql`
      SELECT s.id::text AS id, s.site_code, s.region_id, s.custom FROM sites s
      WHERE s.is_active ${union === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${union}::int[])`}
      ORDER BY s.site_code COLLATE "C"`);
    const ords = cols.map((c) => c.ord);
    let rowNo = MASTER_FIRST_DATA_ROW;
    for (let i = 0; i < sites.length; i += MASTER_ROW_BATCH) {
      const batch = sites.slice(i, i + MASTER_ROW_BATCH);
      const region = new Map(batch.map((s) => [s.id, s.region_id]));
      const values = await this.masterValues(auth, batch.map((s) => s.id), ords, region);
      for (const [j, s] of batch.entries()) {
        const v = values.get(s.id) ?? new Map<number, string | null>();
        const inPart = (k: PartKey | 'all') => {
          if (k === 'all') return true;
          if (!parts.includes(k)) return false;
          const r = regionsOf.get(k) ?? null;
          return r === null || r.includes(s.region_id);
        };
        const row: unknown[] = cols.map((c, ci) => (c.ord === 1 ? i + j + 1 : inPart(owner[ci] as PartKey | 'all') ? (v.get(c.ord) ?? null) : null));
        for (const f of custom) row.push(inPart('sites') ? (s.custom ?? {})[f.code] : null);
        sheet.write(rowNo++, row);
      }
    }
    await sheet.commit();
    return { sheet: MASTER_SHEET, part: parts.join(','), rows: sheet.rows };
  }

  /** Paged read of a list endpoint through its own service (its filters, its F3 filter tree, its visibility and field rules). */
  private async *pages(fetch: (q: Record<string, unknown>) => Promise<{ items: unknown[]; page: { next_cursor: string | null } }>, filters: Record<string, unknown>) {
    const q: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filters)) {
      if (NOT_A_FILTER.has(k) || v === null || v === undefined || v === '') continue;
      q[k] = Array.isArray(v) ? v.map(String).join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    let cursor: string | null = null;
    for (;;) {
      const r = await fetch({ ...q, limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
      yield r.items as Record<string, unknown>[];
      cursor = r.page.next_cursor;
      if (!cursor) return;
    }
  }

  /** "Export current view" of the Sites list or SITE 360: the rows of GET /sites with the same query, the chosen columns in screen order, Master header rows. */
  private async masterViewSheet(
    wb: ReturnType<typeof workbookWriter>, auth: AuthContext, v: View, regs: number[] | null, regionsOf: Map<PartKey, number[] | null>,
  ): Promise<SheetCount> {
    const cols = await this.masterColumns();
    const ms = await this.milestoneLetters();
    // a Master column owned by another part (milestones, tasks, dismantle) is written only where the caller may export that part
    const canPart = (own: PartKey | 'all', region: number): boolean => {
      if (own === 'all') return true;
      if (!regionsOf.has(own)) return false;
      const r = regionsOf.get(own) ?? null;
      return r === null || r.includes(region);
    };
    const byOrd = new Map(cols.map((c) => [c.ord, c]));
    const byLetter = new Map(cols.map((c) => [letterCode(c.letter), c]));
    const custom = new Map((await this.siteCustomFields(auth)).map((f) => [`cf:${f.code}`, f]));
    const spec = v.columns.map((code): { code: string; ord: number | null; own: PartKey | 'all'; head: { group_top: string | null; group_mid: string | null; name: string | null } } => {
      const fixed = SITE_FIXED[code];
      const mc = fixed ? (fixed.ord ? byOrd.get(fixed.ord) : undefined) : byLetter.get(code);
      if (mc) return { code, ord: mc.ord, own: fixed ? 'all' : columnPart(mc, ms), head: { group_top: mc.group_top, group_mid: mc.group_mid, name: mc.name ?? mc.header } };
      const cf = custom.get(code);
      return { code, ord: null, own: 'all', head: { group_top: null, group_mid: null, name: cf ? cf.label_en : (fixed?.en ?? code) } };
    });
    const sheet = new SheetWriter(wb.addWorksheet(MASTER_SHEET, { views: [{ state: 'frozen', ySplit: MASTER_FIRST_DATA_ROW - 1 }] }));
    masterHeaderRows(spec.map((s) => s.head)).forEach((r, i) => sheet.write(i + 1, r, false));
    const ords = spec.map((s) => s.ord).filter((o): o is number => o !== null);
    let rowNo = MASTER_FIRST_DATA_ROW;
    for await (const items of this.pages((q) => this.sites.list(auth, q) as Promise<{ items: unknown[]; page: { next_cursor: string | null } }>, { ...v.filters, ...(v.sort ? { sort: v.sort } : {}) })) {
      const page = items.filter((it) => regs === null || regs.includes(Number(it.region_id)));
      if (!page.length) continue;
      const ids = page.map((it) => String(it.id));
      const region = new Map(page.map((it) => [String(it.id), Number(it.region_id)]));
      const values = await this.masterValues(auth, ids, ords, region);
      const customs = custom.size
        ? new Map((await this.db.tx.$queryRaw<{ id: string; custom: Record<string, unknown> | null }[]>(Prisma.sql`SELECT id::text AS id, custom FROM sites WHERE id = ANY(${ids}::uuid[])`)).map((r) => [r.id, r.custom ?? {}]))
        : new Map<string, Record<string, unknown>>();
      for (const it of page) {
        const vals = values.get(String(it.id)) ?? new Map<number, string | null>();
        sheet.write(rowNo++, spec.map((s) => {
          if (s.code === 'current_stage') return it.next_milestone ?? null;
          if (s.code.startsWith('cf:')) return customs.get(String(it.id))?.[s.code.slice(3)] ?? null;
          if (s.ord === null || !canPart(s.own, Number(it.region_id))) return null;
          return vals.get(s.ord) ?? null;
        }));
      }
    }
    await sheet.commit();
    return { sheet: MASTER_SHEET, part: v.source, rows: sheet.rows };
  }

  /** "Export current view" of the task grid of a site: GET /sites/{id}/tasks with the same query (stage, stream, view, F3 filter), the chosen columns. */
  private async tasksViewSheet(wb: ReturnType<typeof workbookWriter>, auth: AuthContext, v: View, regs: number[] | null): Promise<SheetCount> {
    const sheet = new SheetWriter(wb.addWorksheet('Tasks', { views: [{ state: 'frozen', ySplit: 1 }] }));
    sheet.write(1, v.columns.map((c) => TASK_COLUMNS[c]?.[0] ?? c), false);
    const q: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v.filters)) if (k !== 'site_id' && x !== null && x !== undefined && x !== '') q[k] = typeof x === 'object' ? JSON.stringify(x) : String(x);
    const res = (await this.sites.tasks(auth, String(v.filters.site_id), q)) as { stages: { code: string; tasks: Record<string, unknown>[] }[] };
    const stage = typeof v.filters.stage_code === 'string' && v.filters.stage_code ? v.filters.stage_code : null;
    let n = 2;
    for (const st of res.stages) {
      if (stage && st.code !== stage) continue;
      for (const t of st.tasks) {
        if (regs !== null && !regs.includes(Number(t.region_id))) continue;
        const sla = (t.sla ?? {}) as Record<string, unknown>;
        const bic = (t.ball_in_court ?? null) as { holders?: { label?: string; employee_id?: string | null }[] } | null;
        const value: Record<string, unknown> = {
          site_code: t.site_code, task_code: t.task_code, task_name: t.name_en, stage: t.stage_code, task_state: t.state,
          holder: (bic?.holders ?? []).map((h) => [h.label, h.employee_id].filter(Boolean).join(' ')).join('; '),
          due_date: sla.due_date ?? null, sla_status: sla.colour ?? null, approved_at: t.approved_date ?? t.approved_at ?? null,
        };
        sheet.write(n++, v.columns.map((c) => value[c] ?? null));
      }
    }
    await sheet.commit();
    return { sheet: 'Tasks', part: 'tasks', rows: sheet.rows };
  }

  /** The Project Status sheet: the activities of the weight set in force with their weight, progress and plan (GET /project-status, same rules). */
  private async projectStatusSheet(wb: ReturnType<typeof workbookWriter>, auth: AuthContext, regs: number[] | null, columns: string[] | null): Promise<SheetCount> {
    const cols = columns ?? Object.keys(PS_COLUMNS);
    const sheet = new SheetWriter(wb.addWorksheet('Project Status'));
    sheet.write(1, cols.map((c) => PS_COLUMNS[c]?.[0] ?? c), false);
    // project-wide figures only for an exporter limited to no region; otherwise one block per export region (GET /project-status takes one region)
    const scopes: (number | null)[] = regs === null ? [null] : [...regs].sort((a, b) => a - b);
    let n = 2;
    for (const region of scopes) {
      const ps = (await this.projectStatus.get(auth, region === null ? {} : { region_id: String(region) })) as Record<string, unknown>;
      if (scopes.length > 1) sheet.write(n++, cols.map((_c, i) => (i === 0 ? `Region ${region}` : null)), false);
      for (const a of (Array.isArray(ps.activities) ? ps.activities : []) as Record<string, unknown>[]) {
        const value: Record<string, unknown> = {
          activity_code: a.code ?? a.activity_code ?? null, activity_name: a.name_en ?? a.name ?? null, weight: a.weight ?? null,
          progress_pct: a.progress_pct ?? a.actual_pct ?? null, planned_pct: a.planned_pct ?? null,
        };
        sheet.write(n++, cols.map((c) => value[c] ?? null));
      }
      const label = region === null ? 'Project' : `Region ${region}`;
      sheet.write(n + 1, cols.map((c) => (c === 'activity_code' ? label : c === 'progress_pct' ? ps.progress_pct : c === 'planned_pct' ? ps.planned_pct : null)), false);
      n += 3;
    }
    await sheet.commit();
    return { sheet: 'Project Status', part: 'project_status', rows: sheet.rows };
  }

  /**
   * A register sheet in its Master layout (register maps of the Master import read in reverse, or the template columns). The rows are the current
   * records the register list shows the caller (GET /registers/{key}/records: visibility, field rules, F3 filter), limited to the export regions; a
   * voided record is left out of a full or partial export. A view export keeps the list's own filters and the chosen columns in screen order.
   */
  private async registerSheet(
    wb: ReturnType<typeof workbookWriter>, auth: AuthContext, p: PartInfo, regs: number[] | null, regionNames: Map<number, string>,
    view: { filters: Record<string, unknown>; columns: string[] } | null,
  ): Promise<SheetCount> {
    const layout = registerLayout(p.key, await this.tplColumns(p.register as string), p.map, p.site_scoped);
    let columns: RegisterSheetColumn[] = layout.columns;
    if (view) {
      columns = view.columns.map((code): RegisterSheetColumn => {
        if (code === 'site_code') return { header: 'Site ID', source: 'site', code, personal: false };
        if (code === 'region') return { header: 'Region', source: 'region', code, personal: false };
        if (code === 'record_type') return { header: 'Record Type', source: 'record_type', code, personal: false };
        if (code === 'state') return { header: 'State', source: 'state', code, personal: false };
        return layout.columns.find((c) => c.code === code) ?? { header: code, source: 'none', code, personal: false };
      });
    }
    const sheet = new SheetWriter(wb.addWorksheet(layout.sheet, { views: [{ state: 'frozen', ySplit: layout.header_row }] }));
    for (let r = 1; r < layout.header_row; r++) sheet.write(r, [], false);
    sheet.write(layout.header_row, columns.map((c) => c.header), false);
    let n = layout.first_data_row;
    let no = 1;
    const filters = view ? view.filters : {};
    for await (const items of this.pages((q) => this.registers.listRecords(auth, p.register as string, q), filters)) {
      for (const it of items) {
        if (!view && it.state === 'voided') continue;
        const region = it.region_id === null || it.region_id === undefined ? null : Number(it.region_id);
        if (regs !== null && region !== null && !regs.includes(region)) continue;
        const data = (it.data ?? {}) as Record<string, unknown>;
        const cust = (it.custom ?? {}) as Record<string, unknown>;
        sheet.write(n++, columns.map((c) => {
          if (c.personal) return null; // Q469: personal columns are never loaded
          switch (c.source) {
            case 'row_no': return no;
            case 'site': return it.site_code ?? null;
            case 'region': return region === null ? null : (regionNames.get(region) ?? region);
            case 'record_type': return it.record_type ?? null;
            case 'state': return it.state ?? null;
            case 'record_id': return data.record_id ?? data.record_no ?? it.entity_id ?? null;
            case 'custom': return c.code ? (cust[c.code.replace(/^cf:/, '')] ?? cust[c.code] ?? null) : null;
            case 'field': return c.code ? (data[c.code] ?? null) : null;
            default: return null;
          }
        }));
        no++;
      }
    }
    await sheet.commit();
    return { sheet: layout.sheet, part: p.key, rows: sheet.rows };
  }
}

/** The part's export regions limited to the requested regions (null = no limit). */
function intersect(a: number[] | null, b: number[] | null): number[] | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((x) => b.includes(x));
}

function unionRegions(list: (number[] | null)[]): number[] | null {
  if (list.some((x) => x === null)) return null;
  return [...new Set(list.flat() as number[])];
}
