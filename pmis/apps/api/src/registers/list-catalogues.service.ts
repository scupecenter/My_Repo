import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { z } from "zod";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { SyslogService } from "../auth/syslog.service";
import { mapDbError } from "../common/db-errors";
import { parseIfMatch } from "../common/etag";
import { ProblemException, problems } from "../common/problem";
import { boolParam, Query } from "../common/query";
import { parse, uuidSchema } from "../common/zod";
import { DbService } from "../db/db.service";
import { DATA_SHEET, TPL_SHEET } from "../templates/templates.service";
import type { UploadedFile } from "../templates/upload.interceptor";
import { importMaxRows } from "../templates/upload.interceptor";
import { guardXlsx } from "../templates/xlsx-guard";

const CODE = /^[A-Z][A-Za-z0-9]{1,40}$/;
const reason = z.string().trim().min(3).max(1000);
const CODE_OR_NULL = z.string().regex(CODE).nullable();
const text = (max: number) => z.string().trim().min(1).max(max);
const catalogueCreate = z
  .object({
    code: z.string().regex(CODE),
    name_en: z.string().trim().min(2).max(200),
    name_ar: text(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    critical: z.boolean().optional(),
    allow_other: z.boolean().optional(),
    value_type: z
      .enum(["text", "number", "date", "person", "site", "vendor"])
      .optional(),
    multi_select: z.boolean().optional(),
    parent_catalogue: CODE_OR_NULL.optional(),
    reason,
  })
  .strict();
const cataloguePatch = z
  .object({
    name_en: z.string().trim().min(2).max(200).optional(),
    name_ar: text(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    critical: z.boolean().optional(),
    status: z.enum(["pending", "confirmed"]).optional(),
    allow_other: z.boolean().optional(),
    is_active: z.boolean().optional(),
    value_type: z
      .enum(["text", "number", "date", "person", "site", "vendor"])
      .optional(),
    multi_select: z.boolean().optional(),
    parent_catalogue: CODE_OR_NULL.optional(),
    reason,
  })
  .strict()
  .refine((b) => Object.keys(b).length >= 2, {
    message: "Change at least one field.",
    path: [],
  });
const valueFields = {
  label_en: text(200).optional(),
  label_ar: text(200).nullable().optional(),
  aliases: z.array(text(80)).max(20).optional(),
  groups: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_ -]{0,30}$/))
    .max(10)
    .optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
  is_active: z.boolean().optional(),
  colour: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .optional(),
  is_default: z.boolean().optional(),
  parent_code: z.string().min(1).max(80).nullable().optional(),
  reason,
};
const valueCreate = z
  .object({ code: z.string().min(1).max(80), ...valueFields })
  .strict();
const valuePatch = z
  .object(valueFields)
  .strict()
  .refine((b) => Object.keys(b).length >= 2, {
    message: "Change at least one field.",
    path: [],
  });

interface CatalogueRow {
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  critical: boolean;
  status: string;
  allow_other: boolean;
  is_active: boolean;
  version: number;
  value_type: string;
  multi_select: boolean;
  parent_catalogue: string | null;
}
interface ValueRow {
  catalogue_code: string;
  id: string;
  code: string;
  label_en: string;
  label_ar: string | null;
  aliases: string[];
  groups: string[];
  sort_order: number;
  is_active: boolean;
  version: number;
  colour: string | null;
  is_default: boolean;
  parent_code: string | null;
  deactivate_reason: string | null;
  deactivated_at: Date | null;
}

/**
 * The list catalogue (Q104, migration 0057): every list of a register is data. Anyone signed in reads it (the values appear in the forms); the System
 * Admin or a delegate of `fields` edit for all regions writes it through admin_save_list_catalogue / admin_save_list_value, which the database checks again.
 */
@Injectable()
export class ListCataloguesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly syslog: SyslogService,
  ) {}

  private async rows(
    code: string | null,
    inactive: boolean,
  ): Promise<Record<string, unknown>[]> {
    const cats = await this.db.tx.$queryRaw<CatalogueRow[]>(Prisma.sql`
      SELECT code, name_en, name_ar, description, critical, status, allow_other, is_active, version, value_type, multi_select, parent_catalogue FROM list_catalogues
      WHERE ${code === null ? Prisma.sql`true` : Prisma.sql`code = ${code}`} ${inactive ? Prisma.empty : Prisma.sql`AND is_active`}
      ORDER BY code COLLATE "C"`);
    if (cats.length === 0) return [];
    const codes = cats.map((c) => c.code);
    const values = await this.db.tx.$queryRaw<ValueRow[]>(Prisma.sql`
      SELECT v.catalogue_code, v.id::text AS id, v.code, v.label_en, v.label_ar, v.aliases, v.groups, v.sort_order, v.is_active, v.version,
        v.colour, v.is_default, p.code AS parent_code, v.deactivate_reason, v.deactivated_at
      FROM list_values v LEFT JOIN list_values p ON p.id = v.parent_value_id
      WHERE v.catalogue_code = ANY(${codes}::text[]) ${inactive ? Prisma.empty : Prisma.sql`AND v.is_active`}
      ORDER BY v.catalogue_code, v.sort_order, v.code COLLATE "C"`);
    const used = await this.db.tx.$queryRaw<
      {
        catalogue: string;
        register_key: string;
        field_code: string;
        col: string | null;
      }[]
    >(Prisma.sql`
      SELECT f.list_catalogue AS catalogue, f.register_key, f.code AS field_code, NULL::text AS col FROM register_fields f
      WHERE f.is_active AND f.list_catalogue = ANY(${codes}::text[])
      UNION ALL
      SELECT c ->> 'list_catalogue', f.register_key, f.code, c ->> 'code' FROM register_fields f, jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) c
      WHERE f.is_active AND f.field_type = 'child_list' AND c ->> 'list_catalogue' = ANY(${codes}::text[])
      ORDER BY 2, 3`);
    const deps = await this.db.tx.$queryRaw<
      { code: string; parent: string }[]
    >(Prisma.sql`
      SELECT code, parent_catalogue AS parent FROM list_catalogues
      WHERE parent_catalogue = ANY(${codes}::text[]) AND is_active`);
    return cats.map((c) => ({
      ...c,
      values: values
        .filter((v) => v.catalogue_code === c.code)
        .map((v) => ({
          id: v.id,
          code: v.code,
          label_en: v.label_en,
          label_ar: v.label_ar,
          aliases: v.aliases,
          groups: v.groups,
          sort_order: v.sort_order,
          is_active: v.is_active,
          version: v.version,
          colour: v.colour,
          is_default: v.is_default,
          parent_code: v.parent_code,
          deactivate_reason: v.deactivate_reason,
          deactivated_at: v.deactivated_at,
        })),
      dependent_lists: deps
        .filter((d) => d.parent === c.code)
        .map((d) => d.code),
      used_by: used
        .filter((u) => u.catalogue === c.code)
        .map((u) => ({
          register_key: u.register_key,
          field_code: u.field_code,
          ...(u.col ? { column: u.col } : {}),
        })),
    }));
  }

  async list(q: Query): Promise<{ items: Record<string, unknown>[] }> {
    return {
      items: await this.rows(null, boolParam(q, "include_inactive") === true),
    };
  }

  async get(code: string): Promise<Record<string, unknown>> {
    if (!CODE.test(code)) throw problems.notFound("The list does not exist.");
    const [row] = await this.rows(code, true);
    if (!row) throw problems.notFound("The list does not exist.");
    return row;
  }

  private async call(sql: Prisma.Sql): Promise<void> {
    await this.db.tx.$executeRaw`SAVEPOINT list_call`;
    try {
      await this.db.tx.$queryRaw(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT list_call`;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT list_call`;
      throw p;
    }
  }

  async create(raw: unknown): Promise<Record<string, unknown>> {
    await this.access.requireAdmin("fields", "edit");
    const { code, reason: why, ...b } = parse(catalogueCreate, raw);
    await this.call(
      Prisma.sql`SELECT admin_save_list_catalogue(${code}::text, true, ${JSON.stringify(b)}::jsonb, ${why}::text, NULL::int)`,
    );
    return this.get(code);
  }

  async update(
    code: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin("fields", "edit");
    await this.get(code);
    const { reason: why, ...b } = parse(cataloguePatch, raw);
    await this.call(
      Prisma.sql`SELECT admin_save_list_catalogue(${code}::text, false, ${JSON.stringify(b)}::jsonb, ${why}::text, ${version}::int)`,
    );
    return this.get(code);
  }

  /** Hard delete of a value, only when it is unused and not the default (admin_delete_list_value; the trigger repeats the rule). */
  async deleteValue(
    code: string,
    rawId: string,
    ifMatch: string | undefined,
    rawReason: unknown,
  ): Promise<Record<string, unknown>> {
    const version = ifMatch === undefined ? null : parseIfMatch(ifMatch);
    await this.access.requireAdmin("fields", "edit");
    await this.get(code);
    if (!uuidSchema.safeParse(rawId).success)
      throw problems.notFound("The value does not exist in this list.");
    const why = parse(reason, rawReason);
    await this.call(
      Prisma.sql`SELECT admin_delete_list_value(${code}::text, ${rawId}::uuid, ${why}::text, ${version}::int)`,
    );
    return this.get(code);
  }

  async addValue(code: string, raw: unknown): Promise<Record<string, unknown>> {
    await this.access.requireAdmin("fields", "edit");
    await this.get(code);
    const { reason: why, ...b } = parse(valueCreate, raw);
    await this.call(
      Prisma.sql`SELECT admin_save_list_value(${code}::text, NULL::uuid, ${JSON.stringify(b)}::jsonb, ${why}::text, NULL::int)`,
    );
    return this.get(code);
  }

  async updateValue(
    code: string,
    rawId: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin("fields", "edit");
    await this.get(code);
    if (!uuidSchema.safeParse(rawId).success)
      throw problems.notFound("The value does not exist in this list.");
    const { reason: why, ...b } = parse(valuePatch, raw);
    await this.call(
      Prisma.sql`SELECT admin_save_list_value(${code}::text, ${rawId}::uuid, ${JSON.stringify(b)}::jsonb, ${why}::text, ${version}::int)`,
    );
    return this.get(code);
  }

  /**
   * 0105 (F17): the values of one list from the approved template TPL-LISTVALUES. The _tpl sheet must name that template and its current
   * version, and the header row must be the issued one. Any other file is rejected and the rejection goes to the System Log. Every row applies
   * or none does (admin_save_list_value per row, one transaction).
   */
  async importValues(
    auth: AuthContext,
    code: string,
    file: UploadedFile | undefined,
    rawReason: unknown,
    requestId: string | undefined,
  ): Promise<Record<string, unknown>> {
    await this.access.requireAdmin("fields", "edit");
    await this.get(code);
    const why = parse(reason, rawReason);
    if (!file || file.size === 0)
      throw problems.validation([{ path: "/file", code: "required", message: 'Send the filled template as the form field "file".' }]);
    const reject = async (reasonCode: string, detail: string, ctx: Record<string, unknown> = {}): Promise<never> => {
      await this.syslog.write("warn", `list values import rejected: ${reasonCode}`, { reason: reasonCode, detail, list: code, file_name: file.originalname.slice(0, 200), ...ctx }, auth.user.id, requestId, "list-import");
      throw new ProblemException(422, "template_rejected", { detail, extra: { reason: reasonCode }, commit: true });
    };

    const guard = guardXlsx(file.originalname, file.buffer);
    if (!guard.ok) return reject(guard.reason ?? "not_xlsx", guard.detail ?? "The file is not accepted.");
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    } catch {
      return reject("not_xlsx", "The file is not a valid .xlsx workbook.");
    }
    const cellText = (cell: ExcelJS.Cell) => (cell.text ?? "").toString().trim();

    const tpl = wb.getWorksheet(TPL_SHEET);
    if (!tpl) return reject("tpl_missing", "This file is not an approved Workspace template: the hidden _tpl sheet is missing.");
    const kv = new Map<string, string>();
    tpl.eachRow((row) => {
      const k = cellText(row.getCell(1));
      if (k) kv.set(k, cellText(row.getCell(2)));
    });
    const templateId = (kv.get("template_id") ?? "").slice(0, 60);
    const versionText = (kv.get("version") ?? "").slice(0, 12);
    if (templateId !== "TPL-LISTVALUES" || !/^[0-9]{1,6}$/.test(versionText))
      return reject("wrong_template", `This file is not the list values template (TPL-LISTVALUES); it names ${templateId || "no template"}.`, { template_id: templateId });

    const cur = await this.db.tx.$queryRaw<{ current_version: number; columns: { header: string }[] }[]>(Prisma.sql`
      SELECT d.current_version, v.columns FROM template_definitions d
      JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.template_id = 'TPL-LISTVALUES' AND d.is_active`);
    if (!cur[0]) return reject("template_unknown_or_inactive", "The list values template is not in use.");
    const version = Number(versionText);
    if (version !== cur[0].current_version)
      return reject("outdated_version", `This file was made from version ${version} of TPL-LISTVALUES; the current version is ${cur[0].current_version}. Download the template again.`, { version, current_version: cur[0].current_version });

    const data = wb.getWorksheet(DATA_SHEET);
    if (!data) return reject("checksum_mismatch", "The Data sheet is missing.");
    const headers = cur[0].columns.map((c) => c.header);
    const header = data.getRow(1);
    if (headers.some((h, i) => cellText(header.getCell(i + 1)) !== h))
      return reject("checksum_mismatch", "The header row of the file was changed. Use the template as it was issued, without adding, moving or renaming columns.");

    // the columns of TPL-LISTVALUES, in order (migration 0105)
    const keys = ["code", "label_en", "label_ar", "aliases", "colour", "parent_code", "sort_order"];
    const rows: { line: number; body: Record<string, unknown> }[] = [];
    for (let r = 2; r <= data.rowCount; r++) {
      const cells = keys.map((_, i) => cellText(data.getRow(r).getCell(i + 1)));
      if (cells.every((v) => v === "")) continue;
      if (rows.length >= importMaxRows())
        return reject("size_or_rows_exceeded", `At most ${importMaxRows()} values per file.`);
      const body: Record<string, unknown> = {};
      cells.forEach((v, i) => {
        if (v === "") return;
        const key = keys[i] ?? "";
        if (key === "aliases") body.aliases = v.split(";").map((x) => x.trim()).filter(Boolean);
        else if (key === "sort_order") body.sort_order = Number(v);
        else body[key] = v;
      });
      rows.push({ line: r, body });
    }

    // D54: a downloaded file holds the current values, so a code that already exists is an update (the code itself never changes) and a new code is created.
    // An empty cell leaves the value as it is. A row identical to the stored value is counted as unchanged and writes nothing.
    const existing = new Map(
      (
        await this.db.tx.$queryRaw<
          { id: string; code: string; label_en: string; label_ar: string | null; aliases: string[]; colour: string | null; parent_code: string | null; sort_order: number }[]
        >(Prisma.sql`
          SELECT v.id::text AS id, v.code, v.label_en, v.label_ar, v.aliases, v.colour, p.code AS parent_code, v.sort_order
          FROM list_values v LEFT JOIN list_values p ON p.id = v.parent_value_id WHERE v.catalogue_code = ${code}`)
      ).map((v) => [v.code, v]),
    );
    const errors: { path: string; code: string; message: string }[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const rowCode = String(row.body.code ?? "");
      if (seen.has(rowCode)) {
        errors.push({ path: `/line ${row.line}`, code: "duplicate_in_file", message: `The value code ${rowCode} appears twice in the file.` });
        continue;
      }
      seen.add(rowCode);
      const old = existing.get(rowCode);
      try {
        if (!old) {
          await this.call(
            Prisma.sql`SELECT admin_save_list_value(${code}::text, NULL::uuid, ${JSON.stringify(row.body)}::jsonb, ${why}::text, NULL::int)`,
          );
          created++;
          continue;
        }
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row.body)) {
          if (k === "code") continue;
          const same = k === "aliases" ? [...(v as string[])].sort().join(";") === [...(old.aliases ?? [])].sort().join(";") : (old as unknown as Record<string, unknown>)[k] === v;
          if (!same) patch[k] = v;
        }
        if (Object.keys(patch).length === 0) {
          unchanged++;
          continue;
        }
        await this.call(
          Prisma.sql`SELECT admin_save_list_value(${code}::text, ${old.id}::uuid, ${JSON.stringify(patch)}::jsonb, ${why}::text, NULL::int)`,
        );
        updated++;
      } catch (e) {
        if (!(e instanceof ProblemException)) throw e;
        errors.push({ path: `/line ${row.line}`, code: "invalid", message: e.message });
      }
    }
    const applied = created + updated;
    if (errors.length > 0) throw problems.validation(errors.slice(0, 50));
    await this.syslog.write("info", "list values imported", { list: code, applied, created, updated, unchanged, version }, auth.user.id, requestId, "list-import");
    return { ...(await this.get(code)), imported: applied, created, updated, unchanged };
  }
}
