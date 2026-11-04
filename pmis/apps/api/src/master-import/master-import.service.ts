import { Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { StorageService, newObjectKey } from '../documents/storage.service';
import { TaskViewService } from '../workflow/task-view.service';
import { TPL_SHEET } from '../templates/templates.service';
import type { UploadedFile } from '../templates/upload.interceptor';
import { guardXlsx } from '../templates/xlsx-guard';
import { OoxmlError, OoxmlWorkbook, SheetCell, masterHeaders } from './ooxml-reader';

/**
 * Q1 and Q211: the admin-only legacy import of the real Site Master (no `_tpl`) and the comparison report of the parallel run.
 * The file passes the same package guard as a template (macros, embedded objects, external links, size, zip bomb). The database identifies it,
 * checks its structure and writes the differences (mi_stage_run); nothing else changes until an admin applies the run (mi_apply_run, reason and
 * step-up), which enters the typed task columns through the TPL-MASTER staging and the normal batch flow. Every use goes to the System Log and the audit.
 */

export type LegacyRejectReason = 'not_xlsx' | 'macros_not_allowed' | 'size_or_rows_exceeded' | 'not_a_master' | 'structure_mismatch' | 'is_pmis_template';

const DIFF_KINDS = ['diff', 'missing_in_pmis', 'missing_in_master', 'exception'];
const RESOLUTIONS = ['open', 'pmis_correct', 'master_correct', 'fixed', 'ignored'];
const MAX_ROWS = 5000;

const applyBody = z.object({ mode: z.enum(['submit', 'draft']), reason: z.string().trim().min(3).max(2000) }).strict();
const resolveBody = z.object({ resolution: z.enum(['open', 'pmis_correct', 'master_correct', 'fixed', 'ignored']), note: z.string().max(1000).optional() }).strict();

interface RunRow {
  id: string; file_name: string; file_sha256: string; file_size: bigint; status: string; structure: Record<string, unknown>; summary: Record<string, unknown>;
  created_by: string; created_at: Date; applied_by: string | null; applied_at: Date | null; apply_reason: string | null; apply_mode: string | null; group_id: string | null;
  outcome: Record<string, unknown> | null; version: number; has_file: boolean; ts: string;
}

interface DiffRow {
  id: string; ord: number; sheet: string; row_no: number | null; source_ref: string | null; site_code: string | null; site_id: string | null; region_id: number | null;
  master_col: string | null; header: string | null; field: string | null; master_value: string | null; pmis_value: string | null; kind: string; reason: string; applicable: boolean;
  resolution: string; resolution_note: string | null; resolved_by: string | null; resolved_at: Date | null;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

@Injectable()
export class MasterImportService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly syslog: SyslogService,
    private readonly storage: StorageService,
    private readonly view: TaskViewService,
  ) {}

  private async canUse(): Promise<boolean> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT mi_can_use() AS ok`);
    return r[0]?.ok === true;
  }

  private async requireUse(): Promise<void> {
    if (!(await this.canUse())) throw problems.forbidden('action_forbidden', 'The legacy Master import is for a System Admin or a delegate of templates administer.');
  }

  private async reject(auth: AuthContext, requestId: string | undefined, reason: LegacyRejectReason | string, detail: string, ctx: Record<string, unknown>): Promise<never> {
    await this.syslog.write('warn', `legacy Master import rejected: ${reason}`, { reason, detail, ...ctx }, auth.user.id, requestId, 'master-import');
    throw new ProblemException(422, 'template_rejected', { detail, extra: { reason }, commit: true });
  }

  // ------------------------------------------------------------------ upload (preview)
  async upload(auth: AuthContext, file: UploadedFile | undefined, requestId: string | undefined): Promise<Record<string, unknown>> {
    await this.requireUse();
    if (!file || file.size === 0) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the Site Master as the form field "file".' }]);
    const sha = sha256(file.buffer);
    const ctx: Record<string, unknown> = { file_name: file.originalname.slice(0, 200), size: file.size, sha256: sha };
    const guard = guardXlsx(file.originalname, file.buffer);
    if (!guard.ok) return this.reject(auth, requestId, guard.reason ?? 'not_xlsx', guard.detail ?? 'The file is not accepted.', ctx);

    let wb: OoxmlWorkbook;
    try {
      wb = new OoxmlWorkbook(file.buffer, ['Master', 'Setting']);
    } catch (e) {
      if (e instanceof OoxmlError) return this.reject(auth, requestId, 'not_xlsx', 'The file could not be read as an Excel workbook.', ctx);
      throw e;
    }
    if (wb.sheetNames.includes(TPL_SHEET)) {
      return this.reject(auth, requestId, 'is_pmis_template', 'This file is a template issued by the PMIS (it has the _tpl sheet): upload it on the Templates page. The legacy path is for the real Master only.', ctx);
    }
    const master = wb.sheet('Master', MAX_ROWS + 10);
    const headers = master ? masterHeaders(master) : [];
    const rows: { row_no: number; cells: Record<string, SheetCell> }[] = [];
    if (master) {
      for (const [n, cells] of [...master.rows.entries()].sort((a, b) => a[0] - b[0])) {
        if (n <= 3) continue;
        // a row holds data when one of its cells is typed (the formula rows of an empty Master are skipped)
        if (![...cells.values()].some((c) => !c.f && c.v !== null)) continue;
        if (rows.length >= MAX_ROWS) return this.reject(auth, requestId, 'size_or_rows_exceeded', `The Master sheet has more than ${MAX_ROWS} rows.`, ctx);
        const out: Record<string, SheetCell> = {};
        for (const [L, c] of cells) if (c.v !== null && c.v !== '' && !c.e) out[L] = c;
        rows.push({ row_no: n, cells: out });
      }
    }
    const staff = this.staffRows(wb);

    // the original is kept as it was uploaded (never given a _tpl sheet)
    const key = newObjectKey('imports');
    await this.storage.store.put(key, file.buffer);
    let id: string;
    await this.db.tx.$executeRaw`SAVEPOINT mi_stage`;
    try {
      const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT mi_stage_run(${file.originalname.slice(0, 200)}::text, ${sha}::text, ${file.size}::bigint, ${key}::text, ${JSON.stringify(wb.sheetNames)}::jsonb,
          ${JSON.stringify(headers)}::jsonb, ${JSON.stringify(rows)}::jsonb, ${JSON.stringify(staff)}::jsonb)::text AS id`);
      id = (r[0] as { id: string }).id;
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT mi_stage`;
    } catch (e) {
      await this.storage.store.remove(key).catch(() => undefined);
      const p = e instanceof ProblemException ? e : mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT mi_stage`;
      if (p.code === 'template_rejected') {
        const reason = String((p.opts.extra as { reason?: string } | undefined)?.reason ?? 'not_a_master');
        return this.reject(auth, requestId, reason, p.opts.detail ?? 'The file is not the Site Master.', ctx);
      }
      throw p;
    }
    return this.getRun(auth, id);
  }

  /** The Project Staff block of the Setting sheet (Name, Role, Region, Status under the title "Project Staff"). */
  private staffRows(wb: OoxmlWorkbook): { row_no: number; name: string | null; role: string | null; region: string | null; status: string | null }[] {
    const s = wb.sheet('Setting', 2000, 200);
    if (!s) return [];
    const title = s.rows.get(1);
    let start: number | null = null;
    for (const [L, c] of title ?? []) if (String(c.v ?? '').trim().toLowerCase() === 'project staff') start = [...L].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    if (start === null) return [];
    const L = (i: number): string => {
      let out = '';
      for (let n = i; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
      return out;
    };
    const t = (c: SheetCell | undefined): string | null => (c && c.v !== null && !c.f ? String(c.v).trim() || null : null);
    const out: { row_no: number; name: string | null; role: string | null; region: string | null; status: string | null }[] = [];
    for (const [n, cells] of s.rows) {
      if (n < 3) continue;
      const row = { row_no: n, name: t(cells.get(L(start))), role: t(cells.get(L(start + 1))), region: t(cells.get(L(start + 2))), status: t(cells.get(L(start + 3))) };
      if (row.name || row.role) out.push(row);
    }
    return out.sort((a, b) => a.row_no - b.row_no).slice(0, 2000);
  }

  // ------------------------------------------------------------------ reads
  private runSelect(where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Prisma.Sql {
    return Prisma.sql`
      SELECT r.id::text AS id, r.file_name, r.file_sha256, r.file_size, r.status, r.structure, r.summary, r.created_by::text AS created_by, r.created_at,
        r.applied_by::text AS applied_by, r.applied_at, r.apply_reason, r.apply_mode, r.group_id::text AS group_id, r.outcome, r.version, r.storage_key IS NOT NULL AS has_file,
        to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
      FROM master_reconciliation_runs r WHERE ${where} ${tail}`;
  }

  private async runDtos(rows: RunRow[]): Promise<Record<string, unknown>[]> {
    const refs = await this.view.userRefs([...new Set(rows.flatMap((r) => [r.created_by, r.applied_by]).filter((x): x is string => !!x))]);
    return rows.map((r) => ({
      id: r.id, file_name: r.file_name, file_sha256: r.file_sha256, file_size: Number(r.file_size), status: r.status, structure: r.structure, summary: r.summary,
      created_by: refs.get(r.created_by) ?? { id: r.created_by }, created_at: r.created_at,
      applied_by: r.applied_by ? refs.get(r.applied_by) ?? { id: r.applied_by } : null, applied_at: r.applied_at, apply_reason: r.apply_reason, apply_mode: r.apply_mode,
      group_id: r.group_id, outcome: r.outcome, has_file: r.has_file, version: r.version,
    }));
  }

  async getRun(_auth: AuthContext, id: string): Promise<Record<string, unknown>> {
    await this.requireUse();
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const rows = await this.db.tx.$queryRaw<RunRow[]>(this.runSelect(Prisma.sql`r.id = ${id}::uuid`));
    if (!rows[0]) throw problems.notFound('The import run does not exist.');
    return (await this.runDtos(rows))[0] as Record<string, unknown>;
  }

  async listRuns(_auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    await this.requireUse();
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (cursor) conds.push(Prisma.sql`(r.created_at, r.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`);
    const rows = await this.db.tx.$queryRaw<RunRow[]>(this.runSelect(Prisma.join(conds, ' AND '), Prisma.sql`ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.runDtos(page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null } };
  }

  private diffWhere(id: string, q: Record<string, unknown>): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`d.run_id = ${id}::uuid`];
    const kind = oneParam(q, 'kind');
    if (kind !== undefined) {
      if (!DIFF_KINDS.includes(kind)) throw problems.validation([{ path: '/kind', code: 'invalid', message: `kind is one of ${DIFF_KINDS.join(', ')}.` }]);
      conds.push(Prisma.sql`d.kind = ${kind}`);
    }
    const res = oneParam(q, 'resolution');
    if (res !== undefined) {
      if (!RESOLUTIONS.includes(res)) throw problems.validation([{ path: '/resolution', code: 'invalid', message: `resolution is one of ${RESOLUTIONS.join(', ')}.` }]);
      conds.push(Prisma.sql`d.resolution = ${res}`);
    }
    const reason = oneParam(q, 'reason');
    if (reason !== undefined) {
      if (!/^[a-z_]{2,40}$/.test(reason)) throw problems.validation([{ path: '/reason', code: 'invalid', message: 'reason is a code.' }]);
      conds.push(Prisma.sql`d.reason = ${reason}`);
    }
    const site = oneParam(q, 'site_code');
    if (site !== undefined) conds.push(Prisma.sql`upper(d.site_code) = upper(${site.slice(0, 60)})`);
    return Prisma.join(conds, ' AND ');
  }

  async listDiffs(auth: AuthContext, id: string, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    await this.getRun(auth, id);
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 1);
    if (cursor && !/^[0-9]{1,9}$/.test(cursor[0] as string)) throw problems.badRequest('The cursor is not valid.');
    const rows = await this.db.tx.$queryRaw<DiffRow[]>(Prisma.sql`
      SELECT d.id::text AS id, d.ord, d.sheet, d.row_no, d.source_ref, d.site_code, d.site_id::text AS site_id, d.region_id, d.master_col, d.header, d.field, d.master_value,
        d.pmis_value, d.kind, d.reason, d.applicable, d.resolution, d.resolution_note, d.resolved_by::text AS resolved_by, d.resolved_at
      FROM master_reconciliation_diffs d WHERE ${this.diffWhere(id, q)} ${cursor ? Prisma.sql`AND d.ord > ${Number(cursor[0])}::int` : Prisma.empty}
      ORDER BY d.ord LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.diffDtos(page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([String(last.ord)]) : null } };
  }

  private async diffDtos(rows: DiffRow[]): Promise<Record<string, unknown>[]> {
    const refs = await this.view.userRefs([...new Set(rows.map((r) => r.resolved_by).filter((x): x is string => !!x))]);
    return rows.map((r) => ({
      id: r.id, sheet: r.sheet, row_no: r.row_no, source_ref: r.source_ref, site_code: r.site_code, site_id: r.site_id, region_id: r.region_id, master_col: r.master_col,
      header: r.header, field: r.field, master_value: r.master_value, pmis_value: r.pmis_value, kind: r.kind, reason: r.reason, applicable: r.applicable,
      resolution: r.resolution, resolution_note: r.resolution_note, resolved_by: r.resolved_by ? refs.get(r.resolved_by) ?? { id: r.resolved_by } : null, resolved_at: r.resolved_at,
    }));
  }

  // ------------------------------------------------------------------ writes
  private async call<T>(auth: AuthContext, sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT mi_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT mi_call`;
      return rows[0]?.r as T;
    } catch (e) {
      const p = e instanceof ProblemException ? e : mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT mi_call`;
      if (p.code === 'step_up_required') {
        throw new ProblemException(401, 'step_up_required', { detail: 'Confirm your password to continue.', step_up_method: auth.session.authMethod === 'local' ? 'password' : 'm365' });
      }
      throw p;
    }
  }

  async apply(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(applyBody, raw);
    await this.getRun(auth, id);
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    const outcome = await this.call<Record<string, unknown>>(auth,
      Prisma.sql`SELECT mi_apply_run(${id}::uuid, ${version}::int, ${body.mode}::text, ${body.reason}::text, ${stepOk}::boolean) AS r`);
    return { ...(await this.getRun(auth, id)), outcome };
  }

  async resolve(auth: AuthContext, id: string, raw: unknown): Promise<Record<string, unknown>> {
    await this.requireUse();
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const body = parse(resolveBody, raw);
    await this.call<Record<string, unknown>>(auth, Prisma.sql`SELECT mi_resolve_diff(${id}::uuid, ${body.resolution}::text, ${body.note ?? null}::text) AS r`);
    const rows = await this.db.tx.$queryRaw<DiffRow[]>(Prisma.sql`
      SELECT d.id::text AS id, d.ord, d.sheet, d.row_no, d.source_ref, d.site_code, d.site_id::text AS site_id, d.region_id, d.master_col, d.header, d.field, d.master_value,
        d.pmis_value, d.kind, d.reason, d.applicable, d.resolution, d.resolution_note, d.resolved_by::text AS resolved_by, d.resolved_at
      FROM master_reconciliation_diffs d WHERE d.id = ${id}::uuid`);
    if (!rows[0]) throw problems.notFound();
    return (await this.diffDtos(rows))[0] as Record<string, unknown>;
  }

  // ------------------------------------------------------------------ the original file and the XLSX report
  async downloadFile(auth: AuthContext, id: string): Promise<{ file: StreamableFile; name: string }> {
    const run = await this.getRun(auth, id);
    const k = await this.db.tx.$queryRaw<{ storage_key: string | null }[]>(Prisma.sql`SELECT storage_key FROM master_reconciliation_runs WHERE id = ${id}::uuid`);
    const key = k[0]?.storage_key;
    if (!key) throw problems.notFound('The original file is not stored.');
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('master_import.file_download', 'master_reconciliation_run', ${id}::text, NULL,
      ${JSON.stringify({ file_name: run.file_name, file_sha256: run.file_sha256 })}::jsonb, NULL)`);
    const stream = await this.storage.store.get(key);
    return { file: new StreamableFile(stream, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', length: Number(run.file_size) }), name: String(run.file_name) };
  }

  /** Q211: the comparison report as XLSX: site, field, both values, the source (Sheet!row), the reason and the resolution, with the run's file, hash, user and time. */
  async exportReport(auth: AuthContext, id: string, q: Record<string, unknown>): Promise<{ buffer: Buffer; name: string }> {
    const run = await this.getRun(auth, id);
    const rows = await this.db.tx.$queryRaw<DiffRow[]>(Prisma.sql`
      SELECT d.id::text AS id, d.ord, d.sheet, d.row_no, d.source_ref, d.site_code, d.site_id::text AS site_id, d.region_id, d.master_col, d.header, d.field, d.master_value,
        d.pmis_value, d.kind, d.reason, d.applicable, d.resolution, d.resolution_note, d.resolved_by::text AS resolved_by, d.resolved_at
      FROM master_reconciliation_diffs d WHERE ${this.diffWhere(id, q)} ORDER BY d.ord LIMIT 200000`);
    const dtos = await this.diffDtos(rows);
    const regions = new Map((await this.db.tx.$queryRaw<{ id: number; name_en: string }[]>(Prisma.sql`SELECT id, name_en FROM regions`)).map((r) => [r.id, r.name_en]));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GSDN PMIS';
    const ws = wb.addWorksheet('Differences');
    ws.columns = [
      { header: 'Site ID', key: 'site', width: 14 }, { header: 'Region', key: 'region', width: 12 }, { header: 'Source (Sheet!row)', key: 'src', width: 16 },
      { header: 'Master column', key: 'col', width: 10 }, { header: 'Field', key: 'field', width: 40 }, { header: 'PMIS field', key: 'pfield', width: 24 },
      { header: 'Master value', key: 'mv', width: 22 }, { header: 'PMIS value', key: 'pv', width: 22 }, { header: 'Kind', key: 'kind', width: 16 },
      { header: 'Reason', key: 'reason', width: 20 }, { header: 'Applicable', key: 'appl', width: 10 }, { header: 'Resolution', key: 'res', width: 16 },
      { header: 'Resolution note', key: 'note', width: 30 }, { header: 'Resolved by', key: 'by', width: 20 }, { header: 'Resolved at', key: 'at', width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    // values are written as text: nothing from the file can become a formula of the report
    const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    for (const d of dtos) {
      ws.addRow({
        site: txt(d.site_code), region: d.region_id ? regions.get(d.region_id as number) ?? null : null, src: txt(d.source_ref), col: txt(d.master_col), field: txt(d.header),
        pfield: txt(d.field), mv: txt(d.master_value), pv: txt(d.pmis_value), kind: txt(d.kind), reason: txt(d.reason), appl: d.applicable ? 'yes' : 'no', res: txt(d.resolution),
        note: txt(d.resolution_note), by: txt((d.resolved_by as { display_name?: string } | null)?.display_name), at: d.resolved_at ? (d.resolved_at as Date).toISOString() : null,
      });
    }
    for (let r = 2; r <= ws.rowCount; r++) ws.getRow(r).eachCell((c) => { if (typeof c.value === 'string') c.value = { richText: [{ text: c.value }] }; });
    ws.autoFilter = { from: 'A1', to: 'O1' };
    const info = wb.addWorksheet('Run');
    const by = run.created_by as { display_name?: string; employee_id?: string } | undefined;
    for (const [k, v] of [
      ['Run', run.id], ['File', run.file_name], ['SHA-256', run.file_sha256], ['Size (bytes)', run.file_size], ['Uploaded by', `${by?.display_name ?? ''} ${by?.employee_id ?? ''}`.trim()],
      ['Uploaded at', (run.created_at as Date).toISOString()], ['Status', run.status], ['Applied at', run.applied_at ? (run.applied_at as Date).toISOString() : ''],
      ['Summary', JSON.stringify(run.summary)],
    ] as [string, unknown][]) info.addRow([k, { richText: [{ text: String(v ?? '') }] }]);
    info.getColumn(1).width = 16;
    info.getColumn(2).width = 80;
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('master_import.export', 'master_reconciliation_run', ${id}::text, NULL,
      ${JSON.stringify({ rows: dtos.length, filters: { kind: oneParam(q, 'kind') ?? null, reason: oneParam(q, 'reason') ?? null, resolution: oneParam(q, 'resolution') ?? null } })}::jsonb, NULL)`);
    void auth;
    return { buffer, name: `master-comparison_${String(run.id).slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.xlsx` };
  }
}
