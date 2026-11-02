import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { StepUpService } from '../auth/step-up.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { boolParam, oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskViewService } from '../workflow/task-view.service';
import { createHash } from 'node:crypto';
import { cleanOriginalName } from './naming';
import { sniff } from './sniff';
import { StorageService, newObjectKey } from './storage.service';

const reason = z.string().trim().min(3).max(1000);
const placement = z.object({ target: z.enum(['task', 'qc', 'register']), ref: z.string().trim().min(1).max(60), record_type: z.string().trim().min(1).max(40).nullable().optional() }).strict();
const KINDS = ['scanned_document', 'photo', 'email', 'report', 'excel_template', 'generated_form'] as const;
const photoRules = z
  .object({
    min_count: z.number().int().min(0).max(100).optional(),
    shot_types: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    formats: z.array(z.enum(['JPG', 'PNG', 'HEIC'])).max(3).optional(),
    max_size_mb: z.number().int().min(1).max(200).optional(),
    camera_only: z.boolean().optional(),
  })
  .strict();
const f = {
  kind: z.enum(KINDS),
  form_kind: z.enum(['dn', 'rn', 'pac', 'fac', 'snag_list']).nullable(),
  name_en: z.string().trim().min(2).max(200),
  name_ar: z.string().trim().min(1).max(200).nullable(),
  placements: z.array(placement).min(1).max(100),
  mandatory: z.boolean(),
  condition_rule: z.record(z.unknown()).nullable(),
  formats: z.array(z.string().regex(/^[a-z0-9]{2,5}$/)).min(1).max(20),
  max_size_mb: z.number().int().min(1).max(200),
  min_files: z.number().int().min(0).max(100),
  max_files: z.number().int().min(1).max(1000).nullable(),
  photo_rules: photoRules.nullable(),
  expiry_tracked: z.boolean(),
  is_active: z.boolean(),
};
const createBody = z
  .object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,30}$/), ...f, reason })
  .partial({ form_kind: true, name_ar: true, mandatory: true, condition_rule: true, formats: true, max_size_mb: true, min_files: true, max_files: true, photo_rules: true, expiry_tracked: true, is_active: true })
  .strict();
const patchBody = z
  .object({ ...f, reason })
  .partial({ kind: true, form_kind: true, name_en: true, name_ar: true, placements: true, mandatory: true, condition_rule: true, formats: true, max_size_mb: true, min_files: true, max_files: true, photo_rules: true, expiry_tracked: true, is_active: true })
  .strict()
  .refine((b) => Object.keys(b).length >= 2, { message: 'Change at least one field.', path: [] });
const publishBody = z
  .object({ reason, effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), apply_to: z.enum(['new_only', 'open_too']) })
  .strict();

interface Row {
  id: string;
  code: string;
  version: number;
  published_version: number;
  needs_review: boolean;
  updated_at: Date;
  has_draft: boolean;
  spec: Record<string, unknown>;
  updated_by: string | null;
}

const SELECT = Prisma.sql`
  SELECT dt.id::text AS id, dt.code, dt.version, dt.published_version, dt.needs_review, dt.updated_at, (d.doc_type_id IS NOT NULL) AS has_draft,
    coalesce(d.spec, doc_live_spec(dt.id)) AS spec, d.updated_by::text AS updated_by
  FROM document_types dt LEFT JOIN document_type_drafts d ON d.doc_type_id = dt.id`;

/**
 * The Document Library (CLAUDE.md "Document Library (admin)"): every document is data. Edits save a draft; "publish" makes the draft live, writes an immutable
 * version and chooses whether open tasks follow. Written by the System Admin or a delegate of documents.edit (the database checks it again), with a reason.
 */
@Injectable()
export class LibraryService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly view: TaskViewService,
    private readonly storage: StorageService,
  ) {}

  private async requireRead(auth: AuthContext): Promise<void> {
    if (await this.access.isAdmin('document_types', 'edit')) return;
    await this.access.requireAnyModuleView(auth, ['admin.settings', 'document_types']);
  }

  private dto(r: Row, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const s = r.spec;
    return {
      id: r.id,
      code: r.code,
      version: r.version,
      published_version: r.published_version,
      has_unpublished_changes: r.has_draft,
      needs_review: r.needs_review,
      updated_at: r.updated_at,
      kind: s.kind,
      form_kind: s.form_kind ?? null,
      name_en: s.name_en,
      name_ar: s.name_ar ?? null,
      placements: s.placements ?? [],
      mandatory: s.mandatory,
      condition_rule: s.condition_rule ?? null,
      formats: s.formats,
      max_size_mb: s.max_size_mb,
      min_files: s.min_files,
      max_files: s.max_files ?? null,
      photo_rules: s.photo_rules ?? null,
      expiry_tracked: s.expiry_tracked,
      blank_form_file_id: s.blank_form_file_id ?? null,
      is_active: s.is_active,
      ...extra,
    };
  }

  async list(auth: AuthContext, q: Query) {
    await this.requireRead(auth);
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(typeof q.cursor === 'string' ? q.cursor : undefined, 1);
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    const ref = oneParam(q, 'placement_ref');
    if (ref !== undefined) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(d.spec, doc_live_spec(dt.id)) -> 'placements') p WHERE p ->> 'ref' = ${ref})`);
    const kind = oneParam(q, 'kind');
    if (kind !== undefined) {
      if (!(KINDS as readonly string[]).includes(kind)) throw problems.validation([{ path: '/kind', code: 'invalid', message: 'Unknown kind.' }]);
      conds.push(Prisma.sql`coalesce(d.spec, doc_live_spec(dt.id)) ->> 'kind' = ${kind}`);
    }
    if (!boolParam(q, 'include_inactive')) conds.push(Prisma.sql`(coalesce(d.spec, doc_live_spec(dt.id)) ->> 'is_active')::boolean`);
    if (cur) conds.push(Prisma.sql`dt.code > ${cur[0]}`);
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE ${Prisma.join(conds, ' AND ')} ORDER BY dt.code LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => this.dto(r)), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.code]) : null } };
  }

  async get(auth: AuthContext, rawId: string): Promise<{ body: Record<string, unknown>; version: number }> {
    await this.requireRead(auth);
    return this.read(rawId, true);
  }

  private async read(rawId: string, withCount = false): Promise<{ body: Record<string, unknown>; version: number }> {
    if (!uuidSchema.safeParse(rawId).success) throw problems.notFound('The document does not exist.');
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE dt.id = ${rawId}::uuid`);
    const r = rows[0];
    if (!r) throw problems.notFound('The document does not exist.');
    let extra: Record<string, unknown> = {};
    if (withCount) {
      const c = await this.db.tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT doc_open_task_count(${rawId}::uuid) AS n`);
      extra = { open_task_count: Number(c[0]?.n ?? 0) };
    }
    return { body: this.dto(r, extra), version: r.version };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT lib_call`;
    try {
      const r = await fn();
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT lib_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT lib_call`;
      throw p;
    }
  }

  private async save(id: string | null, patch: Record<string, unknown>, why: string, version: number | null): Promise<string> {
    const r = await this.call(() =>
      this.db.tx.$queryRaw<{ r: { id: string } }[]>(Prisma.sql`SELECT admin_save_document_type(${id}::uuid, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${version}::int) AS r`),
    );
    return (r[0] as { r: { id: string } }).r.id;
  }

  async create(auth: AuthContext, raw: unknown) {
    await this.access.requireAdmin('document_types', 'edit');
    const { reason: why, ...b } = parse(createBody, raw);
    const id = await this.save(null, b, why, null);
    return this.get(auth, id);
  }

  async update(auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown) {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin('document_types', 'edit');
    const { reason: why, ...b } = parse(patchBody, raw);
    await this.read(rawId);
    await this.save(rawId, b, why, version);
    return this.get(auth, rawId);
  }

  async publish(auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown) {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin('document_types', 'edit');
    await this.stepUp.require(auth);
    const b = parse(publishBody, raw);
    await this.read(rawId);
    const r = await this.call(() =>
      this.db.tx.$queryRaw<{ r: { published_version: number; affected_open_tasks: number } }[]>(
        Prisma.sql`SELECT admin_publish_document_type(${rawId}::uuid, ${version}::int, ${b.apply_to === 'open_too' ? 'open_too' : 'new_only'}::text, ${b.effective_from}::date, ${b.reason}::text) AS r`,
      ),
    );
    const res = (r[0] as { r: { published_version: number; affected_open_tasks: number } }).r;
    return { published_version: res.published_version, affected_open_tasks: res.affected_open_tasks };
  }

  async versions(auth: AuthContext, rawId: string) {
    await this.requireRead(auth);
    await this.read(rawId);
    const rows = await this.db.tx.$queryRaw<
      { version_no: number; published_at: Date; published_by: string | null; effective_from: string; apply_to: string; reason: string; affected_open_tasks: number; spec: Record<string, unknown> }[]
    >(Prisma.sql`SELECT version_no, published_at, published_by::text AS published_by, effective_from::text AS effective_from, apply_to, reason, affected_open_tasks, spec
      FROM document_type_versions WHERE doc_type_id = ${rawId}::uuid ORDER BY version_no DESC`);
    const refs = await this.view.userRefs([...new Set(rows.map((r) => r.published_by).filter((x): x is string => x !== null))]);
    return {
      items: rows.map((r) => ({
        version_no: r.version_no,
        published_at: r.published_at,
        ...(r.published_by && refs.get(r.published_by) ? { published_by: refs.get(r.published_by) } : {}),
        effective_from: r.effective_from,
        apply_to: r.apply_to,
        reason: r.reason,
        affected_open_tasks: r.affected_open_tasks,
        spec: r.spec,
      })),
    };
  }

  /** The optional blank form to download: saved to the draft, live on the next publish. */
  async attachBlankForm(auth: AuthContext, rawId: string, ifMatch: string | undefined, file: { buffer: Buffer; originalname: string } | undefined, body: Record<string, unknown> | undefined) {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin('document_types', 'edit');
    await this.read(rawId);
    if (!file) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the file as the multipart field "file".' }]);
    const why = typeof body?.reason === 'string' && body.reason.trim().length >= 3 ? body.reason.trim() : 'blank form uploaded';
    if (file.buffer.length > 20 * 1024 * 1024) throw new ProblemException(413, 'file_too_large', { detail: 'A blank form may be 20 MB at most.' });
    const sn = sniff(file.buffer, file.originalname);
    if (!sn.ok) throw new ProblemException(422, 'file_rejected', { detail: sn.detail, extra: { reason: sn.reason }, errors: [{ path: '/file', code: sn.reason, message: sn.detail }] });
    if (!['pdf', 'jpg', 'png', 'docx', 'xlsx'].includes(sn.ext)) {
      throw new ProblemException(422, 'file_rejected', { detail: 'A blank form is a PDF, an image, a Word or an Excel file.', extra: { reason: 'format_not_allowed' }, errors: [{ path: '/file', code: 'format_not_allowed', message: 'Not allowed.' }] });
    }
    const key = newObjectKey('forms');
    await this.storage.store.put(key, file.buffer);
    try {
      const meta = { storage_key: key, original_name: cleanOriginalName(file.originalname) || 'form', mime_type: sn.mime, ext: sn.ext, size_bytes: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex') };
      await this.call(() => this.db.tx.$queryRaw(Prisma.sql`SELECT doc_blank_form_attach(${rawId}::uuid, ${version}::int, ${JSON.stringify(meta)}::jsonb, ${why}::text)`));
    } catch (e) {
      await this.storage.store.remove(key).catch(() => undefined);
      throw e;
    }
    return this.get(auth, rawId);
  }
}
