import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException, problems } from '../common/problem';
import { boolParam, oneParam } from '../common/query';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

/** One column of a template (the JSON that tpl_columns() stores with every version). */
export interface TplColumn {
  code: string;
  header: string;
  type: string;
  /** site (Site ID), record_type, field and custom (register columns), record_id; info (a grey column of a stream template or the Master sheet) and task (a task field). */
  kind: 'site' | 'record_type' | 'field' | 'custom' | 'record_id' | 'info' | 'task';
  required?: boolean;
  derived?: boolean;
  options?: string[];
  /** 0057: the list accepts another value (the drop-down only warns), or the cell holds several values separated by ";" (no drop-down check). */
  allow_other?: boolean;
  multiple?: boolean;
  /** task columns: the task code, the field (planned_date, actual_date, v:<key>, r:<register>.<field> ...), the Master column and the stream. */
  task?: string;
  field?: string;
  master_col?: string;
  stream?: string;
  /** info columns of the Master sheet: who owns the column (identity, scope, calc, baseline, dismantle, issues). */
  owner?: string;
}

/** One sheet of TPL-MASTER: the Master sheet (kind master) or a register sheet, with its columns and the checksum of its header row. */
export interface TplPart {
  part: string;
  sheet: string;
  kind: 'master' | 'register';
  ref?: string;
  columns: TplColumn[];
  header_checksum: string;
}

export interface TemplateRow {
  id: string;
  template_id: string;
  name: string;
  name_ar: string | null;
  kind: string;
  register_key: string | null;
  stream_code: string | null;
  module_key: string | null;
  current_version: number;
  is_active: boolean;
  updated_at: Date;
  field_set_version: number | null;
  columns: TplColumn[];
  header_checksum: string;
  field_set_hash: string | null;
  custom_entity: string | null;
}

/** One data sheet of a workbook to build: its columns and the rows to pre-fill (values keyed by column code). */
export interface BookPart {
  sheet: string;
  cols: TplColumn[];
  rows: Record<string, unknown>[];
}

interface SiteRow {
  id: string; site_code: string; name: string; region_id: number; region: string; scenario: string; project_phase: string | null; delivery_batch: string | null;
  cw_delivery_model: string | null; sc_aa: string | null; sc_ab: string | null; sc_ac: string | null; sc_ad: string | null; sc_ae: string | null; sc_af: string | null;
}
interface TaskCell {
  site_id: string; code: string; planned_date: string | null; planned_start: string | null; actual_start: string | null; actual_date: string | null;
  submitted_date: string | null; approved_date: string | null; values: Record<string, unknown> | null; party: string | null;
}
const SCENARIOS: Record<string, string> = { new_build: 'New Build', expansion: 'Expansion', hot_swap: 'Hot Swap', cold_swap: 'Cold Swap', relocation: 'Relocation' };
const YES_NA: Record<string, string> = { yes: 'Yes', na: 'N/A' };
/** Grey columns of the Master sheet that a pre-filled copy fills for information: a value typed there is the same as the file's, so the upload does not warn about it. */
export const MASTER_INFO_PREFILLED = new Set(['m:A', 'm:D', 'm:E', 'm:X', 'm:Y', 'm:Z', 'm:AA', 'm:AB', 'm:AC', 'm:AD', 'm:AE', 'm:AF', 'm:AG']);
export const STREAM_INFO_PREFILLED = new Set(['site_name', 'region', 'scenario']);

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DATA_SHEET = 'Data';
export const TPL_SHEET = '_tpl';
export const LISTS_SHEET = '_lists';
/** Rows below the pre-filled ones that are formatted and validated for typing. */
const BLANK_ROWS = 300;
const MAX_PREFILL_ROWS = 5000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const isoToDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** The current version of a template (active ones only). */
  async current(templateId: string): Promise<TemplateRow | null> {
    const rows = await this.db.tx.$queryRaw<TemplateRow[]>(Prisma.sql`
      SELECT d.id::text AS id, d.template_id, d.name, d.name_ar, d.kind, d.register_key, d.stream_code, d.module_key, d.current_version, d.is_active, d.updated_at,
        v.field_set_version, v.columns, v.header_checksum, v.field_set_hash, d.custom_entity
      FROM template_definitions d JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.template_id = ${templateId}`);
    return rows[0] ?? null;
  }

  /** The versions of one template: the lookup an upload makes. */
  async version(templateId: string, version: number): Promise<{ id: string; is_current: boolean; columns: TplColumn[]; header_checksum: string } | null> {
    const rows = await this.db.tx.$queryRaw<{ id: string; is_current: boolean; columns: TplColumn[]; header_checksum: string }[]>(Prisma.sql`
      SELECT v.id::text AS id, v.is_current, v.columns, v.header_checksum FROM template_versions v
      JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = ${templateId} AND v.version = ${version}`);
    return rows[0] ?? null;
  }

  /** Does the caller have the right to use the template of this register (view on its module)? */
  private async usable(t: TemplateRow): Promise<boolean> {
    if (t.kind === 'register' && t.module_key) {
      const regs = await this.access.regions(t.module_key, 'view');
      return regs === null || regs.length > 0;
    }
    if (t.kind === 'stream' || t.kind === 'master') {
      const regs = await this.access.regions('sites', 'view');
      return regs === null || regs.length > 0;
    }
    return false;
  }

  // ------------------------------------------------------------------ GET /templates
  async list(auth: AuthContext): Promise<{ items: unknown[] }> {
    void auth;
    const rows = await this.db.tx.$queryRaw<TemplateRow[]>(Prisma.sql`
      SELECT d.id::text AS id, d.template_id, d.name, d.name_ar, d.kind, d.register_key, d.stream_code, d.module_key, d.current_version, d.is_active, d.updated_at,
        v.field_set_version, '[]'::jsonb AS columns, v.header_checksum, v.field_set_hash, d.custom_entity
      FROM template_definitions d JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.is_active ORDER BY d.sort_order, d.template_id COLLATE "C"`);
    const versions = await this.db.tx.$queryRaw<{ def: string; version: number; published_at: Date; reason: string | null }[]>(Prisma.sql`
      SELECT v.template_def_id::text AS def, v.version, v.published_at, v.reason FROM template_versions v ORDER BY v.version DESC`);
    const items: unknown[] = [];
    for (const t of rows) {
      if (!(await this.usable(t))) continue;
      items.push({
        template_id: t.template_id,
        name_en: t.name,
        name_ar: t.name_ar,
        kind: 'data_import',
        template_kind: t.kind,
        module_key: t.module_key ?? 'sites',
        register_key: t.register_key,
        stream: t.stream_code,
        current_version: t.current_version,
        field_set_version: t.field_set_version,
        issued_at: versions.find((v) => v.def === t.id && v.version === t.current_version)?.published_at ?? t.updated_at,
        is_active: t.is_active,
        versions: versions.filter((v) => v.def === t.id).map((v) => ({ version: v.version, issued_at: v.published_at, reason: v.reason })),
      });
    }
    return { items };
  }

  // ------------------------------------------------------------------ GET /templates/{id}/download
  async download(auth: AuthContext, templateId: string, ip: string | null, q: Record<string, unknown>): Promise<{ buffer: Buffer; fileName: string }> {
    const t = await this.current(templateId);
    if (!t || !t.is_active) throw problems.notFound('This template does not exist.');
    if (t.kind === 'stream' || t.kind === 'master') return this.downloadSite(auth, t, q);
    if (t.kind !== 'register' || !t.register_key || !t.module_key) throw problems.notFound('This template cannot be downloaded yet.');
    const regs = await this.access.requireRegions(t.module_key, 'view');
    if (!(await this.access.hasGrant(auth, 'templates', 'download_documents'))) throw problems.forbidden('action_forbidden', 'You need to download documents on templates.');

    const taskId = oneParam(q, 'task_id');
    const siteIds = this.siteIds(q);
    const regionParam = oneParam(q, 'region_id');
    let prefill = boolParam(q, 'prefill') === true || taskId !== undefined || siteIds.length > 0;
    let site: string[] = siteIds;
    if (taskId !== undefined) {
      if (!uuidSchema.safeParse(taskId).success) throw problems.validation([{ path: '/task_id', code: 'invalid', message: 'task_id is a uuid.' }]);
      const task = await this.db.tx.$queryRaw<{ site_id: string; used: boolean }[]>(Prisma.sql`
        SELECT ti.site_id::text AS site_id,
          EXISTS (SELECT 1 FROM register_task_sources s WHERE s.task_code = td.code AND s.register_key = ${t.register_key} AND s.is_active) AS used
        FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id WHERE ti.id = ${taskId}::uuid`);
      if (!task[0]) throw problems.notFound('The task does not exist or is not visible to you.');
      if (!task[0].used) throw new ProblemException(422, 'template_rejected', { detail: 'This task does not use this template.', extra: { reason: 'wrong_template' } });
      site = [task[0].site_id];
      prefill = true;
    }
    for (const s of site) if (!uuidSchema.safeParse(s).success) throw problems.validation([{ path: '/site_ids', code: 'invalid', message: 'site_ids are uuids.' }]);
    let region: number | null = null;
    if (regionParam !== undefined) {
      if (!/^[0-9]{1,2}$/.test(regionParam)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is a number.' }]);
      region = Number(regionParam);
    }

    // the columns as issued (stored with the version); the lists are read again so a new permit type or list value shows at once
    const fresh = await this.db.tx.$queryRaw<{ cols: TplColumn[]; sum: string }[]>(Prisma.sql`SELECT tpl_columns(${t.register_key}) AS cols, tpl_header_checksum(tpl_columns(${t.register_key})) AS sum`);
    const cols = fresh[0] && fresh[0].sum === t.header_checksum ? fresh[0].cols : t.columns;

    const rows = prefill ? await this.prefillRows(t.register_key, regs, site, region, cols) : [];

    const me = await this.db.tx.$queryRaw<{ employee_id: string | null; display_name: string }[]>(Prisma.sql`SELECT employee_id, display_name FROM users WHERE id = ${auth.user.id}::uuid`);
    const issuedAt = new Date();
    const buffer = await this.build(t, cols, rows, { prefill, employeeId: me[0]?.employee_id?.trim() ?? null, issuedAt });

    // migration 0045: pmis_app writes no log row itself; the ip and the device come from the request context
    void ip;
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('template_download', 'template', ${t.template_id}::text, NULL,
        ${JSON.stringify({ version: t.current_version, prefill, rows: rows.length, task_id: taskId ?? null, site_ids: site, region_id: region, register_key: t.register_key })}::jsonb, NULL)`);
    const name = `${t.template_id}_v${t.current_version}${prefill ? '_prefilled' : ''}_${issuedAt.toISOString().slice(0, 10)}.xlsx`;
    return { buffer, fileName: name };
  }

  private siteIds(q: Record<string, unknown>): string[] {
    const v = q.site_ids ?? q['site_ids[]'];
    if (v === undefined) return [];
    const list = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' ? x.split(',') : [])).map((s) => s.trim()).filter(Boolean);
    if (list.length > 500) throw problems.validation([{ path: '/site_ids', code: 'too_many', message: 'At most 500 sites.' }]);
    return list;
  }

  /** The records in force (approved, else the open draft), inside the caller's regions. Row level security applies as well. */
  private async prefillRows(key: string, regs: number[] | null, sites: string[], region: number | null, cols: TplColumn[]): Promise<Record<string, unknown>[]> {
    const rows = await this.db.tx.$queryRaw<{ entity_id: string; site_code: string | null; record_type: string | null; data: Record<string, unknown>; custom: Record<string, unknown> }[]>(Prisma.sql`
      SELECT DISTINCT ON (r.entity_id) r.entity_id::text AS entity_id, s.site_code, r.record_type, r.data, r.custom
      FROM register_records r LEFT JOIN sites s ON s.id = r.site_id
      WHERE r.register_key = ${key} AND r.state IN ('approved', 'entry', 'in_review', 'in_approval')
        AND (r.is_current OR NOT EXISTS (SELECT 1 FROM register_records c WHERE c.entity_id = r.entity_id AND c.is_current))
        ${regs === null ? Prisma.empty : Prisma.sql`AND (r.is_global OR r.region_id = ANY(${regs}::int[]))`}
        ${sites.length ? Prisma.sql`AND r.site_id = ANY(${sites}::uuid[])` : Prisma.empty}
        ${region !== null ? Prisma.sql`AND r.region_id = ${region}` : Prisma.empty}
      ORDER BY r.entity_id, r.is_current DESC, r.version_no DESC`);
    rows.sort((a, b) => (a.site_code ?? '').localeCompare(b.site_code ?? '', 'en') || a.entity_id.localeCompare(b.entity_id));
    const page = rows.slice(0, MAX_PREFILL_ROWS);

    // ids that the file shows as names / employee IDs
    const teamIds = new Set<string>(), userIds = new Set<string>();
    for (const c of cols) {
      if (c.kind !== 'field') continue;
      for (const r of page) {
        const v = r.data[c.code];
        if (typeof v !== 'string') continue;
        if (c.type === 'external_team') teamIds.add(v);
        if (c.type === 'user') userIds.add(v);
      }
    }
    // 0057: the multi values, the Warehouse items and the child lists are written with the codes a person types (employee IDs, site codes, item codes)
    const siteIds = new Set<string>(), itemIds = new Set<string>();
    for (const c of cols) {
      if (c.kind !== 'field') continue;
      for (const r of page) {
        const v = r.data[c.code];
        if (c.type === 'multi_user' && Array.isArray(v)) v.forEach((x) => typeof x === 'string' && userIds.add(x));
        if (c.type === 'multi_site' && Array.isArray(v)) v.forEach((x) => typeof x === 'string' && siteIds.add(x));
        if (c.type === 'warehouse_item' && typeof v === 'string') itemIds.add(v);
        if (c.type === 'child_list' && Array.isArray(v)) for (const row of v as Record<string, unknown>[]) if (typeof row.owner === 'string') userIds.add(row.owner);
      }
    }
    const sitesById = siteIds.size ? await this.db.tx.$queryRaw<{ id: string; site_code: string }[]>(Prisma.sql`SELECT id::text AS id, site_code FROM sites WHERE id = ANY(${[...siteIds]}::uuid[])`) : [];
    const itemsById = itemIds.size ? await this.db.tx.$queryRaw<{ id: string; item_code: string }[]>(Prisma.sql`SELECT id::text AS id, item_code FROM warehouse_items WHERE id = ANY(${[...itemIds]}::uuid[])`) : [];
    const teams = teamIds.size ? await this.db.tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`SELECT id::text AS id, name FROM external_teams WHERE id = ANY(${[...teamIds]}::uuid[])`) : [];
    const users = userIds.size ? await this.db.tx.$queryRaw<{ id: string; employee_id: string | null; email: string }[]>(Prisma.sql`SELECT id::text AS id, employee_id, email FROM users WHERE id = ANY(${[...userIds]}::uuid[])`) : [];
    return page.map((r) => {
      const out: Record<string, unknown> = { record_id: r.entity_id, site_code: r.site_code, record_type: r.record_type };
      for (const c of cols) {
        if (c.kind === 'field') {
          let v = r.data[c.code];
          if (c.type === 'external_team' && typeof v === 'string') v = teams.find((t) => t.id === v)?.name ?? v;
          if (c.type === 'user' && typeof v === 'string') { const u = users.find((x) => x.id === v); v = u?.employee_id?.trim() || u?.email || v; }
          const person = (id: unknown) => { const u = users.find((x) => x.id === id); return u?.employee_id?.trim() || u?.email || String(id ?? ''); };
          if (c.type === 'multi_user' && Array.isArray(v)) v = v.map(person).join('; ');
          if (c.type === 'multi_site' && Array.isArray(v)) v = v.map((id) => sitesById.find((x) => x.id === id)?.site_code ?? String(id)).join('; ');
          if (c.type === 'multi_list' && Array.isArray(v)) v = v.join('; ');
          if (c.type === 'warehouse_item' && typeof v === 'string') v = itemsById.find((x) => x.id === v)?.item_code ?? v;
          // a child list is shown, one row per line, and never read back (the rows are entered in the PMIS, so an action is never entered twice)
          if (c.type === 'child_list' && Array.isArray(v)) {
            v = (v as Record<string, unknown>[]).map((row) => Object.entries(row).filter(([k]) => k !== 'id').map(([k, x]) => `${k}: ${k === 'owner' ? person(x) : String(x)}`).join(' | ')).join('\n');
          }
          out[c.code] = v;
        } else if (c.kind === 'custom') out[c.code] = r.custom[c.code];
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ Site Register stream templates and TPL-MASTER
  /**
   * TPL-SITE-DA, -CW, -TE, -CL (Q73) and TPL-MASTER: one row per site, the task fields of the stream (or of the whole Master) in Master column order.
   * Calculated columns, the dates the workflow sets itself and the fields another register owns are grey and locked: they are shown, never read.
   * The download can be pre-filled for the caller's regions (the current values of the tasks and, read only, of the registers).
   */
  private async downloadSite(auth: AuthContext, t: TemplateRow, q: Record<string, unknown>): Promise<{ buffer: Buffer; fileName: string }> {
    const regs = await this.access.requireRegions('sites', 'view');
    if (!(await this.access.hasGrant(auth, 'templates', 'download_documents'))) throw problems.forbidden('action_forbidden', 'You need to download documents on templates.');
    const taskId = oneParam(q, 'task_id');
    const siteIds = this.siteIds(q);
    const regionParam = oneParam(q, 'region_id');
    let prefill = boolParam(q, 'prefill') === true || taskId !== undefined || siteIds.length > 0;
    let sites: string[] = siteIds;
    if (taskId !== undefined) {
      if (!uuidSchema.safeParse(taskId).success) throw problems.validation([{ path: '/task_id', code: 'invalid', message: 'task_id is a uuid.' }]);
      const task = await this.db.tx.$queryRaw<{ site_id: string; stream_code: string | null }[]>(Prisma.sql`
        SELECT ti.site_id::text AS site_id, sd.stream_code
        FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id JOIN stage_definitions sd ON sd.id = td.stage_id WHERE ti.id = ${taskId}::uuid`);
      if (!task[0]) throw problems.notFound('The task does not exist or is not visible to you.');
      if (t.kind === 'stream' && task[0].stream_code !== t.stream_code) {
        throw new ProblemException(422, 'template_rejected', { detail: 'This task belongs to another stream.', extra: { reason: 'wrong_template' } });
      }
      sites = [task[0].site_id];
      prefill = true;
    }
    for (const s of sites) if (!uuidSchema.safeParse(s).success) throw problems.validation([{ path: '/site_ids', code: 'invalid', message: 'site_ids are uuids.' }]);
    let region: number | null = null;
    if (regionParam !== undefined) {
      if (!/^[0-9]{1,2}$/.test(regionParam)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is a number.' }]);
      region = Number(regionParam);
    }

    const parts: BookPart[] = [];
    const sheets: { sheet: string; rows: number }[] = [];
    if (t.kind === 'stream') {
      const cols = t.columns;
      const rows = prefill ? await this.siteRows(cols, regs, sites, region) : [];
      parts.push({ sheet: DATA_SHEET, cols, rows });
      sheets.push({ sheet: DATA_SHEET, rows: rows.length });
    } else {
      const modules = new Map((await this.db.tx.$queryRaw<{ register_key: string; module_key: string }[]>(Prisma.sql`
        SELECT register_key, module_key FROM register_definitions WHERE is_active AND enabled`)).map((r) => [r.register_key, r.module_key]));
      for (const p of t.columns as unknown as TplPart[]) {
        if (p.kind === 'master') {
          const rows = prefill ? await this.siteRows(p.columns, regs, sites, region) : [];
          parts.push({ sheet: p.sheet, cols: p.columns, rows });
          sheets.push({ sheet: p.sheet, rows: rows.length });
          continue;
        }
        // a register sheet only for a register the caller may view (the parts offered are those the caller may use)
        const module = p.ref ? modules.get(p.ref) : undefined;
        if (!p.ref || !module) continue;
        const rr = await this.access.regions(module, 'view');
        if (rr !== null && rr.length === 0) continue;
        const fresh = await this.db.tx.$queryRaw<{ cols: TplColumn[]; sum: string }[]>(Prisma.sql`SELECT tpl_columns(${p.ref}) AS cols, tpl_header_checksum(tpl_columns(${p.ref})) AS sum`);
        const cols = fresh[0] && fresh[0].sum === p.header_checksum ? fresh[0].cols : p.columns;
        const rows = prefill ? await this.prefillRows(p.ref, rr, sites, region, cols) : [];
        parts.push({ sheet: p.sheet, cols, rows });
        sheets.push({ sheet: p.sheet, rows: rows.length });
      }
    }

    const me = await this.db.tx.$queryRaw<{ employee_id: string | null; display_name: string }[]>(Prisma.sql`SELECT employee_id, display_name FROM users WHERE id = ${auth.user.id}::uuid`);
    const issuedAt = new Date();
    const kv: [string, string | number][] = [];
    if (t.kind === 'master') {
      kv.push(['parts', parts.length]);
      for (const p of t.columns as unknown as TplPart[]) kv.push([`part:${p.sheet}`, p.header_checksum]);
    }
    const buffer = await this.buildBook(t, parts, { prefill, employeeId: me[0]?.employee_id?.trim() ?? null, issuedAt }, kv);
    const total = sheets.reduce((n, s) => n + s.rows, 0);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('template_download', 'template', ${t.template_id}::text, NULL,
        ${JSON.stringify({ version: t.current_version, prefill, rows: total, sheets, task_id: taskId ?? null, site_ids: sites, region_id: region, stream: t.stream_code, kind: t.kind })}::jsonb, NULL)`);
    return { buffer, fileName: `${t.template_id}_v${t.current_version}${prefill ? '_prefilled' : ''}_${issuedAt.toISOString().slice(0, 10)}.xlsx` };
  }

  /** The sites of the caller's regions that have at least one task of these columns, with the current values of the task fields. Sorted by Site ID (binary order). */
  private async siteRows(cols: TplColumn[], regs: number[] | null, siteIds: string[], region: number | null): Promise<Record<string, unknown>[]> {
    const codes = [...new Set(cols.filter((c) => c.kind === 'task' && c.task).map((c) => c.task as string))];
    if (codes.length === 0) return [];
    const sites = await this.db.tx.$queryRaw<SiteRow[]>(Prisma.sql`
      SELECT s.id::text AS id, s.site_code, s.name, s.region_id, r.name_en AS region, s.delivery_scenario::text AS scenario, s.project_phase, s.delivery_batch, s.cw_delivery_model,
        s.scope_tower_erection::text AS sc_aa, s.scope_site_adaption::text AS sc_ab, s.scope_gecol_power::text AS sc_ac, s.scope_hlc_fiber::text AS sc_ad,
        s.scope_te_full::text AS sc_ae, s.scope_te_ip_router_only::text AS sc_af
      FROM sites s JOIN regions r ON r.id = s.region_id
      WHERE s.is_active
        ${regs === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regs}::int[])`}
        ${siteIds.length ? Prisma.sql`AND s.id = ANY(${siteIds}::uuid[])` : Prisma.sql`AND s.overall_status <> 'cancelled'`}
        ${region !== null ? Prisma.sql`AND s.region_id = ${region}` : Prisma.empty}
        AND EXISTS (SELECT 1 FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
                    WHERE ti.site_id = s.id AND td.workflow_id = s.workflow_version_id AND td.code = ANY(${codes}::text[]) AND NOT ti.is_na)
      ORDER BY s.site_code COLLATE "C" LIMIT ${MAX_PREFILL_ROWS}`);
    if (sites.length === 0) return [];
    const ids = sites.map((s) => s.id);
    const tasks = await this.db.tx.$queryRaw<TaskCell[]>(Prisma.sql`
      SELECT ti.site_id::text AS site_id, td.code, ti.planned_date::text AS planned_date, ti.planned_start::text AS planned_start, ti.actual_start::text AS actual_start,
        ti.actual_date::text AS actual_date, ti.submitted_date::text AS submitted_date, ti.approved_date::text AS approved_date, ti."values" AS "values", ep.name AS party
      FROM task_instances ti JOIN sites s ON s.id = ti.site_id JOIN task_definitions td ON td.id = ti.task_def_id AND td.workflow_id = s.workflow_version_id
      LEFT JOIN external_parties ep ON ep.id = ti.external_party_id
      WHERE ti.site_id = ANY(${ids}::uuid[]) AND td.code = ANY(${codes}::text[])`);
    const byTask = new Map(tasks.map((x) => [`${x.site_id}|${x.code}`, x]));
    // fields another register owns (r:<register>.<field>): read from the current approved record of the site, shown read only
    const regFields = new Map<string, Set<string>>();
    for (const c of cols) {
      const m = c.kind === 'task' && c.field ? /^r:([a-z_]+)\.([a-z0-9_]+)$/.exec(c.field) : null;
      if (m && m[1] && m[2]) regFields.set(m[1], (regFields.get(m[1]) ?? new Set()).add(m[2]));
    }
    const regData = new Map<string, Record<string, unknown>>();
    for (const key of regFields.keys()) {
      // a register's values are shown only to callers who may view that register in the record's region (security review of 0051);
      // otherwise the read-only cell stays empty
      const def = await this.db.tx.$queryRaw<{ module_key: string }[]>(Prisma.sql`SELECT module_key FROM register_definitions WHERE register_key = ${key}`);
      if (!def[0]) continue;
      const allowed = await this.access.regions(def[0].module_key, 'view');
      if (allowed !== null && allowed.length === 0) continue;
      const rec = await this.db.tx.$queryRaw<{ site_id: string; data: Record<string, unknown> }[]>(Prisma.sql`
        SELECT DISTINCT ON (r.site_id) r.site_id::text AS site_id, r.data FROM register_records r
        WHERE r.register_key = ${key} AND r.site_id = ANY(${ids}::uuid[]) AND r.state = 'approved' AND r.is_current
          ${allowed === null ? Prisma.empty : Prisma.sql`AND r.region_id = ANY(${allowed}::int[])`}
        ORDER BY r.site_id, r.version_no DESC`);
      for (const x of rec) regData.set(`${key}|${x.site_id}`, x.data);
    }
    return sites.map((s, i) => {
      const out: Record<string, unknown> = {};
      for (const c of cols) {
        if (c.kind === 'site') out[c.code] = s.site_code;
        else if (c.kind === 'info') out[c.code] = this.infoValue(c.code, s, i + 1);
        else if (c.kind === 'task' && c.task && c.field) {
          const tk = byTask.get(`${s.id}|${c.task}`);
          if (!tk) continue;
          const f = c.field;
          if (f === 'planned_date' || f === 'planned_start' || f === 'actual_start' || f === 'actual_date' || f === 'submitted_date' || f === 'approved_date') out[c.code] = tk[f];
          else if (f === 'external_party') out[c.code] = tk.party;
          else if (f.startsWith('v:')) out[c.code] = (tk.values ?? {})[f.slice(2)];
          else {
            const m = /^r:([a-z_]+)\.([a-z0-9_]+)$/.exec(f);
            if (m) out[c.code] = regData.get(`${m[1]}|${s.id}`)?.[m[2] as string];
          }
        }
      }
      return out;
    });
  }

  private infoValue(code: string, s: SiteRow, n: number): unknown {
    switch (code) {
      case 'site_name': case 'm:D': return s.name;
      case 'region': case 'm:E': return s.region;
      case 'scenario': case 'm:Z': return SCENARIOS[s.scenario] ?? s.scenario;
      case 'm:A': return n;
      case 'm:X': return s.project_phase;
      case 'm:Y': return s.delivery_batch;
      case 'm:AA': return YES_NA[s.sc_aa ?? ''] ?? s.sc_aa;
      case 'm:AB': return YES_NA[s.sc_ab ?? ''] ?? s.sc_ab;
      case 'm:AC': return YES_NA[s.sc_ac ?? ''] ?? s.sc_ac;
      case 'm:AD': return YES_NA[s.sc_ad ?? ''] ?? s.sc_ad;
      case 'm:AE': return YES_NA[s.sc_ae ?? ''] ?? s.sc_ae;
      case 'm:AF': return YES_NA[s.sc_af ?? ''] ?? s.sc_af;
      case 'm:AG': return s.cw_delivery_model;
      default: return undefined;
    }
  }

  // ------------------------------------------------------------------ the workbook
  private cellValue(c: TplColumn, v: unknown): ExcelJS.CellValue {
    if (v === undefined || v === null || v === '') return null;
    if (c.type === 'date' && typeof v === 'string' && ISO_DAY.test(v)) return isoToDate(v);
    if (c.type === 'number') return typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : String(v);
    if (c.type === 'yes_no') return v === true ? 'Yes' : v === false ? 'No' : String(v);
    // text that starts like a formula is written as text, never as a formula
    const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    return s;
  }

  async build(t: TemplateRow, cols: TplColumn[], rows: Record<string, unknown>[], meta: { prefill: boolean; employeeId: string | null; issuedAt: Date }): Promise<Buffer> {
    return this.buildBook(t, [{ sheet: DATA_SHEET, cols, rows }], meta, []);
  }

  /** One sheet of the file: locked header row, grey locked columns for what is never read, drop-downs and date and number rules for the cells to type. */
  private fillSheet(ws: ExcelJS.Worksheet, lists: ExcelJS.Worksheet, part: BookPart, state: { listCol: number; prefix: boolean }): void {
    const { cols, rows } = part;
    const lastRow = 1 + Math.max(rows.length, 0) + BLANK_ROWS;
    // exceljs writes a validation per range (sqref) but does not type the collection
    const validations = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations;
    const thin = { style: 'thin' as const, color: { argb: 'FFBDC8CC' } };
    const border = { top: thin, left: thin, bottom: thin, right: thin };
    cols.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(Math.max(c.header.length + 4, c.type === 'date' ? 14 : 12), 38);
      col.style = { protection: { locked: c.derived === true || c.kind === 'record_id' }, ...(c.type === 'date' ? { numFmt: 'yyyy-mm-dd' } : {}) };
      const head = ws.getCell(1, i + 1);
      head.value = c.header;
      head.font = { bold: true, color: { argb: c.derived || c.kind === 'record_id' ? 'FF333333' : 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.derived || c.kind === 'record_id' ? 'FFD0D5D8' : c.required ? 'FF1F6F83' : 'FF3E8FA3' } };
      head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      head.border = border;
      head.protection = { locked: true };
      // list values go to the hidden sheet, so there is no 255-character limit
      let formula: string | null = null;
      if (c.options && c.options.length > 0 && c.kind !== 'record_id') {
        state.listCol += 1;
        lists.getCell(1, state.listCol).value = state.prefix ? `${part.sheet}:${c.code}` : c.code;
        c.options.forEach((o, r) => { lists.getCell(r + 2, state.listCol).value = o; });
        const letter = lists.getColumn(state.listCol).letter;
        formula = `${LISTS_SHEET}!$${letter}$2:$${letter}$${c.options.length + 1}`;
      }
      if (!c.derived && c.kind !== 'record_id') {
        const range = `${ws.getColumn(i + 1).letter}2:${ws.getColumn(i + 1).letter}${lastRow}`;
        if (formula && c.multiple) {
          // several values separated by ";": the hidden list shows the choices, the database checks every value on upload
        } else if (formula) {
          validations.add(range, { type: 'list', allowBlank: true, formulae: [formula], showErrorMessage: true, errorStyle: c.allow_other ? 'warning' : 'stop', errorTitle: head.text,
            error: c.allow_other ? 'This value is not in the list. It is accepted while the list allows another value.' : 'Choose a value from the list.' });
        } else if (c.type === 'date') {
          validations.add(range, { type: 'date', operator: 'between', allowBlank: true, formulae: [new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2035, 11, 31))], showErrorMessage: true, errorStyle: 'stop', errorTitle: head.text, error: 'A date between 2020-01-01 and 2035-12-31.' });
        } else if (c.type === 'number') {
          validations.add(range, { type: 'decimal', operator: 'between', allowBlank: true, formulae: [-1e12, 1e12], showErrorMessage: true, errorStyle: 'stop', errorTitle: head.text, error: 'A number.' });
        }
      }
    });
    ws.getRow(1).height = 32;
    rows.forEach((r, ri) => {
      cols.forEach((c, i) => {
        const cell = ws.getCell(ri + 2, i + 1);
        const v = this.cellValue(c, r[c.code]);
        if (v !== null) cell.value = v;
        if (c.derived || c.kind === 'record_id') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFF0' } };
          cell.protection = { locked: true };
        } else {
          cell.protection = { locked: false };
        }
        if (c.type === 'date') cell.numFmt = 'yyyy-mm-dd';
      });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  }

  /** The approved-template workbook: the data sheet(s), an instructions sheet, a Columns sheet for the Site Register templates, the hidden lists and the hidden `_tpl`. */
  async buildBook(
    t: TemplateRow, parts: BookPart[], meta: { prefill: boolean; employeeId: string | null; issuedAt: Date }, extraKv: [string, string | number][],
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GSDN PMIS';
    wb.created = meta.issuedAt;
    wb.title = `${t.template_id} v${t.current_version}`;
    const isSite = t.kind === 'stream' || t.kind === 'master';

    const sheets = parts.map((p) => {
      const siteCol = Math.max(p.cols.findIndex((c) => c.kind === 'site'), 0) + 1;
      return wb.addWorksheet(p.sheet, { views: [{ state: 'frozen', ySplit: 1, xSplit: siteCol }] });
    });
    const ins = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: 'FF2E7D90' } } });
    const colsSheet = isSite ? wb.addWorksheet('Columns') : null;
    const lists = wb.addWorksheet(LISTS_SHEET);
    const tpl = wb.addWorksheet(TPL_SHEET);

    const state = { listCol: 0, prefix: parts.length > 1 };
    parts.forEach((p, i) => this.fillSheet(sheets[i] as ExcelJS.Worksheet, lists, p, state));
    for (const ws of sheets) {
      await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: false, insertRows: true, deleteRows: false, sort: true, autoFilter: true });
    }

    if (colsSheet) {
      colsSheet.addRow(['Sheet', 'Header', 'Master column', 'Task', 'Field', 'Read']);
      colsSheet.getRow(1).font = { bold: true };
      for (const p of parts) {
        for (const c of p.cols) {
          if (c.kind === 'record_id') continue;
          const how = c.kind === 'site' ? 'key' : c.derived ? 'never read (grey)' : 'typed';
          colsSheet.addRow([p.sheet, c.header, c.master_col ?? '', c.task ?? '', c.field ?? '', how]);
        }
      }
      [14, 46, 14, 8, 36, 18].forEach((w, i) => { colsSheet.getColumn(i + 1).width = w; });
    }

    // the hidden sheet that makes the file an approved template
    const kv: [string, string | number][] = [
      ['template_id', t.template_id],
      ['version', t.current_version],
      ['kind', t.kind],
      ['register_key', t.register_key ?? ''],
      ['stream', t.stream_code ?? ''],
      ['header_checksum', t.header_checksum],
      ['field_set_hash', t.field_set_hash ?? ''],
      ['columns', parts.reduce((n, p) => n + p.cols.length, 0)],
      ['data_sheet', parts[0]?.sheet ?? DATA_SHEET],
      ['issued_by', meta.employeeId ?? ''],
      ['issued_at', meta.issuedAt.toISOString()],
      ['prefilled', meta.prefill ? 'yes' : 'no'],
      ...extraKv,
    ];
    kv.forEach(([k, v], i) => { tpl.getCell(i + 1, 1).value = k; tpl.getCell(i + 1, 2).value = v; });
    tpl.state = 'veryHidden';
    lists.state = 'veryHidden';

    ins.getColumn(1).width = 110;
    const lines = isSite
      ? [
        `GSDN PMIS approved template ${t.template_id}, version ${t.current_version}${t.kind === 'master' ? ' (the whole Master)' : ` (stream ${t.stream_code})`}.`,
        t.kind === 'master'
          ? 'Fill the sheet "Master" (one row per site, the Master column order) and the register sheets, and upload the same file in the PMIS. Do not rename, move or delete the columns you use, and do not change the header row.'
          : 'Fill the sheet "Data" (one row per site) and upload the same file in the PMIS. Do not rename, move, add or delete columns, and do not change the header row: the PMIS refuses a changed file.',
        'Files from an older version of the template are refused: download the template again when the PMIS issues a new version.',
        'Grey columns are calculated, set by the workflow (submitted and approved dates), or owned by a register (for example As-Built): they are shown for information and are never read. Enter register data in its register.',
        'Leave a cell empty to keep the current value. An empty cell never clears a value.',
        'Each task you fill is entered as the Data Entry holder (L1) and submitted: it needs its actual date and its mandatory documents (upload them on the task first), exactly as on the task screen.',
        'A task that is locked by a closed gate is refused. A task that waits for a predecessor, or is already in review, is held until that is decided. Nothing is approved until L2 (Data Reviewer & Approver) decides each task.',
        'Dates are typed as dates (yyyy-mm-dd). Cells must hold values, not formulas. The sheet "Columns" lists every header with its Master column and task.',
        ...(t.kind === 'master' ? ['Columns that the PMIS does not own are ignored with a warning. The upload is split into one batch per stream and per register sheet; each follows its own flow.'] : []),
        '',
        'قالب معتمد من نظام GSDN PMIS. املأ الورقة وأعد رفع الملف نفسه. لا تغيّر صف العناوين ولا الأعمدة، فالنظام يرفض الملف المعدَّل أو القديم.',
        'الأعمدة الرمادية محسوبة أو يحددها سير العمل أو يملكها سجل آخر: تظهر للعلم ولا تُقرأ. أدخل بيانات السجلات في سجلها. الخلية الفارغة لا تمسح قيمة موجودة.',
        'تُدخل كل مهمة تملؤها بصفة مُدخل البيانات (L1) وتُرسل، وتحتاج تاريخها الفعلي ومستنداتها الإلزامية كما في شاشة المهمة. المهمة المقفلة ببوابة مغلقة تُرفض، وتُعلَّق التي تنتظر سابقتها أو قيد المراجعة. لا يُعتمد شيء قبل قرار L2.',
      ]
      : [
        `GSDN PMIS approved template ${t.template_id}, version ${t.current_version}.`,
        'Fill the sheet "Data" and upload the same file in the PMIS. Do not rename, move, add or delete columns, and do not change the header row: the PMIS refuses a changed file.',
        'Files from an older version of the template are refused: download the template again when the PMIS issues a new version.',
        'Grey columns are calculated or fixed by the PMIS. They are shown for information and are never read.',
        'Leave a cell empty to keep the current value. An empty cell never clears a value.',
        'The Record ID column is filled in a pre-filled copy. A row with a Record ID updates that record; a row without one is matched by its key (see the register), or creates a new record.',
        'Dates are typed as dates (yyyy-mm-dd). Cells must hold values, not formulas.',
        'The upload becomes a batch. Nothing reaches the register until each row has gone through the normal Entry then Review / Approve levels of its register.',
        '',
        'قالب معتمد من نظام GSDN PMIS. املأ الورقة Data وأعد رفع الملف نفسه. لا تغيّر صف العناوين ولا الأعمدة، فالنظام يرفض الملف المعدَّل أو القديم.',
        'تبقى الخلية الفارغة بلا تغيير ولا تمسح قيمة موجودة. تمرّ كل صفوف الرفع على مستويات الإدخال والمراجعة والاعتماد المعتادة.',
      ];
    lines.forEach((l, i) => { const cell = ins.getCell(i + 1, 1); cell.value = l; cell.alignment = { wrapText: true, vertical: 'top' }; });
    ins.getCell(1, 1).font = { bold: true, size: 13 };
    wb.views = [{ x: 0, y: 0, width: 12000, height: 8000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out as ArrayBuffer);
  }
}
