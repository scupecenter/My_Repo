import { Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { ProblemException, problems } from '../common/problem';
import { boolParam, oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskViewService, UserRefDto } from '../workflow/task-view.service';
import { readExifDate } from './exif';
import { attachmentHeader, cleanOriginalName, displayName, NameParts } from './naming';
import { evalRule } from './rules';
import { formatAllowed, sniff } from './sniff';
import { StorageService, newObjectKey } from './storage.service';
import { suggestSlots } from './suggest';

export const SITE_DOCS = 'sites.documents';
/** The largest file any document may allow (the library caps max_size_mb at 200); the multipart parser stops there. */
export const HARD_MAX_BYTES = 200 * 1024 * 1024 + 1024;

export interface DocumentFileDto {
  id: string;
  file_group_id: string;
  version: number;
  is_current: boolean;
  original_name: string;
  download_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by?: UserRefDto;
  uploaded_at: Date;
  approved_date: string | null;
  capture_date: Date | null;
  unknown_capture_date: boolean;
  superseded_by: string | null;
}

export interface DocumentSlotDto {
  id: string;
  doc_type_id: string;
  doc_code: string;
  name_en: string;
  name_ar: string | null;
  kind: string;
  form_kind: string | null;
  mandatory: boolean;
  conditional: boolean;
  status: string;
  reject_reason: string | null;
  candidate_label: string | null;
  formats: string[];
  max_size_mb: number;
  min_files: number;
  max_files: number | null;
  camera_only: boolean;
  expiry_tracked: boolean;
  can_upload: boolean;
  blank_form_file_id: string | null;
  valid_to: string | null;
  files: DocumentFileDto[];
}

interface TaskCtx {
  id: string;
  site_id: string;
  region_id: number;
  state: string;
  task_code: string;
  site_code: string;
  values: unknown;
  custom: unknown;
  site: Record<string, unknown>;
}

interface SlotRow {
  id: string;
  doc_type_id: string;
  doc_code: string;
  name_en: string;
  name_ar: string | null;
  kind: string;
  form_kind: string | null;
  status: string;
  reject_reason: string | null;
  candidate_label: string | null;
  conditional_declared: boolean;
  condition_rule: unknown;
  spec: Record<string, unknown> | null;
  dt_mandatory: boolean;
  dt_formats: string[];
  dt_max_size_mb: number;
  dt_min_files: number;
  dt_max_files: number | null;
  dt_photo_rules: unknown;
  dt_has_expiry: boolean;
  blank_form_file_id: string | null;
  valid_to: string | null;
}

interface FileRow {
  id: string;
  slot_id: string;
  file_group_id: string;
  version: number;
  is_current: boolean;
  original_name: string;
  stored_name: string;
  ext: string | null;
  mime_type: string;
  size_bytes: bigint;
  sha256: string;
  uploaded_by: string;
  uploaded_at: Date;
  approved_date: string | null;
  capture_date: Date | null;
  unknown_capture_date: boolean;
  superseded_by: string | null;
  withdrawn_at: Date | null;
  ord?: number;
}

const ORD = Prisma.sql`(SELECT count(DISTINCT x.file_group_id) FROM document_files x WHERE x.slot_id = f.slot_id
  AND (SELECT min(y.uploaded_at) FROM document_files y WHERE y.file_group_id = x.file_group_id) <= (SELECT min(y.uploaded_at) FROM document_files y WHERE y.file_group_id = f.file_group_id))::int`;
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const addSlotBody = z.object({ doc_code: z.string().min(1).max(40), candidate_label: z.string().trim().max(100).nullable().optional() }).strict();
const suggestBody = z.object({ file_names: z.array(z.string().max(255)).min(1).max(50) }).strict();

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly view: TaskViewService,
    private readonly storage: StorageService,
  ) {}

  // ----------------------------------------------------------------------------------------------------------------- task context

  /** The task as the caller may see it (404 outside the caller's regions), with the site row the rules read. */
  async taskCtx(taskId: string): Promise<TaskCtx> {
    const regions = await this.access.requireRegions('sites', 'view');
    if (!uuidSchema.safeParse(taskId).success) throw problems.notFound();
    const rows = await this.db.tx.$queryRaw<{ id: string; site_id: string; region_id: number; state: string; task_code: string; site_code: string; values: unknown; custom: unknown; site: Record<string, unknown> }[]>(Prisma.sql`
      SELECT t.id::text AS id, t.site_id::text AS site_id, t.region_id, t.state::text AS state, td.code AS task_code, s.site_code, t."values" AS "values", t.custom AS custom, to_jsonb(s) AS site
      FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id JOIN sites s ON s.id = t.site_id
      WHERE t.id = ${taskId}::uuid ${regions === null ? Prisma.empty : Prisma.sql`AND t.region_id = ANY(${regions}::int[])`}`);
    const r = rows[0];
    if (!r) throw problems.notFound('The task does not exist or is not visible to you.');
    return r;
  }

  /**
   * Builds and refreshes the slot set of a task: the database adds the slots of unconditional documents when the task opens (trigger) and here the API
   * judges the conditional ones with the rule language (a rule it cannot judge changes nothing).
   */
  async syncSlots(task: TaskCtx): Promise<void> {
    if (task.state !== 'open' && task.state !== 'entry') return;
    const defs = await this.db.tx.$queryRaw<{ id: string; condition_rule: unknown }[]>(Prisma.sql`
      SELECT dt.id::text AS id, dt.condition_rule FROM document_types dt
      WHERE dt.lib_managed AND dt.is_active AND dt.published_version > 0 AND dt.condition_rule IS NOT NULL
        AND EXISTS (SELECT 1 FROM document_type_placements pl JOIN task_definitions pd ON pd.id = pl.task_def_id WHERE pl.doc_type_id = dt.id AND pl.kind = 'task' AND pd.code = ${task.task_code})`);
    const yes: string[] = [];
    const no: string[] = [];
    const ctx = { site: { ...task.site, scenario: task.site.delivery_scenario }, task: { values: task.values ?? {}, custom: task.custom ?? {} }, scenario: task.site.delivery_scenario };
    for (const d of defs) {
      const r = evalRule(d.condition_rule, ctx);
      if (r === true) yes.push(d.id);
      else if (r === false) no.push(d.id);
    }
    await this.db.tx.$queryRaw(Prisma.sql`SELECT doc_sync_task_slots(${task.id}::uuid, ${yes}::uuid[], ${no}::uuid[])`);
  }

  private async canUpload(auth: AuthContext, task: TaskCtx): Promise<boolean> {
    if (task.state !== 'open' && task.state !== 'entry') return false;
    if (!(await this.access.hasGrant(auth, 'sites', 'edit'))) return false;
    const regions = await this.access.regions('sites', 'edit');
    if (regions !== null && !regions.includes(task.region_id)) return false;
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      SELECT (wf_is_eligible(${task.id}::uuid, 'entry', ${auth.user.id}::uuid) OR (app_actor_is_system_admin() AND NOT wf_has_holder(${task.id}::uuid, 'entry'))) AS ok`);
    return r[0]?.ok === true;
  }

  // ----------------------------------------------------------------------------------------------------------------- slots

  async slotsOf(auth: AuthContext, taskId: string): Promise<DocumentSlotDto[]> {
    const task = await this.taskCtx(taskId);
    return this.buildSlots(auth, task);
  }

  /** Same as slotsOf for a task row the caller has already been allowed to see. */
  async slotsForVisibleTask(auth: AuthContext, taskId: string): Promise<DocumentSlotDto[]> {
    const rows = await this.db.tx.$queryRaw<{ id: string; site_id: string; region_id: number; state: string; task_code: string; site_code: string; values: unknown; custom: unknown; site: Record<string, unknown> }[]>(Prisma.sql`
      SELECT t.id::text AS id, t.site_id::text AS site_id, t.region_id, t.state::text AS state, td.code AS task_code, s.site_code, t."values" AS "values", t.custom AS custom, to_jsonb(s) AS site
      FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id JOIN sites s ON s.id = t.site_id WHERE t.id = ${taskId}::uuid`);
    const r = rows[0];
    return r ? this.buildSlots(auth, r) : [];
  }

  /** Judges the conditional documents of a task before it is submitted (the engine reads the slots). A task the caller cannot see is ignored. */
  async syncTaskById(taskId: string): Promise<void> {
    const rows = await this.db.tx.$queryRaw<TaskCtx[]>(Prisma.sql`
      SELECT t.id::text AS id, t.site_id::text AS site_id, t.region_id, t.state::text AS state, td.code AS task_code, s.site_code, t."values" AS "values", t.custom AS custom, to_jsonb(s) AS site
      FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id JOIN sites s ON s.id = t.site_id WHERE t.id = ${taskId}::uuid`);
    if (rows[0]) await this.syncSlots(rows[0]);
  }

  private async buildSlots(auth: AuthContext, task: TaskCtx): Promise<DocumentSlotDto[]> {
    await this.syncSlots(task);
    const slots = await this.db.tx.$queryRaw<SlotRow[]>(Prisma.sql`
      SELECT ds.id::text AS id, ds.doc_type_id::text AS doc_type_id, dt.code AS doc_code, dt.name_en, dt.name_ar, dt.kind::text AS kind, dt.form_kind, ds.status::text AS status, ds.reject_reason,
        ds.candidate_label, ds.conditional_declared, dt.condition_rule, v.spec, dt.is_mandatory AS dt_mandatory, dt.formats AS dt_formats, dt.max_size_mb AS dt_max_size_mb,
        dt.min_files AS dt_min_files, dt.max_files AS dt_max_files, dt.photo_rules AS dt_photo_rules, dt.has_expiry AS dt_has_expiry,
        dt.blank_form_file_id::text AS blank_form_file_id, ds.valid_to::text AS valid_to
      FROM document_slots ds JOIN document_types dt ON dt.id = ds.doc_type_id LEFT JOIN document_type_versions v ON v.id = ds.doc_type_version_id
      WHERE ds.task_id = ${task.id}::uuid ORDER BY dt.code, ds.candidate_label NULLS FIRST, ds.id`);
    if (slots.length === 0) return [];
    const files = await this.fileRows(slots.map((s) => s.id));
    const refs = await this.view.userRefs([...new Set(files.map((f) => f.uploaded_by))]);
    const can = await this.canUpload(auth, task);
    return slots.map((s) => {
      const spec = s.spec ?? {};
      const photo = (spec.photo_rules ?? s.dt_photo_rules) as { camera_only?: unknown } | null;
      const slotFiles = files.filter((f) => f.slot_id === s.id);
      return {
        id: s.id,
        doc_type_id: s.doc_type_id,
        doc_code: s.doc_code,
        name_en: s.name_en,
        name_ar: s.name_ar,
        kind: s.form_kind ? 'generated_form' : s.kind,
        form_kind: s.form_kind,
        mandatory: typeof spec.mandatory === 'boolean' ? spec.mandatory : s.dt_mandatory,
        conditional: s.condition_rule !== null && s.condition_rule !== undefined,
        status: s.status,
        reject_reason: s.reject_reason,
        candidate_label: s.candidate_label,
        formats: strArr(spec.formats) ?? s.dt_formats,
        max_size_mb: num(spec.max_size_mb) ?? s.dt_max_size_mb,
        min_files: num(spec.min_files) ?? s.dt_min_files,
        max_files: spec.max_files === undefined ? s.dt_max_files : (spec.max_files as number | null),
        camera_only: typeof photo === 'object' && photo !== null && photo.camera_only === true,
        expiry_tracked: typeof spec.expiry_tracked === 'boolean' ? spec.expiry_tracked : s.dt_has_expiry,
        can_upload: can && ['missing', 'uploaded', 'rejected'].includes(s.status),
        blank_form_file_id: s.blank_form_file_id,
        valid_to: s.valid_to,
        files: slotFiles.map((f) => this.fileDto(f, refs, { site_code: task.site_code, task_code: task.task_code, doc_code: s.doc_code, candidate_label: s.candidate_label, ordinal: f.ord })),
      };
    });
  }

  private async fileRows(slotIds: string[]): Promise<FileRow[]> {
    return this.db.tx.$queryRaw<FileRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT f.id::text AS id, f.slot_id::text AS slot_id, f.file_group_id::text AS file_group_id, f.version, f.is_current, f.original_name, f.stored_name, f.ext, f.mime_type,
          f.size_bytes, f.sha256, f.uploaded_by::text AS uploaded_by, f.uploaded_at, f.approved_date::text AS approved_date, f.capture_date, f.unknown_capture_date,
          f.superseded_by::text AS superseded_by, f.withdrawn_at,
          ${ORD} AS ord
        FROM document_files f WHERE f.slot_id = ANY(${slotIds}::uuid[])) x ORDER BY x.uploaded_at, x.id`);
  }

  private fileDto(f: FileRow, refs: Map<string, UserRefDto>, n: Omit<NameParts, 'approved_date' | 'uploaded_at' | 'ext' | 'version' | 'is_current'>): DocumentFileDto {
    const u = refs.get(f.uploaded_by);
    const dto: DocumentFileDto = {
      id: f.id,
      file_group_id: f.file_group_id,
      version: f.version,
      is_current: f.is_current,
      original_name: f.original_name,
      download_name: displayName({ ...n, approved_date: f.approved_date, uploaded_at: f.uploaded_at, ext: f.ext ?? 'bin', version: f.version, is_current: f.is_current }),
      mime_type: f.mime_type,
      size_bytes: Number(f.size_bytes),
      sha256: f.sha256,
      uploaded_at: f.uploaded_at,
      approved_date: f.approved_date,
      capture_date: f.capture_date,
      unknown_capture_date: f.unknown_capture_date,
      superseded_by: f.superseded_by,
    };
    if (u) dto.uploaded_by = u;
    return dto;
  }

  private async slotOf(auth: AuthContext, taskId: string, slotId: string): Promise<{ task: TaskCtx; slot: DocumentSlotDto }> {
    const task = await this.taskCtx(taskId);
    if (!uuidSchema.safeParse(slotId).success) throw problems.notFound();
    const slot = (await this.buildSlots(auth, task)).find((s) => s.id === slotId);
    if (!slot) throw problems.notFound('The slot does not exist on this task.');
    return { task, slot };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT doc_call`;
    try {
      const r = await fn();
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT doc_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT doc_call`;
      throw p;
    }
  }

  // ----------------------------------------------------------------------------------------------------------------- add, withdraw, suggest

  async addSlot(auth: AuthContext, taskId: string, raw: unknown): Promise<DocumentSlotDto> {
    const task = await this.taskCtx(taskId);
    const b = parse(addSlotBody, raw);
    const sid = await this.call(async () => {
      const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT doc_add_slot(${task.id}::uuid, ${b.doc_code}::text, ${b.candidate_label ?? null}::text)::text AS id`);
      return (r[0] as { id: string }).id;
    });
    const slot = (await this.buildSlots(auth, task)).find((s) => s.id === sid);
    if (!slot) throw problems.notFound();
    return slot;
  }

  async withdraw(auth: AuthContext, taskId: string, slotId: string, fileId: string): Promise<DocumentSlotDto> {
    const { task } = await this.slotOf(auth, taskId, slotId);
    if (!uuidSchema.safeParse(fileId).success) throw problems.notFound();
    await this.call(() => this.db.tx.$queryRaw(Prisma.sql`SELECT doc_withdraw_file(${slotId}::uuid, ${fileId}::uuid)`));
    const slot = (await this.buildSlots(auth, task)).find((s) => s.id === slotId);
    if (!slot) throw problems.notFound();
    return slot;
  }

  async suggest(auth: AuthContext, taskId: string, raw: unknown): Promise<{ items: { file_name: string; suggestions: { slot_id: string; doc_code: string; score: number }[] }[] }> {
    const task = await this.taskCtx(taskId);
    const b = parse(suggestBody, raw);
    const slots = (await this.buildSlots(auth, task)).filter((s) => s.status !== 'not_required');
    return { items: b.file_names.map((file_name) => ({ file_name, suggestions: suggestSlots(file_name, slots.map((s) => ({ slot_id: s.id, doc_code: s.doc_code, name_en: s.name_en, name_ar: s.name_ar, candidate_label: s.candidate_label }))) })) };
  }

  // ----------------------------------------------------------------------------------------------------------------- upload

  async upload(
    auth: AuthContext, taskId: string, slotId: string, file: { buffer: Buffer; originalname: string } | undefined, body: Record<string, unknown> | undefined,
  ): Promise<DocumentFileDto> {
    const { task, slot } = await this.slotOf(auth, taskId, slotId);
    if (!file) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the file as the multipart field "file".' }]);
    const replaces = typeof body?.replaces_file_group_id === 'string' && body.replaces_file_group_id !== '' ? body.replaces_file_group_id : null;
    if (replaces !== null && !uuidSchema.safeParse(replaces).success) throw problems.validation([{ path: '/replaces_file_group_id', code: 'invalid', message: 'Not a uuid.' }]);
    // who and when, before any byte is stored
    if (!slot.can_upload) {
      if (task.state !== 'open' && task.state !== 'entry') throw new ProblemException(409, 'invalid_transition', { detail: `Documents can be uploaded only while the task is pending or ongoing (it is ${task.state}).` });
      if (['approved', 'in_review', 'not_required'].includes(slot.status)) throw new ProblemException(409, 'invalid_transition', { detail: `This slot is ${slot.status} and takes no new file.` });
      throw new ProblemException(403, 'not_eligible_holder', { detail: 'You are not a holder of the level the task is at.' });
    }
    const limit = slot.max_size_mb * 1024 * 1024;
    if (file.buffer.length > limit) {
      throw new ProblemException(413, 'file_too_large', { detail: `The file is larger than the ${slot.max_size_mb} MB this document allows.`, extra: { max_size_mb: slot.max_size_mb } });
    }
    const sn = sniff(file.buffer, file.originalname);
    if (!sn.ok) throw new ProblemException(422, 'file_rejected', { detail: sn.detail, extra: { reason: sn.reason }, errors: [{ path: '/file', code: sn.reason, message: sn.detail }] });
    if (!formatAllowed(sn, slot.formats)) {
      const msg = `A ${sn.ext} file is not allowed here: use ${slot.formats.join(', ')}.`;
      throw new ProblemException(422, 'file_rejected', { detail: msg, extra: { reason: 'format_not_allowed', allowed: slot.formats }, errors: [{ path: '/file', code: 'format_not_allowed', message: msg }] });
    }
    if (slot.kind === 'photo') {
      const pr = await this.photoRules(slotId);
      if (pr.formats && !pr.formats.includes(sn.ext.toUpperCase().replace('JPEG', 'JPG'))) {
        const msg = `Photos must be ${pr.formats.join(', ')}.`;
        throw new ProblemException(422, 'file_rejected', { detail: msg, extra: { reason: 'format_not_allowed', allowed: pr.formats }, errors: [{ path: '/file', code: 'format_not_allowed', message: msg }] });
      }
      if (pr.maxMb && file.buffer.length > pr.maxMb * 1024 * 1024) {
        throw new ProblemException(413, 'file_too_large', { detail: `A photo may be ${pr.maxMb} MB at most.`, extra: { max_size_mb: pr.maxMb } });
      }
    }
    const current = slot.files.filter((f) => f.is_current).length;
    if (replaces === null && slot.max_files !== null && current >= slot.max_files) {
      const msg = `The slot holds ${slot.max_files} file(s) at most: replace one.`;
      throw new ProblemException(422, 'file_rejected', { detail: msg, extra: { reason: 'too_many_files' }, errors: [{ path: '/file', code: 'too_many_files', message: msg }] });
    }
    const capture = sn.image && ['jpg', 'tiff', 'heic'].includes(sn.ext) ? readExifDate(file.buffer) : null;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const key = newObjectKey('docs');
    const nextOrdinal = replaces ? (slot.files.find((f) => f.file_group_id === replaces)?.version ?? 1) : new Set(slot.files.map((f) => f.file_group_id)).size + 1;
    void nextOrdinal;
    const storedName = displayName({ site_code: task.site_code, task_code: task.task_code, doc_code: slot.doc_code, candidate_label: slot.candidate_label, approved_date: null, uploaded_at: new Date(), ext: sn.ext, version: 1, is_current: true });
    await this.storage.store.put(key, file.buffer);
    let fileId: string;
    try {
      const meta = {
        storage_key: key, original_name: cleanOriginalName(file.originalname) || 'file', stored_name: storedName, mime_type: sn.mime, ext: sn.ext,
        size_bytes: file.buffer.length, sha256, replaces_file_group_id: replaces, capture_date: capture ? capture.toISOString() : null,
        unknown_capture_date: slot.kind === 'photo' && sn.image && capture === null,
      };
      fileId = await this.call(async () => {
        const r = await this.db.tx.$queryRaw<{ r: { file_id: string } }[]>(Prisma.sql`SELECT doc_attach_file(${slotId}::uuid, ${JSON.stringify(meta)}::jsonb) AS r`);
        return (r[0] as { r: { file_id: string } }).r.file_id;
      });
    } catch (e) {
      await this.storage.store.remove(key).catch(() => undefined);
      throw e;
    }
    const after = (await this.buildSlots(auth, task)).find((s) => s.id === slotId);
    const dto = after?.files.find((f) => f.id === fileId);
    if (!dto) throw problems.notFound();
    return dto;
  }

  private async photoRules(slotId: string): Promise<{ formats: string[] | null; maxMb: number | null }> {
    const r = await this.db.tx.$queryRaw<{ pr: { formats?: string[]; max_size_mb?: number } | null }[]>(Prisma.sql`SELECT doc_slot_spec(${slotId}::uuid) -> 'photo_rules' AS pr`);
    const pr = r[0]?.pr;
    return { formats: pr && Array.isArray(pr.formats) && pr.formats.length > 0 ? pr.formats.map((x) => x.toUpperCase()) : null, maxMb: pr && typeof pr.max_size_mb === 'number' ? pr.max_size_mb : null };
  }

  // ----------------------------------------------------------------------------------------------------------------- download

  /** Download scope: `download_documents` on the Documents screen, by region. null = every region. */
  async downloadRegions(): Promise<number[] | null> {
    return this.access.requireRegions(SITE_DOCS, 'download_documents');
  }

  async download(auth: AuthContext, fileId: string): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    const regions = await this.downloadRegions();
    if (!uuidSchema.safeParse(fileId).success) throw problems.notFound();
    const rows = await this.db.tx.$queryRaw<(FileRow & { site_id: string; region_id: number; site_code: string; task_code: string | null; doc_code: string; candidate_label: string | null; slot_status: string })[]>(Prisma.sql`
      SELECT f.id::text AS id, f.slot_id::text AS slot_id, f.file_group_id::text AS file_group_id, f.version, f.is_current, f.original_name, f.stored_name, f.ext, f.mime_type, f.size_bytes, f.sha256,
        f.uploaded_by::text AS uploaded_by, f.uploaded_at, f.approved_date::text AS approved_date, f.capture_date, f.unknown_capture_date, f.superseded_by::text AS superseded_by, f.withdrawn_at, f.storage_key,
        s.site_id::text AS site_id, s.region_id, si.site_code, td.code AS task_code, dt.code AS doc_code, s.candidate_label, s.status::text AS slot_status,
        ${ORD} AS ord
      FROM document_files f JOIN document_slots s ON s.id = f.slot_id JOIN sites si ON si.id = s.site_id JOIN document_types dt ON dt.id = s.doc_type_id
      LEFT JOIN task_instances ti ON ti.id = s.task_id LEFT JOIN task_definitions td ON td.id = ti.task_def_id
      WHERE f.id = ${fileId}::uuid`);
    const f = rows[0] as (typeof rows)[number] & { storage_key?: string } | undefined;
    if (!f || (regions !== null && !regions.includes(f.region_id))) return this.downloadBlank(fileId, regions);
    const name = displayName({ site_code: f.site_code, task_code: f.task_code, doc_code: f.doc_code, candidate_label: f.candidate_label, approved_date: f.approved_date, uploaded_at: f.uploaded_at, ext: f.ext ?? 'bin', version: f.version, is_current: f.is_current, ordinal: f.ord });
    // The audit row first, in the request transaction that commits before the response body is sent.
    await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_audit('document_file_download', 'document_file', ${f.id}::text, ${f.site_id}::uuid, ${f.region_id}::int,
      ${JSON.stringify({ file_id: f.id, download_name: name, original_name: f.original_name, version: f.version, is_current: f.is_current, size_bytes: Number(f.size_bytes), sha256: f.sha256, slot_status: f.slot_status })}::jsonb)`);
    void auth;
    const stream = await this.storage.store.get(f.storage_key as string);
    return {
      file: new StreamableFile(stream, { type: f.mime_type, disposition: attachmentHeader(name), length: Number(f.size_bytes) }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }

  private async downloadBlank(id: string, regions: number[] | null): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    void regions;
    const rows = await this.db.tx.$queryRaw<{ id: string; doc_type_id: string; code: string; original_name: string; storage_key: string; mime_type: string; ext: string; size_bytes: bigint; sha256: string }[]>(Prisma.sql`
      SELECT b.id::text AS id, b.doc_type_id::text AS doc_type_id, dt.code, b.original_name, b.storage_key, b.mime_type, b.ext, b.size_bytes, b.sha256
      FROM document_blank_forms b JOIN document_types dt ON dt.id = b.doc_type_id WHERE b.id = ${id}::uuid`);
    const b = rows[0];
    if (!b) throw problems.notFound('The file does not exist or is not visible to you.');
    const name = `${b.code.replace(/[^A-Za-z0-9-]/g, '-')}_BLANK-FORM.${b.ext}`;
    await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_audit('document_blank_form_download', 'document_type', ${b.doc_type_id}::text, NULL, NULL,
      ${JSON.stringify({ blank_form_id: b.id, download_name: name, sha256: b.sha256 })}::jsonb)`);
    return {
      file: new StreamableFile(await this.storage.store.get(b.storage_key), { type: b.mime_type, disposition: attachmentHeader(name), length: Number(b.size_bytes) }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }

  /** The blank form file id of a document type (null when it has none). */
  async blankFormId(docTypeId: string): Promise<string> {
    if (!uuidSchema.safeParse(docTypeId).success) throw problems.notFound();
    const r = await this.db.tx.$queryRaw<{ id: string | null }[]>(Prisma.sql`SELECT blank_form_file_id::text AS id FROM document_types WHERE id = ${docTypeId}::uuid`);
    const id = r[0]?.id;
    if (!id) throw problems.notFound('The document has no blank form.');
    return id;
  }

  // ----------------------------------------------------------------------------------------------------------------- list

  /** Filter conditions shared by the list and the zip export. */
  filterSql(q: Query, regions: number[] | null): Prisma.Sql[] {
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (regions !== null) conds.push(Prisma.sql`s.region_id = ANY(${regions}::int[])`);
    const site = oneParam(q, 'site_id');
    if (site !== undefined) {
      if (!uuidSchema.safeParse(site).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'Not a uuid.' }]);
      conds.push(Prisma.sql`s.site_id = ${site}::uuid`);
    }
    const arr = (key: string): string[] => {
      const v = q[key];
      if (v === undefined) return [];
      return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x !== '');
    };
    const regionIds = arr('region_id').map((x) => (/^[0-9]{1,2}$/.test(x) ? Number(x) : NaN));
    if (regionIds.some(Number.isNaN)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is an integer.' }]);
    if (regionIds.length > 0) conds.push(Prisma.sql`s.region_id = ANY(${regionIds}::int[])`);
    const stage = oneParam(q, 'stage_code');
    if (stage !== undefined) conds.push(Prisma.sql`st.code = ${stage}`);
    const task = oneParam(q, 'task_code');
    if (task !== undefined) conds.push(Prisma.sql`td.code = ${task}`);
    const docs = arr('doc_code');
    if (docs.length > 0) conds.push(Prisma.sql`dt.code = ANY(${docs}::text[])`);
    const kind = oneParam(q, 'kind');
    if (kind !== undefined) {
      if (kind === 'generated_form') conds.push(Prisma.sql`dt.form_kind IS NOT NULL`);
      else if (['scanned_document', 'photo', 'email', 'report', 'excel_template'].includes(kind)) conds.push(Prisma.sql`dt.kind::text = ${kind} AND dt.form_kind IS NULL`);
      else throw problems.validation([{ path: '/kind', code: 'invalid', message: 'Unknown kind.' }]);
    }
    const status = oneParam(q, 'slot_status');
    if (status !== undefined) {
      if (!['uploaded', 'in_review', 'approved', 'rejected', 'missing'].includes(status)) throw problems.validation([{ path: '/slot_status', code: 'invalid', message: 'Unknown status.' }]);
      conds.push(Prisma.sql`s.status::text = ${status}`);
    }
    const by = oneParam(q, 'uploaded_by');
    if (by !== undefined) {
      if (!uuidSchema.safeParse(by).success) throw problems.validation([{ path: '/uploaded_by', code: 'invalid', message: 'Not a uuid.' }]);
      conds.push(Prisma.sql`f.uploaded_by = ${by}::uuid`);
    }
    for (const [key, op] of [['uploaded_from', '>='], ['uploaded_to', '<']] as const) {
      const v = oneParam(q, key);
      if (v === undefined) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is a date (YYYY-MM-DD).` }]);
      conds.push(op === '>=' ? Prisma.sql`f.uploaded_at >= ${v}::date` : Prisma.sql`f.uploaded_at < (${v}::date + 1)`);
    }
    const text = oneParam(q, 'q');
    if (text) conds.push(Prisma.sql`(si.site_code ILIKE ${likePattern(text)} OR dt.name_en ILIKE ${likePattern(text)} OR dt.code ILIKE ${likePattern(text)} OR f.original_name ILIKE ${likePattern(text)})`);
    const group = oneParam(q, 'file_group_id');
    if (group !== undefined) {
      if (!uuidSchema.safeParse(group).success) throw problems.validation([{ path: '/file_group_id', code: 'invalid', message: 'Not a uuid.' }]);
      conds.push(Prisma.sql`f.file_group_id = ${group}::uuid`);
    } else if (!boolParam(q, 'include_superseded')) {
      conds.push(Prisma.sql`f.is_current`);
    }
    return conds;
  }

  static readonly LIST_FROM = Prisma.sql`
    FROM document_files f JOIN document_slots s ON s.id = f.slot_id JOIN sites si ON si.id = s.site_id JOIN document_types dt ON dt.id = s.doc_type_id
    LEFT JOIN task_instances ti ON ti.id = s.task_id LEFT JOIN task_definitions td ON td.id = ti.task_def_id LEFT JOIN stage_definitions st ON st.id = td.stage_id`;

  async list(auth: AuthContext, q: Query) {
    const regions = await this.access.requireRegions(SITE_DOCS, 'view');
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(typeof q.cursor === 'string' ? q.cursor : undefined, 2);
    const conds = this.filterSql(q, regions);
    if (cur) conds.push(Prisma.sql`(f.uploaded_at, f.id) < (${cur[0]}::timestamptz, ${cur[1]}::uuid)`);
    const rows = await this.db.tx.$queryRaw<(FileRow & {
      site_id: string; region_id: number; site_code: string; site_name: string | null; task_id: string | null; task_code: string | null; task_name: string | null; stage_code: string | null;
      stage_name: string | null; doc_code: string; doc_name_en: string; doc_name_ar: string | null; kind: string; form_kind: string | null; candidate_label: string | null; slot_status: string; cur_text: string;
    })[]>(Prisma.sql`
      SELECT f.id::text AS id, f.slot_id::text AS slot_id, f.file_group_id::text AS file_group_id, f.version, f.is_current, f.original_name, f.stored_name, f.ext, f.mime_type, f.size_bytes, f.sha256,
        f.uploaded_by::text AS uploaded_by, f.uploaded_at, to_char(f.uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cur_text, f.approved_date::text AS approved_date, f.capture_date,
        f.unknown_capture_date, f.superseded_by::text AS superseded_by, f.withdrawn_at,
        s.site_id::text AS site_id, s.region_id, si.site_code, si.name AS site_name, ti.id::text AS task_id, td.code AS task_code, td.name_en AS task_name, st.code AS stage_code, st.name_en AS stage_name,
        dt.code AS doc_code, dt.name_en AS doc_name_en, dt.name_ar AS doc_name_ar, dt.kind::text AS kind, dt.form_kind, s.candidate_label, s.status::text AS slot_status,
        ${ORD} AS ord
      ${DocumentsService.LIST_FROM}
      WHERE ${Prisma.join(conds, ' AND ')} ORDER BY f.uploaded_at DESC, f.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const refs = await this.view.userRefs([...new Set(page.map((r) => r.uploaded_by))]);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        file: this.fileDto(r, refs, { site_code: r.site_code, task_code: r.task_code, doc_code: r.doc_code, candidate_label: r.candidate_label, ordinal: r.ord }),
        slot_id: r.slot_id,
        slot_status: r.slot_status,
        candidate_label: r.candidate_label,
        doc_code: r.doc_code,
        doc_name_en: r.doc_name_en,
        doc_name_ar: r.doc_name_ar,
        kind: r.form_kind ? 'generated_form' : r.kind,
        task_id: r.task_id,
        task_code: r.task_code,
        task_name: r.task_name,
        stage_code: r.stage_code,
        stage_name: r.stage_name,
        site_id: r.site_id,
        site_code: r.site_code,
        site_name: r.site_name,
        region_id: r.region_id,
      })),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.cur_text, last.id]) : null },
    };
  }
}
