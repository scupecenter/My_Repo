import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { TS_TEXT, boolParam, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { readExifDate } from '../documents/exif';
import { sniff } from '../documents/sniff';
import { StorageService, newObjectKey } from '../documents/storage.service';
import { MatrixAssigneeDto, TaskViewService, accountStatus } from '../workflow/task-view.service';

/**
 * QC snags and the photos of their fix (owner answers Q131 / Q132, CLAUDE.md "Documents and QC"). The site engineer (L1 of the Quality register row of the
 * Responsibility Matrix) uploads fresh photos that follow the snag type's photo rules and submits; L2 approves, which closes the snag, or rejects with a note.
 * Every write is a SECURITY DEFINER function (qc_*); this service only checks the bytes and reads.
 */
export const QC_MODULE = 'quality';
/** EXIF has no time zone: a photo dated up to one day before the snag was raised is still accepted (owner answer Q132). Repeated by the database. */
export const EXIF_TOLERANCE_MS = 24 * 60 * 60 * 1000;

const STATE_OUT: Record<string, string> = { open: 'open', fix_uploaded: 'fix_submitted', in_review: 'in_review', closed: 'closed', cancelled: 'cancelled' };
const STATE_IN: Record<string, string> = { open: 'open', fix_submitted: 'fix_uploaded', in_review: 'in_review', closed: 'closed' };

const photoRules = z
  .object({
    min_count: z.number().int().min(0).max(50).optional(),
    shot_types: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    formats: z.array(z.enum(['JPG', 'PNG', 'HEIC'])).min(1).optional(),
    max_size_mb: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const typeFields = {
  name_en: z.string().trim().min(2).max(200).optional(),
  name_ar: z.string().trim().max(200).optional(),
  photo_rules: photoRules.optional(),
  blocks_preliminary_acceptance: z.boolean().optional(),
  is_active: z.boolean().optional(),
  reason: z.string().trim().min(3).max(2000),
};
const typeCreate = z.object({ ...typeFields, code: z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/), name_en: z.string().trim().min(2).max(200), photo_rules: photoRules }).strict();
const typePatch = z.object(typeFields).strict().refine((v) => Object.keys(v).length >= 2, 'send at least one field besides the reason');
const snagInput = z
  .object({
    snag_type_id: z.string().uuid(),
    task_id: z.string().uuid().optional(),
    scope: z.enum(['CW', 'TE']).optional(),
    title: z.string().trim().min(3).max(200),
    description: z.string().max(2000).optional(),
  })
  .strict();
const snagPatch = z.object({ title: z.string().trim().min(3).max(200).optional(), description: z.string().max(2000).optional() }).strict().refine((v) => Object.keys(v).length > 0, 'send at least one field');
const noteBody = z.object({ note: z.string().max(2000).optional() }).strict();
const rejectBody = z
  .object({
    note: z.string().trim().min(1).max(2000),
    rejected_photos: z.array(z.object({ photo_id: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict()).max(100).optional(),
  })
  .strict();

interface TypeRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  min_photos: number;
  required_shots: unknown;
  formats: string[] | null;
  max_size_mb: number;
  blocks_preliminary_acceptance: boolean;
  is_active: boolean;
  version: number;
}

interface SnagRow {
  id: string;
  site_id: string;
  site_code: string;
  region_id: number;
  task_id: string | null;
  snag_type_id: string;
  scope: string;
  title: string | null;
  description: string;
  status: string;
  raised_by: string;
  raised_at: Date;
  closed_at: Date | null;
  return_count: number;
  last_return_note: string | null;
  pinned: string | null;
  self_approval: boolean;
  version: number;
  ts: string;
}

interface PhotoRow {
  id: string;
  snag_id: string;
  shot_type: string | null;
  exif_date: Date | null;
  unknown_capture_date: boolean;
  captured_in_app: boolean;
  distance_m: string | null;
  geofence_result: string;
  uploaded_by: string;
  uploaded_at: Date;
  rejected_at: Date | null;
  review_note: string | null;
}

const SNAG_SELECT = Prisma.sql`
  SELECT s.id::text AS id, s.site_id::text AS site_id, si.site_code, s.region_id, s.task_id::text AS task_id, s.snag_type_id::text AS snag_type_id, s.scope, s.title,
    s.description, s.status::text AS status, s.raised_by::text AS raised_by, s.raised_at, s.closed_at, s.return_count, s.last_return_note,
    s.ball_in_court_user_id::text AS pinned, s.self_approval, s.version, ${Prisma.raw(TS_TEXT('s.raised_at'))} AS ts
  FROM snags s JOIN sites si ON si.id = s.site_id`;

@Injectable()
export class SnagsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly view: TaskViewService,
    private readonly storage: StorageService,
  ) {}

  private async call<T>(auth: AuthContext, sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT qc_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT qc_call`;
      return rows[0]?.r as T;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT qc_call`;
      if (p.code === 'step_up_required') {
        throw new ProblemException(401, 'step_up_required', { detail: 'Confirm your password to continue.', step_up_method: auth.session.authMethod === 'local' ? 'password' : 'm365' });
      }
      throw p;
    }
  }

  // ------------------------------------------------------------------ snag types
  private typeDto(t: TypeRow): Record<string, unknown> {
    const shots = Array.isArray(t.required_shots) ? (t.required_shots as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return {
      id: t.id,
      code: t.code,
      name_en: t.name_en,
      name_ar: t.name_ar,
      photo_rules: {
        min_count: t.min_photos,
        shot_types: shots,
        formats: (t.formats ?? ['jpg', 'png', 'heic']).map((f) => f.toUpperCase().replace('JPEG', 'JPG')),
        max_size_mb: t.max_size_mb,
      },
      blocks_preliminary_acceptance: t.blocks_preliminary_acceptance,
      is_active: t.is_active,
      version: t.version,
    };
  }

  private async typeRows(where: Prisma.Sql): Promise<TypeRow[]> {
    return this.db.tx.$queryRaw<TypeRow[]>(Prisma.sql`
      SELECT id::text AS id, code, name_en, name_ar, min_photos, required_shots, formats, max_size_mb, blocks_preliminary_acceptance, is_active, version
      FROM snag_types WHERE ${where} ORDER BY code COLLATE "C"`);
  }

  async listTypes(q: Record<string, unknown>): Promise<{ items: unknown[] }> {
    const all = boolParam(q, 'include_inactive');
    return { items: (await this.typeRows(all ? Prisma.sql`true` : Prisma.sql`is_active`)).map((t) => this.typeDto(t)) };
  }

  async getType(id: string): Promise<Record<string, unknown>> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const t = (await this.typeRows(Prisma.sql`id = ${id}::uuid`))[0];
    if (!t) throw problems.notFound('The snag type does not exist.');
    return this.typeDto(t);
  }

  private typePatchJson(b: { name_en?: string; name_ar?: string; photo_rules?: z.infer<typeof photoRules>; blocks_preliminary_acceptance?: boolean; is_active?: boolean; code?: string }): string {
    const out: Record<string, unknown> = {};
    for (const k of ['code', 'name_en', 'name_ar', 'photo_rules', 'blocks_preliminary_acceptance', 'is_active'] as const) if (b[k] !== undefined) out[k] = b[k];
    return JSON.stringify(out);
  }

  async createType(auth: AuthContext, raw: unknown): Promise<Record<string, unknown>> {
    const b = parse(typeCreate, raw);
    const r = await this.call<{ id: string }>(auth, Prisma.sql`SELECT admin_save_snag_type(NULL::uuid, ${this.typePatchJson(b)}::jsonb, ${b.reason}::text, NULL::int) AS r`);
    return this.getType(r.id);
  }

  async updateType(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const b = parse(typePatch, raw);
    await this.getType(id);
    await this.call(auth, Prisma.sql`SELECT admin_save_snag_type(${id}::uuid, ${this.typePatchJson(b)}::jsonb, ${b.reason}::text, ${version}::int) AS r`);
    return this.getType(id);
  }

  // ------------------------------------------------------------------ snags: reads
  private async snagRow(auth: AuthContext, id: string): Promise<SnagRow> {
    void auth;
    const regions = await this.access.requireRegions(QC_MODULE, 'view');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const rows = await this.db.tx.$queryRaw<SnagRow[]>(Prisma.sql`${SNAG_SELECT} WHERE s.id = ${id}::uuid ${regions === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regions}::int[])`}`);
    const r = rows[0];
    if (!r) throw problems.notFound('The snag does not exist or is not visible to you.');
    return r;
  }

  async get(auth: AuthContext, id: string): Promise<Record<string, unknown>> {
    const [dto] = await this.dtos(auth, [await this.snagRow(auth, id)]);
    return dto as Record<string, unknown>;
  }

  async listSite(auth: AuthContext, siteId: string, q: Record<string, unknown>): Promise<Record<string, unknown>> {
    const regions = await this.access.requireRegions(QC_MODULE, 'view');
    if (!uuidSchema.safeParse(siteId).success) throw problems.notFound();
    const site = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text AS id FROM sites WHERE id = ${siteId}::uuid
      ${regions === null ? Prisma.empty : Prisma.sql`AND region_id = ANY(${regions}::int[])`}`);
    if (!site[0]) throw problems.notFound('The site does not exist or is not visible to you.');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const conds: Prisma.Sql[] = [Prisma.sql`s.site_id = ${siteId}::uuid`];
    const state = oneParam(q, 'state');
    if (state !== undefined) {
      const st = STATE_IN[state];
      if (!st) throw problems.validation([{ path: '/state', code: 'invalid', message: 'state is open, fix_submitted, in_review or closed.' }]);
      conds.push(Prisma.sql`s.status::text = ${st}`);
    }
    if (cursor) conds.push(Prisma.sql`(s.raised_at, s.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`);
    const rows = await this.db.tx.$queryRaw<SnagRow[]>(Prisma.sql`${SNAG_SELECT} WHERE ${Prisma.join(conds, ' AND ')} ORDER BY s.raised_at DESC, s.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const open = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM snags WHERE site_id = ${siteId}::uuid AND status IN ('open', 'fix_uploaded', 'in_review')`);
    return { items: await this.dtos(auth, page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null }, open_count: Number(open[0]?.n ?? 0) };
  }

  private async dtos(auth: AuthContext, rows: SnagRow[]): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const types = new Map((await this.typeRows(Prisma.sql`id = ANY(${[...new Set(rows.map((r) => r.snag_type_id))]}::uuid[])`)).map((t) => [t.id, t]));
    const photos = await this.db.tx.$queryRaw<PhotoRow[]>(Prisma.sql`
      SELECT p.id::text AS id, p.snag_id::text AS snag_id, p.shot_type, p.exif_date, p.unknown_capture_date, p.captured_in_app, p.distance_m::text AS distance_m,
        p.geofence_result::text AS geofence_result, p.uploaded_by::text AS uploaded_by, p.uploaded_at, p.rejected_at, p.review_note
      FROM snag_photos p WHERE p.snag_id = ANY(${ids}::uuid[]) AND p.withdrawn_at IS NULL ORDER BY p.uploaded_at, p.id`);
    const refs = await this.view.userRefs([...new Set([...rows.map((r) => r.raised_by), ...rows.map((r) => r.pinned).filter((x): x is string => !!x), ...photos.map((p) => p.uploaded_by)])]);
    const grants = {
      edit: await this.access.regions(QC_MODULE, 'edit'),
      approve: await this.access.regions(QC_MODULE, 'approve'),
    };
    const has = (g: number[] | null, region: number) => g === null || g.includes(region);
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const t = types.get(r.snag_type_id) as TypeRow;
      const kind = r.status === 'open' || r.status === 'fix_uploaded' ? 'entry' : r.status === 'in_review' ? 'approve' : null;
      const holders = kind ? await this.holders(r.id, kind) : null;
      const can = kind
        ? (await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT qc_snag_can(${r.id}::uuid, ${kind}::text) AS ok`))[0]?.ok === true
        : false;
      const missing = kind === 'entry' ? (await this.db.tx.$queryRaw<{ m: unknown[] }[]>(Prisma.sql`SELECT qc_photos_missing(${r.id}::uuid) AS m`))[0]?.m ?? [] : [];
      const pinnedOther = r.pinned !== null && r.pinned !== auth.user.id;
      const actions: string[] = [];
      if (kind === 'entry' && can && !pinnedOther && has(grants.edit, r.region_id)) {
        actions.push('upload', 'edit');
        if (missing.length === 0) actions.push('submit');
      }
      if (kind === 'approve' && can && has(grants.approve, r.region_id)) actions.push('approve', 'reject');
      const dto: Record<string, unknown> = {
        id: r.id,
        site_id: r.site_id,
        site_code: r.site_code,
        task_id: r.task_id,
        scope: r.scope,
        snag_type: this.typeDto(t),
        title: r.title ?? r.description,
        description: r.title ? r.description || null : null,
        state: STATE_OUT[r.status] ?? r.status,
        photos: photos.filter((p) => p.snag_id === r.id).map((p) => {
          const u = refs.get(p.uploaded_by);
          return {
            id: p.id,
            file_id: p.id,
            shot_type: p.shot_type,
            status: p.rejected_at ? 'rejected' : 'accepted',
            reject_reason: p.rejected_at ? p.review_note : null,
            captured_at: p.exif_date,
            unknown_capture_date: p.unknown_capture_date,
            in_app_camera: p.captured_in_app,
            distance_m: p.distance_m === null ? null : Number(p.distance_m),
            geofence_ok: p.geofence_result === 'inside' ? true : p.geofence_result === 'outside' ? false : null,
            ...(u ? { uploaded_by: u } : {}),
            uploaded_at: p.uploaded_at,
          };
        }),
        photos_required: Math.max(t.min_photos, 1),
        photos_missing: missing,
        return_count: r.return_count,
        last_return_note: r.last_return_note,
        self_approval: r.self_approval,
        raised_at: r.raised_at,
        closed_at: r.closed_at,
        version: r.version,
        allowed_actions: actions,
      };
      const raiser = refs.get(r.raised_by);
      if (raiser) dto.raised_by = raiser;
      if (kind && holders) {
        const pinned = r.pinned ? refs.get(r.pinned) : undefined;
        dto.ball_in_court = { level: kind === 'entry' ? 1 : 2, level_kind: kind, holders: holders.list, rule: holders.rule, no_eligible_holder: !holders.any, ...(pinned ? { claimed_by: pinned } : {}) };
      }
      out.push(dto);
    }
    return out;
  }

  /** The holders of the Quality register row's cell for the level (L1 = entry, L2 = the approve cell), as the matrix names them. */
  private async holders(snagId: string, kind: string): Promise<{ list: MatrixAssigneeDto[]; rule: string; any: boolean }> {
    const cell = await this.db.tx.$queryRaw<{ id: string | null; rule: string | null; any: boolean }[]>(Prisma.sql`
      SELECT c.id::text AS id, c.rule::text AS rule, EXISTS (SELECT 1 FROM qc_snag_holders(${snagId}::uuid, ${kind}::text)) AS any
      FROM (SELECT qc_snag_cell(${snagId}::uuid, ${kind}::text) AS cid) x LEFT JOIN matrix_cells c ON c.id = x.cid`);
    const c = cell[0];
    if (!c?.id) return { list: [], rule: 'any_one', any: c?.any ?? false };
    const rows = await this.db.tx.$queryRaw<{ kind: string; ref_id: string; label: string; employee_id: string | null; status: string | null; deleted: boolean | null }[]>(Prisma.sql`
      SELECT a.kind::text AS kind, a.ref_id::text AS ref_id, coalesce(u.display_name, ro.name_en, g.name, '') AS label, u.employee_id, u.status::text AS status, (u.deleted_at IS NOT NULL) AS deleted
      FROM matrix_cell_assignees a LEFT JOIN users u ON a.kind = 'user' AND u.id = a.ref_id LEFT JOIN roles ro ON a.kind = 'role' AND ro.id = a.ref_id
      LEFT JOIN groups g ON a.kind = 'group' AND g.id = a.ref_id WHERE a.cell_id = ${c.id}::uuid ORDER BY label, a.ref_id`);
    const list = rows.map((a) => {
      const dto: MatrixAssigneeDto = { kind: a.kind as MatrixAssigneeDto['kind'], ref_id: a.ref_id, label: a.label, employee_id: a.kind === 'user' ? (a.employee_id?.trim() ?? null) : null };
      if (a.kind === 'user') {
        dto.user_id = a.ref_id;
        dto.account_status = accountStatus(a.status, a.deleted);
      }
      return dto;
    });
    return { list, rule: c.rule ?? 'any_one', any: c.any };
  }

  // ------------------------------------------------------------------ snags: writes
  async raise(auth: AuthContext, siteId: string, raw: unknown): Promise<Record<string, unknown>> {
    await this.access.requireRegions(QC_MODULE, 'view');
    if (!uuidSchema.safeParse(siteId).success) throw problems.notFound();
    const b = parse(snagInput, raw);
    const id = await this.call<string>(auth, Prisma.sql`SELECT qc_raise_snag(${siteId}::uuid, ${b.snag_type_id}::uuid, ${b.task_id ?? null}::uuid, ${b.scope ?? null}::text,
      ${b.title}::text, ${b.description ?? null}::text)::text AS r`);
    return this.get(auth, id);
  }

  async update(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const b = parse(snagPatch, raw);
    await this.snagRow(auth, id);
    await this.call(auth, Prisma.sql`SELECT true AS r FROM (SELECT qc_save_snag(${id}::uuid, ${version}::int, ${JSON.stringify(b)}::jsonb)) x`);
    return this.get(auth, id);
  }

  async uploadPhoto(auth: AuthContext, id: string, file: { buffer: Buffer; originalname: string } | undefined, body: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const snag = await this.get(auth, id);
    if (!file) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the photo as the multipart field "file".' }]);
    const actions = snag.allowed_actions as string[];
    if (!actions.includes('upload')) {
      if (!['open', 'fix_submitted'].includes(snag.state as string)) throw new ProblemException(409, 'invalid_transition', { detail: `Photos can be added only while the snag waits for the fix (it is ${String(snag.state)}).` });
      throw new ProblemException(403, 'not_eligible_holder', { detail: 'Only Data Entry (L1) of the Quality register row uploads the photos of the fix.' });
    }
    const rules = (snag.snag_type as { photo_rules: { formats: string[]; max_size_mb: number; shot_types: string[] } }).photo_rules;
    const reject = (reason: string, msg: string, extra: Record<string, unknown> = {}): never => {
      throw new ProblemException(422, 'file_rejected', { detail: msg, extra: { reason, ...extra }, errors: [{ path: '/file', code: reason, message: msg }] });
    };
    if (file.buffer.length > rules.max_size_mb * 1024 * 1024) {
      throw new ProblemException(413, 'file_too_large', { detail: `A photo may be ${rules.max_size_mb} MB at most.`, extra: { max_size_mb: rules.max_size_mb } });
    }
    const sn = sniff(file.buffer, file.originalname);
    if (!sn.ok) return reject(sn.reason, sn.detail);
    const ext = sn.ext === 'jpeg' ? 'jpg' : sn.ext;
    if (!sn.image || !rules.formats.map((f) => f.toLowerCase()).includes(ext)) reject('format_not_allowed', `Photos of this snag type are ${rules.formats.join(', ')}.`, { allowed: rules.formats });
    const capture = ['jpg', 'tiff', 'heic'].includes(ext) ? readExifDate(file.buffer) : null;
    const raised = new Date(snag.raised_at as Date);
    if (capture && capture.getTime() < raised.getTime() - EXIF_TOLERANCE_MS) {
      reject('before_snag_raised', 'The photo was taken before the snag was raised (EXIF date, one day of tolerance). Take a fresh photo of the fix.', {
        captured_at: capture.toISOString(), raised_at: raised.toISOString(),
      });
    }
    const shot = typeof body?.shot_type === 'string' && body.shot_type.trim() !== '' ? body.shot_type.trim() : null;
    const num = (v: unknown): number | null => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const key = newObjectKey('docs');
    await this.storage.store.put(key, file.buffer);
    try {
      const meta = {
        storage_key: key, mime_type: sn.mime, ext, size_bytes: file.buffer.length, sha256, shot_type: shot, exif_date: capture ? capture.toISOString() : null,
        in_app_camera: body?.in_app_camera === 'true' || body?.in_app_camera === true, device_lat: num(body?.device_lat), device_lon: num(body?.device_lon),
      };
      const pid = await this.call<string>(auth, Prisma.sql`SELECT qc_attach_photo(${id}::uuid, ${JSON.stringify(meta)}::jsonb)::text AS r`);
      const after = await this.get(auth, id);
      const photo = (after.photos as { id: string }[]).find((p) => p.id === pid);
      if (!photo) throw problems.notFound();
      return photo as Record<string, unknown>;
    } catch (e) {
      await this.storage.store.remove(key).catch(() => undefined);
      throw e;
    }
  }

  async withdrawPhoto(auth: AuthContext, id: string, photoId: string): Promise<Record<string, unknown>> {
    await this.snagRow(auth, id);
    if (!uuidSchema.safeParse(photoId).success) throw problems.notFound();
    await this.call(auth, Prisma.sql`SELECT true AS r FROM (SELECT qc_withdraw_photo(${id}::uuid, ${photoId}::uuid)) x`);
    return this.get(auth, id);
  }

  async transition(auth: AuthContext, id: string, action: 'submit' | 'review' | 'approve' | 'reject', ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.snagRow(auth, id);
    let note: string | null = null;
    let photos: string | null = null;
    if (action === 'reject') {
      const b = (raw ?? {}) as { note?: unknown };
      if (typeof b.note !== 'string' || b.note.trim() === '') {
        throw new ProblemException(422, 'note_required', { detail: 'A rejection needs a note.', errors: [{ path: '/note', code: 'required', message: 'A note is required.' }] });
      }
      const r = parse(rejectBody, raw);
      note = r.note;
      photos = r.rejected_photos ? JSON.stringify(r.rejected_photos) : null;
    } else {
      note = parse(noteBody, raw ?? {}).note ?? null;
    }
    if (action === 'approve') await this.stepUp.require(auth);
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    await this.call(auth, Prisma.sql`SELECT qc_transition_snag(${id}::uuid, ${version}::int, ${action}::text, ${note}::text, ${stepOk}::boolean, ${photos}::jsonb) AS r`);
    return this.get(auth, id);
  }
}
