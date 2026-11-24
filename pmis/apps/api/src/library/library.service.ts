import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { boolParam, oneParam, type Query } from '../common/query';
import { parseSiteSearch, pastedSearchResult, siteScope, siteSearchCond, type PastedSearchDto } from '../common/site-search';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DocumentsService, SITE_DOCS } from '../documents/documents.service';
import { FilterCatalogService } from '../views/filter-catalog.service';
import { TaskViewService, type UserRefDto } from '../workflow/task-view.service';
import { formData, renderForm } from './render';
import { checkTemplate, sanitizeHtml } from './sanitize';

export const ARCHIVE_SCREEN = 'library-archive';
const STATUSES = ['due', 'generated', 'signed_uploaded', 'in_review', 'approved', 'rejected', 'superseded'] as const;
const MAX_LIMIT = 200;

const siteBody = z.object({ site_id: uuidSchema }).strict();
const generateBody = z.object({ site_id: uuidSchema, remarks: z.string().max(1000).nullable().optional() }).strict();
const reasonBody = z.object({ reason: z.string().max(2000) }).strict();
const zipBody = z.object({
  doc_code: z.string().trim().min(1).max(40).optional(),
  site_id: uuidSchema.optional(),
  status: z.enum(STATUSES).optional(),
  include_superseded: z.boolean().optional(),
  q: z.string().max(20000).optional(),
  filter: z.string().max(8000).optional(),
}).strict();

/** The status of a slot row (W5 lifecycle): an uploaded file wins, then a generated copy, else the document is due (its task opened). */
const SLOT_STATUS = Prisma.sql`CASE s.status::text WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' WHEN 'in_review' THEN 'in_review' WHEN 'uploaded' THEN 'signed_uploaded'
  ELSE CASE WHEN gd.id IS NOT NULL THEN 'generated' ELSE 'due' END END`;

/**
 * The rows of the Archive (alias `s` outside): one per document slot of a site, and, with superseded versions, one per older file. Every row keeps the
 * slot's region and register key, so the region scope and the register modules apply as on GET /documents. Row security applies (the caller's transaction).
 */
const SLOT_ROWS = Prisma.sql`
  SELECT 'S:' || s.id::text AS key, s.id AS slot_id, ${SLOT_STATUS} AS status, s.site_id, si.site_code, si.owner_site_id, si.name, s.region_id, s.is_global, s.register_key,
    rg.name_en AS region_name, rg.name_ar AS region_name_ar, cl.cluster_code AS cluster, dt.id AS doc_type_id, dt.code AS doc_code, dt.name_en AS doc_name_en, dt.name_ar AS doc_name_ar,
    s.candidate_label, gd.number AS doc_number, gd.id AS generated_id, gd.generated_at, cf.version, s.task_id, td.code AS task_code, td.name_en AS task_name_en, td.name_ar AS task_name_ar,
    ti.state::text AS task_state, cf.id AS file_id, cf.file_group_id, cf.original_name AS file_name, cf.mime_type,
    (SELECT count(*) FROM document_files x WHERE x.slot_id = s.id AND x.is_current)::int AS file_count,
    cf.uploaded_by, cf.uploaded_at, ap.acted_by AS approved_by, coalesce(cf.approved_date, (ap.created_at AT TIME ZONE 'Africa/Tripoli')::date) AS approved_at
  FROM document_slots s
  JOIN document_types dt ON dt.id = s.doc_type_id
  JOIN sites si ON si.id = s.site_id
  JOIN regions rg ON rg.id = s.region_id
  LEFT JOIN clusters cl ON cl.id = si.cluster_id
  LEFT JOIN task_instances ti ON ti.id = s.task_id
  LEFT JOIN task_definitions td ON td.id = ti.task_def_id
  LEFT JOIN LATERAL (SELECT f.id, f.version, f.file_group_id, f.original_name, f.mime_type, f.uploaded_by, f.uploaded_at, f.approved_date FROM document_files f
                     WHERE f.slot_id = s.id AND f.is_current ORDER BY f.uploaded_at DESC, f.id DESC LIMIT 1) cf ON true
  LEFT JOIN LATERAL (SELECT g.id, g.number, g.generated_at FROM library_generated_docs g
                     WHERE s.task_id IS NOT NULL AND g.task_id = s.task_id AND g.doc_type_id = s.doc_type_id AND g.status = 'generated' ORDER BY g.generated_at DESC LIMIT 1) gd ON true
  LEFT JOIN LATERAL (SELECT w.acted_by, w.created_at FROM workflow_steps w
                     WHERE s.status::text = 'approved' AND w.task_id = s.task_id AND w.action::text = 'approve' ORDER BY w.created_at DESC LIMIT 1) ap ON true
  WHERE s.site_id IS NOT NULL AND s.status::text <> 'not_required'`;

const OLD_ROWS = Prisma.sql`
  SELECT 'F:' || f.id::text AS key, s.id AS slot_id, 'superseded'::text AS status, s.site_id, si.site_code, si.owner_site_id, si.name, s.region_id, s.is_global, s.register_key,
    rg.name_en AS region_name, rg.name_ar AS region_name_ar, cl.cluster_code AS cluster, dt.id AS doc_type_id, dt.code AS doc_code, dt.name_en AS doc_name_en, dt.name_ar AS doc_name_ar,
    s.candidate_label, NULL::text AS doc_number, NULL::uuid AS generated_id, NULL::timestamptz AS generated_at, f.version, s.task_id, td.code AS task_code, td.name_en AS task_name_en,
    td.name_ar AS task_name_ar, ti.state::text AS task_state, f.id AS file_id, f.file_group_id, f.original_name AS file_name, f.mime_type, 1 AS file_count,
    f.uploaded_by, f.uploaded_at, NULL::uuid AS approved_by, f.approved_date AS approved_at
  FROM document_files f
  JOIN document_slots s ON s.id = f.slot_id
  JOIN document_types dt ON dt.id = s.doc_type_id
  JOIN sites si ON si.id = s.site_id
  JOIN regions rg ON rg.id = s.region_id
  LEFT JOIN clusters cl ON cl.id = si.cluster_id
  LEFT JOIN task_instances ti ON ti.id = s.task_id
  LEFT JOIN task_definitions td ON td.id = ti.task_def_id
  WHERE s.site_id IS NOT NULL AND NOT f.is_current AND f.superseded_by IS NOT NULL`;

interface RowDb {
  key: string;
  slot_id: string;
  status: string;
  site_id: string;
  site_code: string;
  name: string | null;
  region_id: number;
  region_name: string | null;
  region_name_ar: string | null;
  cluster: string | null;
  doc_type_id: string;
  doc_code: string;
  doc_name_en: string;
  doc_name_ar: string | null;
  candidate_label: string | null;
  doc_number: string | null;
  generated_id: string | null;
  generated_at: Date | null;
  version: number | null;
  task_id: string | null;
  task_code: string | null;
  task_name_en: string | null;
  task_name_ar: string | null;
  task_state: string | null;
  register_key: string | null;
  file_id: string | null;
  file_group_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_count: number;
  uploaded_by: string | null;
  uploaded_at: Date | null;
  approved_by: string | null;
  approved_at: string | Date | null;
  form_id?: string | null;
}

const GROUP_LABELS: Record<string, { en: string; ar: string }> = {
  OM: { en: 'O&M', ar: 'التشغيل والصيانة' },
  DISMANTLE: { en: 'Dismantle', ar: 'التفكيك' },
  REGISTERS: { en: 'Registers', ar: 'السجلات' },
  OTHER: { en: 'Other documents', ar: 'مستندات أخرى' },
};
/** The order of the owner's list (W5-2): the streams, O&M after Installation (TE), then Dismantle and the registers. A stream not in the list follows its sort order. */
const GROUP_RANK: Record<string, number> = { DESIGN_ACQ: 10, CW: 20, TE: 30, OM: 35, CLOSURE: 40, DISMANTLE: 80, REGISTERS: 90, OTHER: 99 };

const dateOnly = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * W5 of plan 2026-11-23-next-ui-cleanup (contract 0.15.70, migration 0151): the Library menu. Forms lists the approved forms, previews and generates a
 * filled document of a site (the database checks who, numbers it and audits it; this service renders the template). Archive counts and lists every
 * document of the sites by type, with its lifecycle, and starts the bulk zip through the existing zip export. The document slots, files, downloads,
 * version history and zips are the existing ones (DocumentsService, ZipService).
 */
@Injectable()
export class LibraryMenuService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly docs: DocumentsService,
    private readonly filters: FilterCatalogService,
    private readonly view: TaskViewService,
    private readonly stepUp: StepUpService,
  ) {}

  private async one<T>(sql: Prisma.Sql): Promise<T> {
    const r = await this.db.tx.$queryRaw<{ j: T }[]>(sql);
    return r[0]!.j;
  }

  private async canConfigure(): Promise<boolean> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      SELECT (app_actor_is_admin('document_types', 'edit'::"PermissionAction") AND app_actor_region_filter('document_types', 'edit'::"PermissionAction") IS NULL) AS ok`);
    return r[0]?.ok === true;
  }

  private async canConfigureSettings(): Promise<boolean> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      SELECT (app_actor_is_admin('admin.settings', 'edit'::"PermissionAction") AND app_actor_region_filter('admin.settings', 'edit'::"PermissionAction") IS NULL) AS ok`);
    return r[0]?.ok === true;
  }

  // ----------------------------------------------------------------------------------------------------------------- Forms

  /** GET /library/forms: the approved forms (one per code) and the uploaded blank forms of the Document Library (download only). */
  async forms() {
    await this.access.requireRegions(SITE_DOCS, 'view');
    const tpl = await this.db.tx.$queryRaw<{ j: Record<string, unknown> }[]>(Prisma.sql`
      SELECT lib_form_template_json(t.id) AS j FROM library_form_templates t WHERE t.status = 'approved' ORDER BY t.code`);
    const blanks = await this.db.tx.$queryRaw<{ id: string; code: string; name_en: string; name_ar: string | null; blank: string; uploaded_at: Date | null }[]>(Prisma.sql`
      SELECT dt.id::text AS id, dt.code, dt.name_en, dt.name_ar, dt.blank_form_file_id::text AS blank,
        (SELECT b.uploaded_at FROM document_blank_forms b WHERE b.id = dt.blank_form_file_id) AS uploaded_at
      FROM document_types dt WHERE dt.is_active AND dt.blank_form_file_id IS NOT NULL ORDER BY dt.code`);
    const items = [
      ...tpl.map(({ j }) => ({
        id: j.id as string, kind: 'html' as const, code: j.code as string, name_en: j.name_en as string, name_ar: (j.name_ar as string | null) ?? null, version: j.version as number,
        doc_type_id: j.doc_type_id as string, doc_code: j.doc_code as string, doc_name_en: j.doc_name_en as string, doc_name_ar: (j.doc_name_ar as string | null) ?? null,
        trigger_task_code: j.trigger_task_code as string, trigger_task_name_en: (j.trigger_task_name_en as string | null) ?? null, trigger_task_name_ar: (j.trigger_task_name_ar as string | null) ?? null,
        numbering_pattern: j.numbering_pattern as string, blank_form_file_id: null, owner: (j.approved_by as UserRefDto | null) ?? null, updated_at: (j.updated_at as string | null) ?? null,
      })),
      ...blanks.map((b) => ({
        id: b.id, kind: 'blank_form' as const, code: b.code, name_en: b.name_en, name_ar: b.name_ar, version: null, doc_type_id: b.id, doc_code: b.code, doc_name_en: b.name_en,
        doc_name_ar: b.name_ar, trigger_task_code: null, trigger_task_name_en: null, trigger_task_name_ar: null, numbering_pattern: null, blank_form_file_id: b.blank, owner: null,
        updated_at: b.uploaded_at ? b.uploaded_at.toISOString() : null,
      })),
    ];
    return { items, can_configure: await this.canConfigure() };
  }

  private templateId(id: string): string {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The form does not exist or is not approved.');
    return id;
  }

  /** POST /library/forms/{id}/preview: filled with the site data, no number taken. */
  async preview(templateId: string, raw: unknown) {
    const id = this.templateId(templateId);
    const b = parse(siteBody, raw);
    const r = await this.one<{ data: Record<string, unknown>; html: string; bindings: Record<string, string>; task_id: string | null }>(
      Prisma.sql`SELECT lib_preview(${id}::uuid, ${b.site_id}::uuid) AS j`);
    const out = renderForm(r.html, formData(r.data, r.bindings));
    // the filled copy goes through the allow-list again (the template was checked on save; the data is escaped by the renderer)
    return { html: sanitizeHtml(out.html).html, task_id: r.task_id ?? null, warnings: out.missing };
  }

  /** POST /library/forms/{id}/generate: the database numbers and keeps it (audited); the file is rendered here and attached in the same transaction. */
  async generate(templateId: string, raw: unknown) {
    const id = this.templateId(templateId);
    const b = parse(generateBody, raw);
    const g = await this.one<{ id: string; data: Record<string, unknown>; html: string; bindings: Record<string, string> }>(
      Prisma.sql`SELECT lib_generate(${id}::uuid, ${b.site_id}::uuid, ${b.remarks ?? null}::text) AS j`);
    const out = renderForm(g.html, formData(g.data, g.bindings));
    const doc = await this.one<Record<string, unknown>>(Prisma.sql`SELECT lib_generated_attach(${g.id}::uuid, ${sanitizeHtml(out.html).html}::text) AS j`);
    return { ...doc, warnings: out.missing };
  }

  /** GET /library/generated/{id}/download: the stored file (audited with its purpose). */
  async download(docId: string, purpose: string | undefined) {
    if (!uuidSchema.safeParse(docId).success) throw problems.notFound();
    const p = purpose ?? 'download';
    if (!['download', 'print', 'view'].includes(p)) throw problems.validation([{ path: '/purpose', code: 'invalid', message: 'download, print or view.' }]);
    return this.one<{ html: string; download_name: string }>(Prisma.sql`SELECT lib_generated_read(${docId}::uuid, ${p}::text) AS j`);
  }

  async voidDoc(auth: AuthContext, docId: string, raw: unknown) {
    if (!uuidSchema.safeParse(docId).success) throw problems.notFound();
    const b = parse(reasonBody, raw);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT lib_generated_void(${docId}::uuid, ${b.reason}::text) AS j`);
  }

  // ----------------------------------------------------------------------------------------------------------------- Form templates (Settings)

  async templates() {
    if (!(await this.canConfigure())) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin or a delegate of the Document Library for all regions manages the form templates.' });
    const rows = await this.db.tx.$queryRaw<{ j: unknown }[]>(Prisma.sql`SELECT lib_form_template_json(t.id) AS j FROM library_form_templates t ORDER BY t.code, t.version DESC`);
    return { items: rows.map((r) => r.j) };
  }

  async templateHtml(templateId: string) {
    const id = this.templateId(templateId);
    return { html: await this.one<string>(Prisma.sql`SELECT lib_form_template_html(${id}::uuid) AS j`) };
  }

  /** POST /library/form-templates (multipart): the HTML file and the fields of the form; the database checks them (closed body, field errors). */
  async saveTemplateUpload(file: { buffer: Buffer; originalname: string } | undefined, body: Record<string, unknown> | undefined) {
    if (!file) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the HTML template as the multipart field "file".' }]);
    const html = file.buffer.toString('utf8');
    if (html.includes('\u0000') || !/\.(html?|htm)$/i.test(file.originalname || '')) {
      throw problems.validation([{ path: '/file', code: 'invalid', message: 'An HTML file (.html), UTF-8 text.' }]);
    }
    const raw: Record<string, unknown> = { ...(body ?? {}), html };
    if (typeof raw.bindings === 'string') {
      try { raw.bindings = JSON.parse(raw.bindings); } catch { throw problems.validation([{ path: '/bindings', code: 'invalid', message: 'JSON object of name to data path.' }]); }
    }
    for (const k of ['name_ar']) if (raw[k] === '') raw[k] = null;
    return this.saveTemplate(raw);
  }

  async saveTemplate(raw: unknown) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw problems.validation([{ path: '/', code: 'invalid', message: 'The body is a JSON object.' }]);
    const { reason, ...rest } = raw as Record<string, unknown>;
    if (reason !== undefined && typeof reason !== 'string') throw problems.validation([{ path: '/reason', code: 'invalid', message: 'The reason is text.' }]);
    // the allow-list of sanitize.ts first (the database repeats a deny-list as defence in depth): anything it would remove refuses the template
    if (typeof rest.html === 'string') {
      const bad = checkTemplate(rest.html);
      if (bad.length) {
        throw problems.validation([{ path: '/html', code: 'unsafe_html', message: `Not allowed in a form: ${bad.slice(0, 20).join(', ')}.` }],
          'The form holds markup outside the allow-list of printable forms (no script, frame, link, event handler, external URL or CSS import).');
      }
    }
    return this.one(Prisma.sql`SELECT lib_form_template_save(${JSON.stringify(rest)}::jsonb, ${(reason as string | undefined) ?? null}::text) AS j`);
  }

  async approveTemplate(auth: AuthContext, templateId: string, raw: unknown) {
    const id = this.templateId(templateId);
    const b = parse(reasonBody, raw);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT lib_form_template_approve(${id}::uuid, ${b.reason}::text) AS j`);
  }

  async retireTemplate(auth: AuthContext, templateId: string, raw: unknown) {
    const id = this.templateId(templateId);
    const b = parse(reasonBody, raw);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT lib_form_template_retire(${id}::uuid, ${b.reason}::text) AS j`);
  }

  // ----------------------------------------------------------------------------------------------------------------- Archive settings

  archiveSetting(): Promise<{ version: number; hidden: string[]; order: string[]; default_columns: string[]; zip_limit: number }> {
    return this.one(Prisma.sql`SELECT library_archive_json() AS j`);
  }

  async setArchiveSetting(ifMatch: string | undefined, raw: unknown): Promise<{ version: number }> {
    const version = parseIfMatch(ifMatch);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw problems.validation([{ path: '/', code: 'invalid', message: 'The body is a JSON object.' }]);
    const { reason, ...rest } = raw as Record<string, unknown>;
    if (reason !== undefined && typeof reason !== 'string') throw problems.validation([{ path: '/reason', code: 'invalid', message: 'The reason is text.' }]);
    return this.one(Prisma.sql`SELECT admin_set_library_archive(${JSON.stringify(rest)}::jsonb, ${(reason as string | undefined) ?? null}::text, ${version}::int) AS j`);
  }

  // ----------------------------------------------------------------------------------------------------------------- Archive

  /** The visibility of the archive rows (alias `s`): the caller's Documents regions and the register modules (as GET /documents). */
  private async scope(regions: number[] | null): Promise<Prisma.Sql[]> {
    const conds: Prisma.Sql[] = [];
    if (regions !== null) conds.push(Prisma.sql`(s.region_id = ANY(${regions}::int[]) OR s.is_global)`);
    conds.push(await this.docs.registerScopeSql());
    return conds;
  }

  /** GET /library/archive: one card per document type with a file or a generated document, grouped by stream, with the counts of its slots. */
  async archive() {
    const regions = await this.access.requireRegions(SITE_DOCS, 'view');
    const vis = await this.scope(regions);
    const counts = await this.db.tx.$queryRaw<{ doc_type_id: string; doc_code: string; name_en: string; name_ar: string | null; total: number; approved: number; waiting: number; missing: number; generated: number; files: number }[]>(Prisma.sql`
      SELECT s.doc_type_id::text AS doc_type_id, s.doc_code, min(s.doc_name_en) AS name_en, min(s.doc_name_ar) AS name_ar, count(*)::int AS total,
        count(*) FILTER (WHERE s.status = 'approved')::int AS approved,
        count(*) FILTER (WHERE s.status IN ('signed_uploaded', 'in_review'))::int AS waiting,
        count(*) FILTER (WHERE s.status IN ('due', 'generated', 'rejected'))::int AS missing,
        count(*) FILTER (WHERE s.status = 'generated')::int AS generated,
        coalesce(sum(s.file_count), 0)::int AS files
      FROM (${SLOT_ROWS}) s WHERE ${Prisma.join(vis, ' AND ')}
      GROUP BY s.doc_type_id, s.doc_code`);
    const gen = await this.db.tx.$queryRaw<{ doc_type_id: string; n: number }[]>(Prisma.sql`
      SELECT g.doc_type_id::text AS doc_type_id, count(*)::int AS n FROM library_generated_docs g
      WHERE ${regions === null ? Prisma.sql`true` : Prisma.sql`g.region_id = ANY(${regions}::int[])`} GROUP BY g.doc_type_id`);
    const genBy = new Map(gen.map((g) => [g.doc_type_id, g.n]));
    const present = counts.filter((c) => c.files > 0 || (genBy.get(c.doc_type_id) ?? 0) > 0);
    const groups = await this.groupsOf(present.map((c) => c.doc_type_id));
    const setting = await this.archiveSetting();
    const configure = await this.canConfigureSettings();
    const hidden = new Set(setting.hidden);
    const order = new Map(setting.order.map((c, i) => [c, i]));
    const byGroup = new Map<string, { key: string; name_en: string; name_ar: string | null; rank: number; cards: unknown[] }>();
    const sorted = [...present].sort((a, b) => (order.get(a.doc_code) ?? 1e6) - (order.get(b.doc_code) ?? 1e6) || a.doc_code.localeCompare(b.doc_code));
    for (const c of sorted) {
      if (hidden.has(c.doc_code) && !configure) continue;
      const g = groups.get(c.doc_type_id) ?? { key: 'OTHER', name_en: GROUP_LABELS.OTHER!.en, name_ar: GROUP_LABELS.OTHER!.ar, rank: GROUP_RANK.OTHER! };
      const grp = byGroup.get(g.key) ?? { ...g, cards: [] };
      grp.cards.push({ doc_code: c.doc_code, doc_type_id: c.doc_type_id, name_en: c.name_en, name_ar: c.name_ar, hidden: hidden.has(c.doc_code),
        counts: { total: c.total, approved: c.approved, waiting_review: c.waiting, missing: c.missing, generated: c.generated, files: c.files } });
      byGroup.set(g.key, grp);
    }
    const out = [...byGroup.values()].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).map((g) => ({ key: g.key, name_en: g.name_en, name_ar: g.name_ar, cards: g.cards }));
    return { groups: out, can_configure: configure };
  }

  /** The Archive group of each document type: the stream of the task it is placed on (O&M for a task of a work view that is not a stream), Dismantle or Registers. */
  private async groupsOf(ids: string[]): Promise<Map<string, { key: string; name_en: string; name_ar: string | null; rank: number }>> {
    const out = new Map<string, { key: string; name_en: string; name_ar: string | null; rank: number }>();
    if (!ids.length) return out;
    const rows = await this.db.tx.$queryRaw<{ id: string; kind: string; register_key: string | null; stream: string | null; stream_en: string | null; stream_ar: string | null; stream_sort: number | null;
      view_code: string | null; view_en: string | null; view_ar: string | null }[]>(Prisma.sql`
      SELECT DISTINCT ON (pl.doc_type_id) pl.doc_type_id::text AS id, pl.kind::text AS kind, pl.register_key, ws.code AS stream, ws.name_en AS stream_en, ws.name_ar AS stream_ar, ws.sort_order AS stream_sort,
        v.code AS view_code, v.name_en AS view_en, v.name_ar AS view_ar
      FROM document_type_placements pl
      LEFT JOIN task_definitions td ON td.id = pl.task_def_id
      LEFT JOIN stage_definitions st ON st.id = td.stage_id
      LEFT JOIN workflow_streams ws ON ws.workflow_id = st.workflow_id AND ws.code = st.stream_code
      LEFT JOIN LATERAL (SELECT wv.code, wv.name_en, wv.name_ar FROM workflow_view_members m JOIN workflow_views wv ON wv.workflow_id = m.workflow_id AND wv.code = m.view_code
                         WHERE m.workflow_id = td.workflow_id AND m.member_kind = 'task' AND m.member_code = td.code
                           AND NOT EXISTS (SELECT 1 FROM workflow_streams x WHERE x.workflow_id = m.workflow_id AND x.code = m.view_code) ORDER BY wv.sort_order LIMIT 1) v ON true
      WHERE pl.doc_type_id = ANY(${ids}::uuid[])
      ORDER BY pl.doc_type_id, (pl.kind::text = 'task') DESC, td.sort_order NULLS LAST, pl.id`);
    for (const r of rows) {
      let g: { key: string; name_en: string; name_ar: string | null; rank: number };
      if (r.view_code) g = { key: r.view_code, name_en: r.view_en ?? GROUP_LABELS.OM!.en, name_ar: r.view_ar ?? GROUP_LABELS.OM!.ar, rank: GROUP_RANK[r.view_code] ?? 36 };
      else if (r.stream) g = { key: r.stream, name_en: r.stream_en ?? r.stream, name_ar: r.stream_ar, rank: GROUP_RANK[r.stream] ?? 50 + (r.stream_sort ?? 0) };
      else if (r.kind === 'register' && r.register_key === 'dismantle') g = { key: 'DISMANTLE', name_en: GROUP_LABELS.DISMANTLE!.en, name_ar: GROUP_LABELS.DISMANTLE!.ar, rank: GROUP_RANK.DISMANTLE! };
      else if (r.kind === 'register' || r.kind === 'qc') g = { key: 'REGISTERS', name_en: GROUP_LABELS.REGISTERS!.en, name_ar: GROUP_LABELS.REGISTERS!.ar, rank: GROUP_RANK.REGISTERS! };
      else continue;
      out.set(r.id, g);
    }
    return out;
  }

  /** The WHERE of the archive rows for a query (list and zip share it). */
  private async rowsWhere(q: Query, regions: number[] | null): Promise<{ conds: Prisma.Sql[]; superseded: boolean; search: ReturnType<typeof parseSiteSearch> }> {
    const conds = await this.scope(regions);
    const doc = oneParam(q, 'doc_code');
    if (doc !== undefined) conds.push(Prisma.sql`s.doc_code = ${doc}`);
    const site = oneParam(q, 'site_id');
    if (site !== undefined) {
      if (!uuidSchema.safeParse(site).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'Not a uuid.' }]);
      conds.push(Prisma.sql`s.site_id = ${site}::uuid`);
    }
    const status = oneParam(q, 'status');
    if (status !== undefined) {
      if (!(STATUSES as readonly string[]).includes(status)) throw problems.validation([{ path: '/status', code: 'invalid', message: `One of ${STATUSES.join(', ')}.` }]);
      conds.push(Prisma.sql`s.status = ${status}`);
    }
    const search = parseSiteSearch(oneParam(q, 'q'));
    const sc = siteSearchCond(search, 's', [Prisma.sql`s.doc_number`, Prisma.sql`s.file_name`]);
    if (sc) conds.push(sc);
    const { where } = await this.filters.compile(ARCHIVE_SCREEN, q);
    if (where) conds.push(where);
    const superseded = boolParam(q, 'include_superseded') || status === 'superseded';
    return { conds, superseded, search };
  }

  private fromRows(superseded: boolean): Prisma.Sql {
    return superseded ? Prisma.sql`(${SLOT_ROWS} UNION ALL ${OLD_ROWS})` : Prisma.sql`(${SLOT_ROWS})`;
  }

  /** GET /library/archive/rows */
  async rows(q: Query) {
    const regions = await this.access.requireRegions(SITE_DOCS, 'view');
    const raw = typeof q.limit === 'string' ? Number(q.limit) : 50;
    const limit = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_LIMIT) : 50;
    const offset = typeof q.cursor === 'string' && /^[0-9]{1,7}$/.test(q.cursor) ? Number(q.cursor) : 0;
    const { conds, superseded, search } = await this.rowsWhere(q, regions);
    const base = await this.scope(regions);
    const from = this.fromRows(superseded);
    const rows = await this.db.tx.$queryRaw<RowDb[]>(Prisma.sql`
      SELECT s.* FROM ${from} s WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY s.site_code, s.doc_code, s.candidate_label NULLS FIRST, s.status = 'superseded', s.version DESC NULLS LAST, s.key
      LIMIT ${limit + 1} OFFSET ${offset}`);
    const cnt = await this.db.tx.$queryRaw<{ total: number; filtered: number }[]>(Prisma.sql`
      SELECT (SELECT count(*) FROM ${from} s WHERE ${Prisma.join([...base, ...(oneParam(q, 'doc_code') !== undefined ? [Prisma.sql`s.doc_code = ${oneParam(q, 'doc_code')}`] : []), ...(oneParam(q, 'site_id') !== undefined ? [Prisma.sql`s.site_id = ${oneParam(q, 'site_id')}::uuid`] : [])], ' AND ')})::int AS total,
             (SELECT count(*) FROM ${from} s WHERE ${Prisma.join(conds, ' AND ')})::int AS filtered`);
    const page = rows.slice(0, limit);
    const forms = await this.formsFor(page);
    const refs = await this.view.userRefs([...new Set(page.flatMap((r) => [r.uploaded_by, r.approved_by]).filter((x): x is string => !!x))]);
    let pasted: PastedSearchDto | undefined;
    if (search.kind === 'list') {
      const siteRegions = await this.access.regions('sites', 'view');
      pasted = await pastedSearchResult(this.db.tx, search, siteScope(regions, siteRegions));
    }
    return {
      items: page.map((r) => ({
        key: r.key, slot_id: r.slot_id, status: r.status, site_id: r.site_id, site_code: r.site_code, site_name: r.name, region_id: r.region_id,
        region_name: r.region_name, region_name_ar: r.region_name_ar, cluster: r.cluster, doc_type_id: r.doc_type_id, doc_code: r.doc_code, doc_name_en: r.doc_name_en,
        doc_name_ar: r.doc_name_ar, candidate_label: r.candidate_label, doc_number: r.doc_number, generated_id: r.generated_id, version: r.version,
        task_id: r.task_id, task_code: r.task_code, task_name_en: r.task_name_en, task_name_ar: r.task_name_ar, register_key: r.register_key,
        file_id: r.file_id, file_group_id: r.file_group_id, file_name: r.file_name, mime_type: r.mime_type, file_count: r.file_count,
        uploaded_by: r.uploaded_by ? refs.get(r.uploaded_by) ?? null : null, uploaded_at: r.uploaded_at, approved_by: r.approved_by ? refs.get(r.approved_by) ?? null : null,
        approved_at: dateOnly(r.approved_at), generated_at: r.generated_at, form_id: forms.get(`${r.doc_type_id}|${r.task_code ?? ''}`) ?? null,
      })),
      page: { limit, next_cursor: rows.length > limit ? String(offset + limit) : null },
      counts: cnt[0] ?? { total: 0, filtered: 0 },
      ...(pasted ? { search: pasted } : {}),
    };
  }

  /** The approved form of each (document type, task code) on the page, so a row can offer "Generate". */
  private async formsFor(rows: RowDb[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.doc_type_id))];
    if (!ids.length) return new Map();
    const f = await this.db.tx.$queryRaw<{ doc_type_id: string; trigger_task_code: string; id: string }[]>(Prisma.sql`
      SELECT doc_type_id::text AS doc_type_id, trigger_task_code, id::text AS id FROM library_form_templates WHERE status = 'approved' AND doc_type_id = ANY(${ids}::uuid[])`);
    return new Map(f.map((x) => [`${x.doc_type_id}|${x.trigger_task_code}`, x.id]));
  }

  /** POST /library/archive/zip: the uploaded files of the filtered rows, through the existing zip export (its job, manifest and audit). */
  async zipFileIds(raw: unknown): Promise<string[]> {
    await this.docs.downloadRegions();
    const b = parse(zipBody, raw ?? {});
    const regions = await this.access.requireRegions(SITE_DOCS, 'view');
    const q: Query = {};
    for (const [k, v] of Object.entries(b)) if (v !== undefined) q[k] = typeof v === 'boolean' ? String(v) : v;
    const { conds, superseded } = await this.rowsWhere(q, regions);
    const setting = await this.archiveSetting();
    const ids = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT DISTINCT x.id::text AS id FROM ${this.fromRows(superseded)} s
      JOIN document_files x ON x.slot_id = s.slot_id AND (CASE WHEN s.status = 'superseded' THEN x.id = s.file_id ELSE x.is_current END)
      WHERE ${Prisma.join(conds, ' AND ')} LIMIT ${setting.zip_limit + 1}`);
    if (ids.length === 0) throw problems.validation([{ path: '/', code: 'no_files', message: 'No file matches this view in your regions.' }]);
    if (ids.length > setting.zip_limit) {
      throw problems.validation([{ path: '/', code: 'too_many_files', message: `More than ${setting.zip_limit} files match: narrow the filter (Settings > Documents > Archive sets the limit).` }]);
    }
    return ids.map((r) => r.id);
  }
}
