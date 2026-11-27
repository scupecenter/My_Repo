import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { guardXlsx, normalizeSpreadsheetPrefixes } from '../templates/xlsx-guard';
import { readStructureSheet, StructureSheetError, STRUCTURE_SHEET, writeDifferences } from '../templates/structure-sheet';
import { TPL_SHEET } from '../templates/templates.service';
import type { UploadedFile } from '../templates/upload.interceptor';

type Json = Record<string, unknown>;

const reason = z.string().trim().min(3).max(1000);
const createBody = z.object({ register_key: z.string().min(1).max(60), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000), reason }).strict();
const uploadBody = z.object({ reason }).strict();
const decideBody = z.object({ action: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() }).strict();
const revertBody = z.object({ reason }).strict();
const policyBody = z.object({
  reason, who_proposes: z.enum(['fields_editors', 'admins']).optional(), who_approves: z.enum(['admins', 'fields_editors']).optional(), two_person: z.enum(['risky_only', 'always']).optional(),
  max_items: z.number().int().min(1).max(500).optional(), notify_approvers: z.boolean().optional(), notify_proposer: z.boolean().optional(),
}).strict();

/**
 * Data entry proposals S2 to S7 (migration 0560): a structure proposal is made from the rows of a Structure sheet (or of the system), reviewed and approved by a
 * System Admin. The doors (admin_structure_proposal_*) check the right, the reason, the two-person rule and apply the items through the column doors of 0094. The API
 * adds the file reading and the step-up of the approval (and of the undo).
 */
@Injectable()
export class StructureProposalsService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService, private readonly syslog: SyslogService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT struct_prop`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json | null }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT struct_prop`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT struct_prop`;
      throw p;
    }
  }

  /** GET /settings/structure-policy: the rules (setting registers.structure_change), readable by every signed-in user. */
  async policy(): Promise<Json> {
    return this.door(Prisma.sql`SELECT struct_policy_json() AS r`);
  }

  /** PUT /settings/structure-policy: System Admin (or a delegate of settings edit for all regions), step-up, reason, If-Match; the door validates and audits. */
  async setPolicy(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    await this.access.requireAdmin('settings', 'edit');
    await this.stepUp.require(auth);
    const version = parseIfMatch(ifMatch);
    const { reason: why, ...cfg } = parse(policyBody, raw);
    return this.door(Prisma.sql`SELECT admin_set_struct_policy(${JSON.stringify(cfg)}::jsonb, ${why}::text, ${version}::int) AS r`);
  }

  async list(q: { register_key?: string; status?: string }): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    if (q.status !== undefined && !['pending', 'approved', 'rejected', 'applied', 'reverted'].includes(q.status)) throw problems.validation([{ path: '/status', code: 'invalid', message: 'Not a proposal status.' }]);
    return this.door(Prisma.sql`SELECT admin_structure_proposals_json(${q.register_key ?? null}::text, ${q.status ?? null}::text) AS r`);
  }

  async get(id: string): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('This proposal does not exist.');
    return this.door(Prisma.sql`SELECT admin_structure_proposal_get(${id}::uuid) AS r`);
  }

  async create(raw: unknown): Promise<Json> {
    const b = parse(createBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    return this.door(Prisma.sql`SELECT admin_structure_proposal_create(${b.register_key}::text, ${JSON.stringify(b.rows)}::jsonb, ${b.reason}::text, 'system'::text, NULL::integer) AS r`);
  }

  private async reject(auth: AuthContext, requestId: string | undefined, why: string, detail: string, ctx: Json): Promise<never> {
    await this.syslog.write('warn', `structure upload rejected: ${why}`, { reason: why, detail, ...ctx }, auth.user.id, requestId, 'template-check');
    throw new ProblemException(422, 'template_rejected', { detail, extra: { reason: why }, commit: true });
  }

  /** The upload of a modified template: the Structure sheet becomes a proposal; the data sheets are not read and nothing is written to the register. */
  async upload(auth: AuthContext, file: UploadedFile | undefined, rawBody: unknown, requestId: string | undefined): Promise<Json> {
    await this.access.requireAdmin('fields', 'edit');
    const body = parse(uploadBody, rawBody ?? {});
    if (!file || file.size === 0) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the edited template as the form field "file".' }]);
    const ctx: Json = { file_name: file.originalname.slice(0, 200), size: file.size };
    const guard = guardXlsx(file.originalname, file.buffer);
    if (!guard.ok) return this.reject(auth, requestId, guard.reason ?? 'not_xlsx', guard.detail ?? 'The file is not accepted.', ctx);
    let wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    } catch {
      const repacked = normalizeSpreadsheetPrefixes(file.buffer);
      try {
        if (!repacked || !guardXlsx(file.originalname, repacked).ok) throw new Error('unreadable');
        wb = new ExcelJS.Workbook();
        await wb.xlsx.load(repacked as unknown as ExcelJS.Buffer);
      } catch {
        return this.reject(auth, requestId, 'not_xlsx', 'The file could not be read as an Excel workbook.', ctx);
      }
    }
    const tpl = wb.worksheets.find((w) => w.name === TPL_SHEET);
    if (!tpl) return this.reject(auth, requestId, 'tpl_missing', 'This file is not a Workspace template: the hidden _tpl sheet is missing. Download the template from the system.', ctx);
    const kv = new Map<string, string>();
    tpl.eachRow((row) => { const k = String(row.getCell(1).value ?? '').trim(); if (k) kv.set(k, String(row.getCell(2).value ?? '').trim()); });
    const registerKey = kv.get('register_key') ?? '';
    const templateId = kv.get('template_id') ?? '';
    const version = /^[0-9]{1,6}$/.test(kv.get('version') ?? '') ? Number(kv.get('version')) : null;
    if (!/^TPL-[A-Z0-9_-]{2,40}$/.test(templateId) || registerKey === '') {
      return this.reject(auth, requestId, 'not_register_template', 'Only the template of a register carries a Structure sheet. This file is not one.', { ...ctx, template_id: templateId.slice(0, 60) });
    }
    const sheet = wb.worksheets.find((w) => w.name === STRUCTURE_SHEET);
    if (!sheet) return this.reject(auth, requestId, 'structure_missing', 'The file has no Structure sheet. Download the template again from Settings > Data > Edit through templates.', { ...ctx, template_id: templateId });
    let rows: Record<string, unknown>[];
    try {
      rows = readStructureSheet(sheet);
    } catch (e) {
      if (e instanceof StructureSheetError) return this.reject(auth, requestId, e.code, e.message, { ...ctx, template_id: templateId });
      throw e;
    }
    return this.door(Prisma.sql`SELECT admin_structure_proposal_create(${registerKey}::text, ${JSON.stringify(rows)}::jsonb, ${body.reason}::text, 'excel'::text, ${version}::integer) AS r`);
  }

  async decide(auth: AuthContext, id: string, raw: unknown): Promise<Json> {
    const b = parse(decideBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('This proposal does not exist.');
    // only a System Admin approves; the step-up comes before anything is applied
    if (b.action === 'approve') {
      if (!(await this.access.isSystemAdmin())) throw problems.forbidden('action_forbidden', 'Only a System Admin approves a structure proposal.');
      await this.stepUp.require(auth);
    }
    return this.door(Prisma.sql`SELECT admin_structure_proposal_decide(${id}::uuid, ${b.action}::text, ${b.note ?? null}::text, NULL::integer) AS r`);
  }

  async revert(auth: AuthContext, id: string, raw: unknown): Promise<Json> {
    const b = parse(revertBody, raw);
    await this.access.requireAdmin('fields', 'edit');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('This proposal does not exist.');
    await this.stepUp.require(auth);
    return this.door(Prisma.sql`SELECT admin_structure_proposal_revert(${id}::uuid, ${b.reason}::text) AS r`);
  }

  /** The differences of a proposal as an .xlsx, for the people who prefer to review in Excel. */
  async differences(id: string): Promise<{ buffer: Buffer; fileName: string }> {
    const p = (await this.get(id)) as unknown as { register_key: string; items: Parameters<typeof writeDifferences>[1] };
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GSDN Workspace';
    writeDifferences(wb, p.items);
    return { buffer: Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), fileName: `structure-differences-${p.register_key}.xlsx` };
  }
}
