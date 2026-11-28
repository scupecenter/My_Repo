import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { SyslogService } from '../auth/syslog.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DATA_SHEET, TPL_SHEET } from '../templates/templates.service';
import { importMaxRows, type UploadedFile } from '../templates/upload.interceptor';
import { guardXlsx } from '../templates/xlsx-guard';

type Json = Record<string, unknown>;
const text = (n: number) => z.string().trim().max(n);
const STATUS = z.enum(['not_started', 'in_progress', 'approved']);
const itemsBody = z.object({
  reason: z.string().trim().min(3).max(1000),
  items: z.array(z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), label_en: text(80).min(1), label_ar: text(80).nullable().optional(), required_for: z.array(z.string().max(40)).max(20).optional(),
    is_active: z.boolean().optional(),
  }).strict()).max(40),
}).strict();
const setBody = z.object({ status: STATUS, note: text(1000).nullable().optional() }).strict();
const bulkBody = z.object({ party_ids: z.array(z.string()).min(1).max(200), item: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), status: STATUS, note: text(1000).nullable().optional() }).strict();

/** The template kinds of the Companies proposal K4 and the template each one is read from. */
export const COMPANY_TEMPLATES: Record<string, string> = {
  'TPL-COMPANY-CONTACTS': 'company_contacts',
  'TPL-COMPANY-DOCUMENTS': 'company_documents',
  'TPL-COMPANY-ONBOARDING': 'company_onboarding',
};

/**
 * Companies proposal K4 (migration 0746): the onboarding checklist of a company (items in Settings, a status per company and item, one bulk change for the list)
 * and the import of the three company templates. Read: the Contractors or Procurement screens. Write: an editor of Contractors or Procurement. Items: Settings
 * (admin.settings). The import goes through the doors of K3 (contacts, documents) and of the checklist, so validation and audit are the ones of the screens.
 */
@Injectable()
export class CompanyOnboardingService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly syslog: SyslogService) {}

  private async door(sql: Prisma.Sql): Promise<unknown> {
    await this.db.tx.$executeRaw`SAVEPOINT company_onb`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: unknown }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT company_onb`;
      return rows[0]?.r ?? null;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT company_onb`;
      throw p;
    }
  }

  private async canRead(auth: AuthContext) { await this.access.requireAnyModuleView(auth, ['contractors', 'procurement']); }
  private async canWrite() {
    for (const m of ['contractors', 'procurement']) {
      const r = await this.access.regions(m, 'edit');
      if (r === null || r.length > 0) return;
    }
    throw new ProblemException(403, 'module_forbidden', { detail: 'You cannot edit companies.' });
  }
  private id(v: string) {
    if (!uuidSchema.safeParse(v).success) throw problems.notFound();
    return v;
  }

  // ----------------------------------------------------------------------------------------------------------------- settings
  async items(auth: AuthContext): Promise<Json> {
    await this.access.requireModuleView(auth, 'admin.settings');
    return (await this.door(Prisma.sql`SELECT company_onboarding_items_json() AS r`)) as Json;
  }

  async saveItems(ifMatch: string | undefined, raw: unknown): Promise<Json> {
    await this.access.requireAdmin('admin.settings', 'edit');
    const b = parse(itemsBody, raw);
    const v = ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch);
    return (await this.door(Prisma.sql`SELECT admin_save_company_onboarding_items(${JSON.stringify(b.items)}::jsonb, ${b.reason}::text, ${v}::int) AS r`)) as Json;
  }

  // ----------------------------------------------------------------------------------------------------------------- checklist
  async checklist(auth: AuthContext, party: string) {
    await this.canRead(auth);
    return { items: await this.door(Prisma.sql`SELECT company_onboarding_json(${this.id(party)}::uuid) AS r`) };
  }

  async overview(auth: AuthContext) {
    await this.canRead(auth);
    return { items: await this.door(Prisma.sql`SELECT company_onboarding_overview() AS r`) };
  }

  async setStatus(party: string, item: string, raw: unknown): Promise<Json> {
    await this.canWrite();
    const b = parse(setBody, raw);
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(item)) throw problems.notFound();
    const r = await this.door(Prisma.sql`SELECT company_onboarding_set(${this.id(party)}::uuid, ${item}::text, ${b.status}::text, ${b.note ?? null}::text) AS r`);
    return r as Json;
  }

  async bulk(raw: unknown): Promise<Json> {
    await this.canWrite();
    const b = parse(bulkBody, raw);
    const ids = b.party_ids.map((p) => this.id(p));
    return (await this.door(Prisma.sql`SELECT company_onboarding_bulk(${ids}::uuid[], ${b.item}::text, ${b.status}::text, ${b.note ?? null}::text) AS r`)) as Json;
  }

  // ----------------------------------------------------------------------------------------------------------------- export rows (the filled copy)
  async exportRows(kind: string, parties: string[] | null): Promise<Record<string, unknown>[]> {
    const rows = await this.door(Prisma.sql`SELECT company_export_rows(${kind}::text, ${parties}::uuid[]) AS r`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]).slice(0, importMaxRows()) : [];
  }

  // ----------------------------------------------------------------------------------------------------------------- POST /companies/import
  /** The xlsx of one of the three company templates (TPL-COMPANY-CONTACTS, -DOCUMENTS, -ONBOARDING), applied at once; one refused row refuses the file. */
  async importTemplate(auth: AuthContext, file: UploadedFile | undefined, requestId: string | undefined): Promise<Json> {
    await this.canWrite();
    if (!file || file.size === 0) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the filled company template as the form field "file".' }]);
    const fileName = (file.originalname ?? '').slice(0, 200);
    const reject = async (code: string, detail: string, ctx: Record<string, unknown> = {}): Promise<never> => {
      await this.syslog.write('warn', `company import rejected: ${code}`, { reason: code, detail, file_name: fileName, ...ctx }, auth.user.id, requestId, 'company-import');
      throw new ProblemException(422, 'template_rejected', { detail, extra: { reason: code }, commit: true });
    };
    const guard = guardXlsx(file.originalname ?? '', file.buffer);
    if (!guard.ok) return reject(guard.reason ?? 'not_xlsx', guard.detail ?? 'The file is not accepted: upload a company template (.xlsx).');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    } catch {
      return reject('not_xlsx', 'The file is not a valid .xlsx workbook.');
    }
    const cellText = (cell: ExcelJS.Cell): string => {
      const v = cell.value;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return (cell.text ?? '').toString().trim();
    };
    const tpl = wb.getWorksheet(TPL_SHEET);
    if (!tpl) return reject('tpl_missing', 'This file is not a GSDN Workspace template: the hidden _tpl sheet is missing. Download the template from the Data hub.');
    const kv = new Map<string, string>();
    tpl.eachRow((row) => {
      const k = cellText(row.getCell(1));
      if (k) kv.set(k, cellText(row.getCell(2)));
    });
    const templateId = (kv.get('template_id') ?? '').slice(0, 60);
    const versionText = (kv.get('version') ?? '').slice(0, 12);
    const kind = COMPANY_TEMPLATES[templateId];
    if (!kind || !/^[0-9]{1,6}$/.test(versionText)) {
      return reject('wrong_template', `This file is not a company template; it names ${templateId || 'no template'}.`, { template_id: templateId });
    }
    const cur = await this.db.tx.$queryRaw<{ current_version: number; columns: { code: string; header: string }[] }[]>(Prisma.sql`
      SELECT d.current_version, v.columns FROM template_definitions d
      JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.template_id = ${templateId} AND d.is_active`);
    if (!cur[0]) return reject('template_unknown_or_inactive', 'This template is not in use.');
    const version = Number(versionText);
    if (version !== cur[0].current_version) {
      return reject('outdated_version', `This file was made from version ${version} of ${templateId}; the current version is ${cur[0].current_version}. Download the template again.`,
        { version, current_version: cur[0].current_version });
    }
    const data = wb.getWorksheet(DATA_SHEET);
    if (!data) return reject('checksum_mismatch', 'The Data sheet is missing.');
    const cols = cur[0].columns;
    const head = data.getRow(1);
    if (cols.some((c, i) => cellText(head.getCell(i + 1)) !== c.header)) {
      return reject('checksum_mismatch', 'The header row of the file was changed. Use the template as it was issued, without adding, moving or renaming columns.');
    }
    const rows: Json[] = [];
    for (let r = 2; r <= data.rowCount; r++) {
      const cells = cols.map((_, i) => cellText(data.getRow(r).getCell(i + 1)));
      if (cells.every((v) => v === '')) continue;
      if (rows.length >= importMaxRows()) return reject('size_or_rows_exceeded', `At most ${importMaxRows()} rows per file.`);
      const row: Json = { line: r };
      cols.forEach((c, i) => { row[c.code] = cells[i]; });
      rows.push(row);
    }
    if (rows.length === 0) throw problems.validation([{ path: '/file', code: 'empty', message: 'The Data sheet has no row.' }]);
    const meta = { file_name: fileName, template_version: version };
    const out = (await this.door(Prisma.sql`SELECT company_import_rows(${kind}::text, ${JSON.stringify(rows)}::jsonb, ${JSON.stringify(meta)}::jsonb) AS r`)) as {
      id: string; rows: number; added: number; updated: number; unchanged: number;
    };
    await this.syslog.write('info', 'company template imported', { import_id: out.id, ...out, template_id: templateId, version }, auth.user.id, requestId, 'company-import');
    return { ...out, template_id: templateId, template_version: version, source: 'template', file_name: fileName, status: 'applied' };
  }
}
