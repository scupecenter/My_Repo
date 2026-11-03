import { Injectable } from '@nestjs/common';
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
import { TaskViewService, UserRefDto } from '../workflow/task-view.service';
import { DocumentsService } from '../documents/documents.service';
import { DATA_SHEET, LISTS_SHEET, MASTER_INFO_PREFILLED, STREAM_INFO_PREFILLED, TPL_SHEET, TemplatesService, TplColumn, TplPart } from './templates.service';
import { UploadedFile, importMaxRows } from './upload.interceptor';
import { guardXlsx } from './xlsx-guard';

export type RejectReason =
  | 'size_or_rows_exceeded' | 'tpl_missing' | 'template_unknown_or_inactive' | 'outdated_version' | 'wrong_template' | 'checksum_mismatch' | 'import_not_allowed'
  | 'not_xlsx' | 'macros_not_allowed' | 'tpl_invalid';

const BATCH_STATUSES = ['parsing', 'validated', 'in_review', 'in_approval', 'partially_approved', 'approved', 'rejected', 'applied', 'undone', 'failed', 'discarded'];

const uploadBody = z.object({ template_id: z.string().max(60).optional(), task_id: z.string().uuid().optional() }).passthrough();
const decisionBody = z
  .object({
    action: z.enum(['review', 'approve', 'reject', 'discard']),
    scope: z.enum(['all', 'rows']),
    rows: z.array(z.object({ row_id: z.string().uuid(), decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional() }).strict()).max(2000).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

interface BatchRow {
  id: string;
  template_id: string;
  template_version: number;
  source: string;
  file_name: string;
  status: string;
  uploaded_by: string;
  created_at: Date;
  version: number;
  task_id: string | null;
  site_id: string | null;
  register_key: string | null;
  stream_code: string | null;
  group_id: string | null;
  part_sheet: string | null;
  note: string | null;
  module_key: string | null;
  c_create: bigint; c_update: bigint; c_unchanged: bigint; c_error: bigint; c_pending: bigint; c_approved: bigint; c_rejected: bigint; c_held: bigint;
  ts: string;
}

interface Outcome {
  submitted?: number;
  decided?: number;
  approved?: number;
  rejected?: number;
  held: { row_id: string; row_no: number; key: string | null; reason: string; record_id?: string | null }[];
  failed: { row_id: string; row_no: number; key: string | null; code: string; message?: string }[];
}

interface ParsedRow {
  row_no: number;
  sheet: string;
  site_code?: string;
  record_type?: string;
  record_id?: string;
  data: Record<string, unknown>;
  custom: Record<string, unknown>;
  pre_errors: { column: string; field: string; code: string; message: string }[];
}

interface ParsedStreamRow {
  row_no: number;
  sheet: string;
  site_code?: string;
  cells: Record<string, unknown>;
  pre_errors: { column: string; field: string; code: string; message: string }[];
}

/** A note about a whole upload (never blocking): a column or sheet the PMIS does not read, a part that was skipped. */
export interface UploadWarning {
  code: 'column_not_owned' | 'extra_column' | 'unknown_sheet' | 'part_skipped';
  sheet?: string;
  column?: string;
  count?: number;
  message: string;
}

const OWNER_TEXT: Record<string, string> = {
  calc: 'calculated by the PMIS', identity: 'owned by the RF & Design register', scope: 'owned by the site scope (Change Control)', baseline: 'owned by the Baseline',
  dismantle: 'owned by the Dismantle register (TPL-DIS)', issues: 'owned by the Issue Log (TPL-ISS)', row: 'a row number',
};

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const unitSeparator = String.fromCharCode(0x1f);

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);

@Injectable()
export class ImportService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly syslog: SyslogService,
    private readonly templates: TemplatesService,
    private readonly view: TaskViewService,
    private readonly documents: DocumentsService,
  ) {}

  // ------------------------------------------------------------------ upload
  private async reject(auth: AuthContext, requestId: string | undefined, reason: RejectReason, detail: string, ctx: Record<string, unknown>): Promise<never> {
    await this.syslog.write('warn', `template upload rejected: ${reason}`, { reason, detail, ...ctx }, auth.user.id, requestId, 'template-check');
    throw new ProblemException(422, 'template_rejected', { detail, extra: { reason }, commit: true });
  }

  async upload(auth: AuthContext, file: UploadedFile | undefined, rawBody: unknown, requestId: string | undefined): Promise<Record<string, unknown>> {
    // the right to import comes first: who may not import learns nothing about templates
    if (!(await this.access.hasGrant(auth, 'templates', 'import'))) {
      throw problems.forbidden('action_forbidden', 'You need to import on templates.');
    }
    const body = parse(uploadBody, rawBody ?? {});
    if (!file || file.size === 0) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the filled template as the form field "file".' }]);
    const ctx: Record<string, unknown> = { file_name: file.originalname.slice(0, 200), size: file.size, sha256: sha256(file.buffer) };

    const guard = guardXlsx(file.originalname, file.buffer);
    if (!guard.ok) return this.reject(auth, requestId, guard.reason as RejectReason, guard.detail ?? 'The file is not accepted.', ctx);

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    } catch {
      return this.reject(auth, requestId, 'not_xlsx', 'The file could not be read as an Excel workbook.', ctx);
    }

    // 1. the hidden sheet
    const tplSheet = wb.worksheets.find((w) => w.name === TPL_SHEET);
    if (!tplSheet) return this.reject(auth, requestId, 'tpl_missing', 'This file is not an approved PMIS template: the hidden _tpl sheet is missing. Download the template from the PMIS.', ctx);
    const kv = new Map<string, string>();
    tplSheet.eachRow((row) => {
      const k = this.text(row.getCell(1));
      if (k) kv.set(k, this.text(row.getCell(2)) ?? '');
    });
    const templateId = kv.get('template_id') ?? '';
    const versionText = kv.get('version') ?? '';
    if (!/^TPL-[A-Z0-9_-]{2,40}$/.test(templateId) || !/^[0-9]{1,6}$/.test(versionText)) {
      return this.reject(auth, requestId, 'tpl_invalid', 'The _tpl sheet of this file is not valid.', { ...ctx, template_id: templateId.slice(0, 60), version: versionText.slice(0, 12) });
    }
    const version = Number(versionText);
    Object.assign(ctx, { template_id: templateId, version });

    // 2. known and active template, current version
    const current = await this.templates.current(templateId);
    if (!current || !current.is_active) return this.reject(auth, requestId, 'template_unknown_or_inactive', `The template ${templateId} does not exist or is no longer in use.`, ctx);
    const issued = await this.templates.version(templateId, version);
    if (!issued) return this.reject(auth, requestId, 'tpl_invalid', `This file names version ${version} of ${templateId}, which was never issued.`, ctx);
    if (!issued.is_current) {
      return this.reject(auth, requestId, 'outdated_version', `This file was made from version ${version} of ${templateId}; the current version is ${current.current_version}. Download the template again.`,
        { ...ctx, current_version: current.current_version });
    }
    // 3. the template the user selected
    if (body.template_id && body.template_id !== templateId) {
      return this.reject(auth, requestId, 'wrong_template', `This file is the template ${templateId}, but ${body.template_id} was selected.`, { ...ctx, selected: body.template_id });
    }
    if (current.kind === 'master') {
      if (body.task_id) return this.reject(auth, requestId, 'wrong_template', 'TPL-MASTER has no per-task upload: upload the stream template of the task.', ctx);
      return this.uploadMaster(auth, requestId, ctx, wb, kv, issued as unknown as { columns: unknown; header_checksum: string }, templateId, version, file.originalname);
    }
    // 4. the header row
    const ws = wb.getWorksheet(kv.get('data_sheet') || DATA_SHEET) ?? wb.getWorksheet(DATA_SHEET);
    const cols = issued.columns;
    if (!ws) return this.reject(auth, requestId, 'checksum_mismatch', 'The Data sheet is missing.', ctx);
    const headers: string[] = [];
    for (let i = 1; i <= cols.length; i++) headers.push((this.text(ws.getRow(1).getCell(i)) ?? '').trim());
    let extra = false;
    for (let i = cols.length + 1; i <= Math.max(ws.getRow(1).cellCount, cols.length + 1); i++) if (this.text(ws.getRow(1).getCell(i))) extra = true;
    const sum = sha256(headers.join(unitSeparator));
    const claimed = kv.get('header_checksum');
    if (extra || sum !== issued.header_checksum || (claimed !== undefined && claimed !== issued.header_checksum)) {
      return this.reject(auth, requestId, 'checksum_mismatch', 'The header row of the file was changed. Use the template as it was issued, without adding, moving or renaming columns.', ctx);
    }

    // 5. the rows (values only; a formula is refused)
    const max = importMaxRows();
    const rows: (ParsedRow | ParsedStreamRow)[] = [];
    let tooMany = false;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1 || tooMany) return;
      const parsed = current.kind === 'stream' ? this.parseStreamRow(row, n, cols, ws.name, (i) => i + 1) : this.parseRow(row, n, cols);
      if (!parsed) return;
      if (rows.length >= max) { tooMany = true; return; }
      rows.push(parsed);
    });
    if (tooMany) return this.reject(auth, requestId, 'size_or_rows_exceeded', `The file has more than ${max} rows. Split it.`, { ...ctx, max_rows: max });
    if (rows.length === 0) throw problems.validation([{ path: '/file', code: 'empty', message: 'The file has no data rows.' }]);

    // 6. staging in the database, which decides every row again
    const payload = JSON.stringify(rows);
    const id = await this.stage(auth, requestId, ctx, templateId, version, issued.header_checksum, file.originalname, String(ctx.sha256), body.task_id ?? null, payload);
    return this.getBatch(auth, id);
  }

  /** Savepoint around a staging call: a refusal of the database (version, headers, rights) is logged and answered as template_rejected. */
  private async guarded<T>(auth: AuthContext, requestId: string | undefined, ctx: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT imp_stage`;
    try {
      const r = await run();
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT imp_stage`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT imp_stage`;
      if (p.code === 'template_rejected') {
        const reason = String((p.opts.extra as { reason?: string } | undefined)?.reason ?? 'template_unknown_or_inactive');
        return this.reject(auth, requestId, reason as RejectReason, p.opts.detail ?? 'The file is not accepted.', ctx);
      }
      throw p;
    }
  }

  private async stage(auth: AuthContext, requestId: string | undefined, ctx: Record<string, unknown>, templateId: string, version: number, checksum: string, fileName: string, sha: string, taskId: string | null, payload: string): Promise<string> {
    const id = await this.guarded(auth, requestId, ctx, async () => {
      const r = await this.db.tx.$queryRaw<{ id: string | null }[]>(Prisma.sql`
        SELECT imp_stage_batch(${templateId}::text, ${version}::int, ${checksum}::text, ${fileName}::text, ${sha}::text, ${taskId}::uuid, ${payload}::jsonb)::text AS id`);
      if (!r[0]) throw new ProblemException(500, 'internal_error', {});
      return r[0].id;
    });
    if (!id) throw problems.validation([{ path: '/file', code: 'empty', message: 'No cell of the file can be entered: the values are in columns the PMIS does not read.' }]);
    return id;
  }

  /**
   * TPL-MASTER: every sheet of the file is a part (the Master sheet, or the sheet of a register). The columns are found by their header, so a column added to the
   * file does not break the upload: it is ignored with a warning, as is a sheet the PMIS does not know and every value in a column the PMIS does not own. A sheet that
   * lacks an issued header is refused. The database then splits the Master sheet into one batch per stream, stages each register sheet as the register's own
   * template, and answers one batch per part (they share `group_id`).
   */
  private async uploadMaster(
    auth: AuthContext, requestId: string | undefined, ctx: Record<string, unknown>, wb: ExcelJS.Workbook, kv: Map<string, string>,
    issued: { columns: unknown; header_checksum: string }, templateId: string, version: number, fileName: string,
  ): Promise<Record<string, unknown>> {
    const parts = issued.columns as TplPart[];
    const claimed = kv.get('header_checksum');
    if (claimed !== undefined && claimed !== issued.header_checksum) {
      return this.reject(auth, requestId, 'checksum_mismatch', 'The header rows of the file were changed. Use the template as it was issued.', ctx);
    }
    const max = importMaxRows();
    const warnings: UploadWarning[] = [];
    const staged: { sheet: string; header_checksum: string; rows: unknown[] }[] = [];
    const helper = new Set([TPL_SHEET, LISTS_SHEET, 'Instructions', 'Columns']);
    for (const ws of wb.worksheets) {
      if (helper.has(ws.name)) continue;
      const part = parts.find((p) => p.sheet === ws.name);
      if (!part) {
        warnings.push({ code: 'unknown_sheet', sheet: ws.name, message: `The sheet "${ws.name}" is not part of ${templateId}: it is ignored.` });
        continue;
      }
      const head = ws.getRow(1);
      const byName = new Map<string, number>();
      for (let i = 1; i <= head.cellCount; i++) {
        const h = (this.text(head.getCell(i)) ?? '').trim();
        if (h && !byName.has(h)) byName.set(h, i);
      }
      const missing = part.columns.filter((c) => !byName.has(c.header)).map((c) => c.header);
      if (missing.length > 0) {
        return this.reject(auth, requestId, 'checksum_mismatch',
          `The sheet "${ws.name}" lacks the column(s) ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}. Use the template as it was issued.`, { ...ctx, sheet: ws.name });
      }
      const known = new Set(part.columns.map((c) => c.header));
      for (const h of byName.keys()) {
        if (!known.has(h)) warnings.push({ code: 'extra_column', sheet: ws.name, column: h, message: `The column "${h}" is not owned by the PMIS: it is ignored.` });
      }
      const colAt = (i: number): number | undefined => byName.get((part.columns[i] as TplColumn).header);
      const ignored = new Map<string, number>();
      const rows: unknown[] = [];
      let tooMany = false;
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n === 1 || tooMany) return;
        const parsed = part.kind === 'master'
          ? this.parseStreamRow(row, n, part.columns, ws.name, colAt, { ignored, prefilled: MASTER_INFO_PREFILLED, countDerived: kv.get('prefilled') !== 'yes' })
          : this.parseRow(row, n, part.columns, colAt, ws.name);
        if (!parsed) return;
        if (rows.length >= max) { tooMany = true; return; }
        rows.push(parsed);
      });
      if (tooMany) return this.reject(auth, requestId, 'size_or_rows_exceeded', `The sheet "${ws.name}" has more than ${max} rows. Split it.`, { ...ctx, max_rows: max, sheet: ws.name });
      for (const [h, count] of ignored) {
        const col = part.columns.find((c) => c.header === h);
        warnings.push({ code: 'column_not_owned', sheet: ws.name, column: h, count, message: `The column "${h}" is ${OWNER_TEXT[col?.owner ?? 'calc'] ?? 'not owned by the PMIS'}: ${count} value(s) ignored.` });
      }
      if (rows.length > 0) staged.push({ sheet: ws.name, header_checksum: sha256(part.columns.map((c) => c.header).join(unitSeparator)), rows });
    }
    if (staged.length === 0) throw problems.validation([{ path: '/file', code: 'empty', message: 'The file has no data rows.' }]);

    const payload = JSON.stringify(staged);
    const result = await this.guarded(auth, requestId, ctx, async () => {
      const r = await this.db.tx.$queryRaw<{ r: { group_id: string; batches: { id: string }[]; skipped: { sheet: string; kind: string; ref: string; reason?: string; detail?: string }[] } }[]>(Prisma.sql`
        SELECT imp_stage_master(${templateId}::text, ${version}::int, ${fileName}::text, ${String(ctx.sha256)}::text, ${payload}::jsonb) AS r`);
      const out = r[0]?.r;
      if (!out) throw new ProblemException(500, 'internal_error', {});
      return out;
    });
    for (const sk of result.skipped) {
      warnings.push({ code: 'part_skipped', sheet: sk.sheet, message: `${sk.sheet}${sk.kind === 'stream' ? ` (${sk.ref})` : ''} was not staged: ${sk.detail ?? sk.reason ?? 'refused'}` });
    }
    if (result.batches.length === 0) {
      throw problems.validation([{ path: '/file', code: 'empty', message: 'No cell of the file can be entered: the values are in columns the PMIS does not read.' }]);
    }
    const dtos: Record<string, unknown>[] = [];
    for (const b of result.batches) dtos.push(await this.getBatch(auth, b.id));
    return { ...(dtos[0] as Record<string, unknown>), group_id: result.group_id, parts: dtos, warnings };
  }

  private readCell(cell: ExcelJS.Cell): { kind: 'empty' } | { kind: 'formula' } | { kind: 'error' } | { kind: 'value'; val: unknown } {
    const v = cell.value;
    if (v === null || v === undefined) return { kind: 'empty' };
    let val: unknown = v;
    if (typeof v === 'object' && !(v instanceof Date)) {
      const o = v as { formula?: unknown; sharedFormula?: unknown; error?: unknown; text?: unknown; richText?: { text: string }[] };
      if (o.formula !== undefined || o.sharedFormula !== undefined) return { kind: 'formula' };
      if (o.error !== undefined) return { kind: 'error' };
      if (Array.isArray(o.richText)) val = o.richText.map((x) => x.text).join('');
      else if (typeof o.text === 'string') val = o.text;
      else return { kind: 'empty' };
    }
    if (typeof val === 'string') {
      // control characters (other than tab, line feed and carriage return) are never part of a value
      // eslint-disable-next-line no-control-regex
      val = val.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
      if (val === '') return { kind: 'empty' };
      if ((val as string).startsWith('=')) return { kind: 'formula' };
    }
    return { kind: 'value', val };
  }

  /**
   * One row of a stream template or of the Master sheet: the Site ID and the cells of the task columns, keyed by column code. A grey task column is sent too (the
   * database compares it with what the PMIS holds and reports a difference, never reads it); a grey info column is only counted for the warning of the upload.
   */
  private parseStreamRow(
    row: ExcelJS.Row, n: number, cols: TplColumn[], sheet: string, colAt: (i: number) => number | undefined,
    notes?: { ignored: Map<string, number>; prefilled: Set<string>; countDerived?: boolean },
  ): ParsedStreamRow | null {
    const out: ParsedStreamRow = { row_no: n, sheet, cells: {}, pre_errors: [] };
    let any = false;
    cols.forEach((c, i) => {
      const at = colAt(i);
      if (at === undefined) return;
      const r = this.readCell(row.getCell(at));
      if (r.kind === 'empty') return;
      if (c.kind === 'site') {
        if (r.kind === 'value') { out.site_code = String(r.val instanceof Date ? r.val.toISOString() : r.val).trim(); any = true; }
        return;
      }
      if (c.kind === 'info') {
        if (r.kind === 'value' && notes && !notes.prefilled.has(c.code) && !STREAM_INFO_PREFILLED.has(c.code)) notes.ignored.set(c.header, (notes.ignored.get(c.header) ?? 0) + 1);
        return;
      }
      if (c.kind !== 'task') return;
      if (c.derived) {
        if (r.kind === 'value') {
          out.cells[c.code] = this.typed(c, r.val);
          // a file that was not pre-filled has nothing typed in a grey column that the PMIS put there: the value is the user's, and it is ignored
          if (notes?.countDerived) notes.ignored.set(c.header, (notes.ignored.get(c.header) ?? 0) + 1);
        }
        return;
      }
      any = true;
      if (r.kind === 'formula') { out.pre_errors.push({ column: c.header, field: c.code, code: 'formula_not_allowed', message: 'Cells must hold values, not formulas.' }); return; }
      if (r.kind === 'error') { out.pre_errors.push({ column: c.header, field: c.code, code: 'cell_error', message: 'The cell holds an error value.' }); return; }
      out.cells[c.code] = this.typed(c, r.val);
    });
    return any ? out : null;
  }

  private text(cell: ExcelJS.Cell): string | null {
    const v = cell.value;
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      const o = v as { text?: unknown; richText?: { text: string }[]; result?: unknown; formula?: unknown };
      if (o.formula !== undefined) return null;
      if (Array.isArray(o.richText)) return o.richText.map((x) => x.text).join('');
      if (typeof o.text === 'string') return o.text;
    }
    return null;
  }

  /** One data row. Blank cells are left out; a formula, an error value or text that starts with "=" is a cell error. A row with no values is skipped. */
  private parseRow(row: ExcelJS.Row, n: number, cols: TplColumn[], colAt: (i: number) => number | undefined = (i) => i + 1, sheet = DATA_SHEET): ParsedRow | null {
    const out: ParsedRow = { row_no: n, sheet, data: {}, custom: {}, pre_errors: [] };
    let any = false;
    const fail = (c: TplColumn, code: string, message: string) => out.pre_errors.push({ column: c.header, field: c.code, code, message });
    cols.forEach((c, i) => {
      const at = colAt(i);
      if (at === undefined) return;
      const cell = row.getCell(at);
      const v = cell.value;
      if (v === null || v === undefined) return;
      if (c.derived) return; // grey columns are never read
      let val: unknown = null;
      if (typeof v === 'object' && !(v instanceof Date)) {
        const o = v as { formula?: unknown; sharedFormula?: unknown; error?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: unknown };
        if (o.formula !== undefined || o.sharedFormula !== undefined) { fail(c, 'formula_not_allowed', 'Cells must hold values, not formulas.'); any = true; return; }
        if (o.error !== undefined) { fail(c, 'cell_error', 'The cell holds an error value.'); any = true; return; }
        if (Array.isArray(o.richText)) val = o.richText.map((x) => x.text).join('');
        else if (typeof o.text === 'string') val = o.text;
        else return;
      } else val = v;
      if (typeof val === 'string') {
        // control characters (other than tab, line feed and carriage return) are never part of a value
        // eslint-disable-next-line no-control-regex
        val = val.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
        if (val === '') return;
        if ((val as string).startsWith('=')) { fail(c, 'formula_not_allowed', 'Text that starts with "=" is not accepted.'); any = true; return; }
      }
      any = true;
      if (c.kind === 'site') { out.site_code = String(val instanceof Date ? val.toISOString() : val).trim(); return; }
      if (c.kind === 'record_type') { out.record_type = String(val).trim(); return; }
      if (c.kind === 'record_id') { out.record_id = String(val).trim(); return; }
      const target = c.kind === 'custom' ? out.custom : out.data;
      target[c.code] = this.typed(c, val);
    });
    return any ? out : null;
  }

  private typed(c: TplColumn, v: unknown): unknown {
    if (c.type === 'date') {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString().slice(0, 10);
      if (typeof v === 'number' && v > 0 && v < 100000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
      return String(v);
    }
    if (c.type === 'yes_no') {
      if (typeof v === 'boolean') return v;
      const w = String(v).trim().toLowerCase();
      return TRUE_WORDS.has(w) ? true : FALSE_WORDS.has(w) ? false : String(v);
    }
    if (c.type === 'number') return typeof v === 'number' ? v : String(v).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return typeof v === 'string' ? v : String(v);
  }

  // ------------------------------------------------------------------ reads
  /** Registers whose batches the caller may see: view on the register's module (the uploader always sees their own). */
  private async viewableRegisters(): Promise<string[]> {
    const defs = await this.db.tx.$queryRaw<{ register_key: string; module_key: string }[]>(Prisma.sql`SELECT register_key, module_key FROM register_definitions WHERE is_active AND enabled`);
    const out: string[] = [];
    for (const d of defs) {
      const regs = await this.access.regions(d.module_key, 'view');
      if (regs === null || regs.length > 0) out.push(d.register_key);
    }
    return out;
  }

  private batchSelect(where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Prisma.Sql {
    return Prisma.sql`
      SELECT b.id::text AS id, d.template_id, v.version AS template_version, b.source, b.file_name, imp_status_of(b.id) AS status, b.uploaded_by::text AS uploaded_by, b.created_at,
        b.version, b.task_id::text AS task_id, b.site_id::text AS site_id, b.register_key, b.stream_code, b.group_id::text AS group_id, b.part_sheet, b.note, coalesce(rd.module_key, CASE WHEN b.stream_code IS NOT NULL THEN 'sites' END) AS module_key,
        c.c_create, c.c_update, c.c_unchanged, c.c_error, c.c_pending, c.c_approved, c.c_rejected, c.c_held,
        to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
      FROM import_batches b
      JOIN template_versions v ON v.id = b.template_version_id
      JOIN template_definitions d ON d.id = v.template_def_id
      LEFT JOIN register_definitions rd ON rd.register_key = b.register_key
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE x.action = 'create') AS c_create, count(*) FILTER (WHERE x.action = 'update') AS c_update,
          count(*) FILTER (WHERE x.action = 'unchanged') AS c_unchanged, count(*) FILTER (WHERE x.action = 'error') AS c_error,
          count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'pending') AS c_pending,
          count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'approved') AS c_approved,
          count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'rejected') AS c_rejected,
          count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'pending_previous_approval') AS c_held
        FROM v_import_rows x WHERE x.batch_id = b.id) c
      WHERE ${where}
      ${tail}`;
  }

  private async dtos(rows: BatchRow[]): Promise<Record<string, unknown>[]> {
    const refs = await this.view.userRefs([...new Set(rows.map((r) => r.uploaded_by))]);
    return rows.map((r) => {
      const status = r.status;
      const dto: Record<string, unknown> = {
        id: r.id,
        template_id: r.template_id,
        template_version: r.template_version,
        source: r.source === 'upload' ? 'template' : r.source,
        file_name: r.file_name,
        status,
        current_level: status === 'validated' ? 1 : 2,
        levels_required: 2,
        counts: {
          create: Number(r.c_create), update: Number(r.c_update), unchanged: Number(r.c_unchanged), error: Number(r.c_error),
          pending: Number(r.c_pending), approved: Number(r.c_approved), rejected: Number(r.c_rejected), held: Number(r.c_held),
        },
        job_id: null,
        task_id: r.task_id,
        site_id: r.site_id,
        register_key: r.register_key,
        stream: r.stream_code,
        group_id: r.group_id,
        part_sheet: r.part_sheet,
        note: r.note,
        uploaded_at: r.created_at,
        version: r.version,
      };
      const u: UserRefDto | undefined = refs.get(r.uploaded_by);
      if (u) dto.uploaded_by = u;
      return dto;
    });
  }

  private async visible(auth: AuthContext): Promise<Prisma.Sql> {
    const keys = await this.viewableRegisters();
    const siteRegs = await this.access.regions('sites', 'view');
    const sites = siteRegs === null || siteRegs.length > 0;
    return Prisma.sql`(b.uploaded_by = ${auth.user.id}::uuid OR b.register_key = ANY(${keys}::text[]) ${sites ? Prisma.sql`OR b.stream_code IS NOT NULL` : Prisma.empty})`;
  }

  async getBatch(auth: AuthContext, id: string): Promise<Record<string, unknown>> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.access.requireModuleView(auth, 'templates');
    const rows = await this.db.tx.$queryRaw<BatchRow[]>(this.batchSelect(Prisma.sql`b.id = ${id}::uuid AND ${await this.visible(auth)}`));
    const row = rows[0];
    if (!row) throw problems.notFound('The batch does not exist or is not visible to you.');
    const [dto] = await this.dtos([row]);
    if (!dto) throw problems.notFound();
    return dto;
  }

  async list(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    await this.access.requireModuleView(auth, 'templates');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const status = oneParam(q, 'status');
    if (status !== undefined && !BATCH_STATUSES.includes(status)) throw problems.validation([{ path: '/status', code: 'invalid', message: `status is one of ${BATCH_STATUSES.join(', ')}.` }]);
    const template = oneParam(q, 'template_id');
    const conds: Prisma.Sql[] = [await this.visible(auth)];
    if (status !== undefined) conds.push(Prisma.sql`imp_status_of(b.id) = ${status}`);
    if (template !== undefined) conds.push(Prisma.sql`d.template_id = ${template}`);
    const reg = oneParam(q, 'register_key');
    if (reg !== undefined) conds.push(Prisma.sql`b.register_key = ${reg}`);
    const stream = oneParam(q, 'stream');
    if (stream !== undefined) conds.push(Prisma.sql`b.stream_code = ${stream}`);
    const group = oneParam(q, 'group_id');
    if (group !== undefined) {
      if (!uuidSchema.safeParse(group).success) throw problems.validation([{ path: '/group_id', code: 'invalid', message: 'group_id is a uuid.' }]);
      conds.push(Prisma.sql`b.group_id = ${group}::uuid`);
    }
    if (cursor) conds.push(Prisma.sql`(b.created_at, b.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`);
    const rows = await this.db.tx.$queryRaw<BatchRow[]>(this.batchSelect(Prisma.join(conds, ' AND '), Prisma.sql`ORDER BY b.created_at DESC, b.id DESC LIMIT ${limit + 1}`));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.dtos(page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null } };
  }

  async listRows(auth: AuthContext, id: string, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    await this.getBatch(auth, id);
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 3);
    if (cursor && !(/^[0-9]{1,9}$/.test(cursor[0] as string) && /^[0-9]{1,9}$/.test(cursor[1] as string) && uuidSchema.safeParse(cursor[2]).success)) {
      throw problems.badRequest('The cursor is not valid.');
    }
    const action = oneParam(q, 'action');
    if (action !== undefined && !['create', 'update', 'unchanged', 'error'].includes(action)) throw problems.validation([{ path: '/action', code: 'invalid', message: 'action is create, update, unchanged or error.' }]);
    const decision = oneParam(q, 'decision');
    if (decision !== undefined && !['pending', 'approved', 'rejected', 'pending_previous_approval'].includes(decision)) {
      throw problems.validation([{ path: '/decision', code: 'invalid', message: 'decision is pending, approved, rejected or pending_previous_approval.' }]);
    }
    const rows = await this.db.tx.$queryRaw<{
      id: string; sheet: string; row_no: number; row_key: string | null; action: string; diff: Record<string, unknown> | null; errors: unknown[] | null; eff_decision: string;
      decided_by: string | null; decision_note: string | null; register_record_id: string | null; site_code: string | null; record_type: string | null; hold_reason: string | null; record_state: string | null;
      task_code: string | null; task_id: string | null; site_id: string | null; warnings: unknown[] | null; source_ref: string | null; ord: number;
    }[]>(Prisma.sql`
      SELECT r.id::text AS id, r.sheet, r.row_no, r.row_key, r.action, r.diff, r.errors, r.eff_decision, r.decided_by::text AS decided_by, r.decision_note,
        r.register_record_id::text AS register_record_id, r.site_code, r.record_type, r.hold_reason, r.record_state,
        r.task_code, r.task_instance_id::text AS task_id, r.site_id::text AS site_id, r.warnings, r.source_ref, r.ord
      FROM v_import_rows r
      WHERE r.batch_id = ${id}::uuid
        ${action !== undefined ? Prisma.sql`AND r.action = ${action}` : Prisma.empty}
        ${decision !== undefined ? Prisma.sql`AND r.eff_decision = ${decision} AND r.action IN ('create', 'update')` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (r.ord, r.row_no, r.id) > (${Number(cursor[0])}::int, ${Number(cursor[1])}::int, ${String(cursor[2])}::uuid)` : Prisma.empty}
      ORDER BY r.ord, r.row_no, r.id LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const refs = await this.view.userRefs([...new Set(page.map((r) => r.decided_by).filter((x): x is string => !!x))]);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => {
        const item: Record<string, unknown> = {
          id: r.id,
          sheet: r.sheet,
          row_no: r.row_no,
          key: r.row_key,
          action: r.action,
          diff: r.diff ?? {},
          errors: r.errors ?? [],
          decision: r.eff_decision,
          note: r.decision_note,
          site_code: r.site_code,
          record_type: r.record_type,
          record_id: r.register_record_id,
          task_code: r.task_code,
          task_id: r.task_id,
          site_id: r.site_id,
          warnings: r.warnings ?? [],
          source_ref: r.source_ref,
        };
        if (r.hold_reason) item.hold_reason = r.hold_reason;
        if (r.decided_by && refs.get(r.decided_by)) item.decided_by = refs.get(r.decided_by);
        return item;
      }),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([String(last.ord), String(last.row_no), last.id]) : null },
    };
  }

  // ------------------------------------------------------------------ writes
  private async call<T>(auth: AuthContext, sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT imp_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      const r = rows[0]?.r;
      if (r === undefined || r === null) throw new ProblemException(500, 'internal_error', {});
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT imp_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT imp_call`;
      if (p.code === 'step_up_required') {
        throw new ProblemException(401, 'step_up_required', { detail: 'Confirm your password to continue.', step_up_method: auth.session.authMethod === 'local' ? 'password' : 'm365' });
      }
      throw p;
    }
  }

  async submit(auth: AuthContext, id: string, ifMatch: string | undefined): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const batch = await this.getBatch(auth, id);
    if (batch.stream) {
      // as on the task screen: the conditional documents that apply now are slots before the engine counts the missing ones
      const tasks = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT DISTINCT r.task_instance_id::text AS id FROM import_batch_rows r
        WHERE r.batch_id = ${id}::uuid AND r.task_instance_id IS NOT NULL AND r.action = 'update' AND r.task_submitted_at IS NULL AND r.decision IN ('pending', 'pending_previous_approval')`);
      for (const t of tasks) await this.documents.syncTaskById(t.id);
    }
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    const outcome = await this.call<Outcome>(auth, Prisma.sql`SELECT imp_submit_batch(${id}::uuid, ${version}::int, ${stepOk}::boolean) AS r`);
    return { ...(await this.getBatch(auth, id)), outcome };
  }

  async decide(auth: AuthContext, id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(decisionBody, rawBody);
    if (body.scope === 'rows' && !body.rows?.length) throw problems.validation([{ path: '/rows', code: 'required', message: 'Name the rows to decide.' }]);
    if (body.action === 'reject' && body.scope === 'all' && !body.note?.trim()) {
      throw new ProblemException(422, 'note_required', { detail: 'A return needs a note.', errors: [{ path: '/note', code: 'required', message: 'A note is required.' }] });
    }
    const batch = await this.getBatch(auth, id);
    // the level action needs the grid right on the register's module: approve for L2 (the database checks the level holders again for every row)
    const key = String(batch.register_key ?? '');
    const mod = await this.db.tx.$queryRaw<{ module_key: string }[]>(Prisma.sql`SELECT module_key FROM register_definitions WHERE register_key = ${key}`);
    const module = batch.stream ? 'sites' : mod[0]?.module_key;
    if (module && (body.action === 'approve' || body.action === 'review')) {
      const regs = await this.access.regions(module, body.action === 'approve' ? 'approve' : 'view');
      if (regs !== null && regs.length === 0) throw problems.forbidden('action_forbidden', `You need ${body.action === 'approve' ? 'approve' : 'view'} on ${module}.`);
    }
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    const outcome = await this.call<Outcome>(
      auth,
      Prisma.sql`SELECT imp_decide_batch(${id}::uuid, ${version}::int, ${body.action}::text, ${body.scope}::text, ${body.rows ? JSON.stringify(body.rows) : null}::jsonb,
        ${body.note ?? null}::text, ${stepOk}::boolean) AS r`,
    );
    return { ...(await this.getBatch(auth, id)), outcome };
  }
}
