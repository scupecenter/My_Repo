import { Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { RateLimiter } from '../auth/rate-limiter';
import { StepUpService } from '../auth/step-up.service';
import { decodeTypedCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DocumentsService, SITE_DOCS } from '../documents/documents.service';
import { StorageService } from '../documents/storage.service';
import { isThumbSource, loadSharp, makeThumb, thumbKey, thumbMime, ThumbFormat } from './thumbs';

/**
 * The central Media gallery (Library > Media, owner decision GAL-1 and LIB-1, 2026-11-27, migration 0396, contract 0.15.292).
 *
 * No storage and no table of its own: the items are read live from document_files (through document_slots) and snag_photos, so a withdrawal,
 * a replacement or a decision on evidence shows at once. Visibility is exactly the owning slot's: the Documents screen view in the region,
 * the module of the register (document slots; the same condition as the Documents list) and, for a snag photo, the Quality module in the
 * snag's region (the same two checks as the download). What is shown is configured in the setting media.gallery (Settings > Documents > Media):
 * which kinds, which registers, which codes are left out, whether withdrawn items can be listed, the page size and the thumbnail sizes.
 * Nothing is deleted: a withdrawn or rejected item is hidden by default and listed only when the setting allows it.
 */
const putBody = z.object({
  enabled: z.boolean(), snag_photos: z.boolean(), include_site_documents: z.boolean(), image_only: z.boolean(), show_withdrawn: z.boolean(),
  document_kinds: z.array(z.string()).max(5), register_keys: z.array(z.string()).max(60), exclude_doc_codes: z.array(z.string()).max(100),
  page_size: z.number().int(),
  thumbnails: z.object({ enabled: z.boolean(), small_px: z.number().int(), medium_px: z.number().int(), quality: z.number().int(), format: z.string(), max_source_mb: z.number().int(), rate_per_min: z.number().int() }).strict(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface MediaCfg {
  enabled: boolean; snag_photos: boolean; include_site_documents: boolean; image_only: boolean; show_withdrawn: boolean;
  document_kinds: string[]; register_keys: string[]; exclude_doc_codes: string[]; page_size: number;
  thumbnails: { enabled: boolean; small_px: number; medium_px: number; quality: number; format: ThumbFormat; max_source_mb: number; rate_per_min: number };
}
export type MediaSettingsDto = MediaCfg & { updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; version: number; can_edit: boolean; thumbnails_available: boolean };

type Row = {
  kind: 'document_file' | 'snag_photo'; id: string; uploaded_at: Date; cur_text: string; site_id: string | null; region_id: number | null; site_code: string | null; site_name: string | null;
  type_code: string; type_name_en: string; type_name_ar: string | null; doc_kind: string | null; mime_type: string; name: string | null; size_bytes: bigint; uploaded_by: string;
  state: string; version: number | null; status: string | null; register_key: string | null; record_id: string | null; task_id: string | null; snag_id: string | null; shot_type: string | null;
  storage_key?: string;
};

@Injectable()
export class MediaService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly docs: DocumentsService,
    private readonly storage: StorageService,
    private readonly limiter: RateLimiter,
  ) {}

  // ------------------------------------------------------------------------------------------------------------------ settings

  private async state(sql: Prisma.Sql): Promise<MediaSettingsDto> {
    const rows = await this.db.tx.$queryRaw<{ r: Omit<MediaSettingsDto, 'thumbnails_available'> }[]>(sql);
    return { ...rows[0]!.r, thumbnails_available: (await loadSharp()) !== null };
  }

  getSettings(): Promise<MediaSettingsDto> {
    return this.state(Prisma.sql`SELECT media_gallery_state() AS r`);
  }

  async setSettings(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<MediaSettingsDto> {
    const { reason, ...body } = parse(putBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.state(Prisma.sql`SELECT admin_set_media_gallery(${JSON.stringify(body)}::jsonb, ${reason}::text, ${etag}::int) AS r`);
  }

  // ------------------------------------------------------------------------------------------------------------------ items

  /** The two branches of the union with every visibility and configuration condition. `extra` narrows them (filters, one id). */
  private async branches(cfg: MediaCfg, q: Query, only?: { kind: 'document_file' | 'snag_photo'; id: string }): Promise<Prisma.Sql[]> {
    const regions = await this.access.requireRegions(SITE_DOCS, 'view');
    const status = oneParam(q, 'status') ?? 'current';
    if (!['current', 'withdrawn', 'pending_evidence'].includes(status)) throw problems.validation([{ path: '/status', code: 'invalid', message: 'status is current, withdrawn or pending_evidence.' }]);
    if (status !== 'current' && !cfg.show_withdrawn && status === 'withdrawn') throw problems.validation([{ path: '/status', code: 'not_enabled', message: 'Listing withdrawn items is switched off in Settings > Documents > Media.' }]);
    const source = oneParam(q, 'source');
    if (source !== undefined && !['documents', 'snags'].includes(source)) throw problems.validation([{ path: '/source', code: 'invalid', message: 'source is documents or snags.' }]);
    const uuid = (key: string): string | undefined => {
      const v = oneParam(q, key);
      if (v !== undefined && !uuidSchema.safeParse(v).success) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: 'Not a uuid.' }]);
      return v;
    };
    const date = (key: string): string | undefined => {
      const v = oneParam(q, key);
      if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is a date (YYYY-MM-DD).` }]);
      return v;
    };
    const site = uuid('site_id'); const by = uuid('uploaded_by'); const from = date('uploaded_from'); const to = date('uploaded_to');
    const region = oneParam(q, 'region_id');
    if (region !== undefined && !/^[0-9]{1,2}$/.test(region)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is an integer.' }]);
    const text = oneParam(q, 'q'); const docCode = oneParam(q, 'doc_code'); const registerKey = oneParam(q, 'register_key');
    const out: Prisma.Sql[] = [];

    // documents (document_files)
    if (cfg.document_kinds.length > 0 && source !== 'snags' && (only === undefined || only.kind === 'document_file')) {
      const c: Prisma.Sql[] = [Prisma.sql`dt.form_kind IS NULL`, Prisma.sql`dt.kind::text = ANY(${cfg.document_kinds}::text[])`, await this.docs.registerScopeSql()];
      if (regions !== null) c.push(Prisma.sql`(s.region_id = ANY(${regions}::int[]) OR s.is_global)`);
      if (cfg.image_only) c.push(Prisma.sql`f.mime_type LIKE 'image/%'`);
      if (cfg.register_keys.length > 0) c.push(cfg.include_site_documents ? Prisma.sql`(s.register_key IS NULL OR s.register_key = ANY(${cfg.register_keys}::text[]))` : Prisma.sql`s.register_key = ANY(${cfg.register_keys}::text[])`);
      else if (!cfg.include_site_documents) c.push(Prisma.sql`s.register_key IS NOT NULL`);
      if (cfg.exclude_doc_codes.length > 0) c.push(Prisma.sql`NOT (dt.code = ANY(${cfg.exclude_doc_codes}::text[]))`);
      c.push(status === 'withdrawn' ? Prisma.sql`f.withdrawn_at IS NOT NULL` : status === 'pending_evidence' ? Prisma.sql`false` : Prisma.sql`(f.is_current AND f.withdrawn_at IS NULL)`);
      if (site) c.push(Prisma.sql`s.site_id = ${site}::uuid`);
      if (region !== undefined) c.push(Prisma.sql`s.region_id = ${Number(region)}::int`);
      if (by) c.push(Prisma.sql`f.uploaded_by = ${by}::uuid`);
      if (from) c.push(Prisma.sql`f.uploaded_at >= ${from}::date`);
      if (to) c.push(Prisma.sql`f.uploaded_at < (${to}::date + 1)`);
      if (docCode) c.push(Prisma.sql`dt.code = ${docCode}`);
      if (registerKey) c.push(Prisma.sql`s.register_key = ${registerKey}`);
      if (text) c.push(Prisma.sql`(si.site_code ILIKE ${likePattern(text)} OR dt.name_en ILIKE ${likePattern(text)} OR dt.code ILIKE ${likePattern(text)} OR f.original_name ILIKE ${likePattern(text)})`);
      if (only) c.push(Prisma.sql`f.id = ${only.id}::uuid`);
      out.push(Prisma.sql`
        SELECT 'document_file'::text AS kind, f.id::text AS id, f.uploaded_at, s.site_id::text AS site_id, s.region_id, coalesce(si.site_code, 'GLOBAL') AS site_code, si.name AS site_name,
          dt.code AS type_code, dt.name_en AS type_name_en, dt.name_ar AS type_name_ar, dt.kind::text AS doc_kind, f.mime_type, f.original_name AS name, f.size_bytes, f.uploaded_by::text AS uploaded_by,
          CASE WHEN f.withdrawn_at IS NOT NULL THEN 'withdrawn' WHEN NOT f.is_current THEN 'superseded' ELSE 'current' END AS state, f.version, s.status::text AS status,
          s.register_key, s.register_entity_id::text AS record_id, s.task_id::text AS task_id, NULL::text AS snag_id, NULL::text AS shot_type, f.storage_key
        FROM document_files f JOIN document_slots s ON s.id = f.slot_id LEFT JOIN sites si ON si.id = s.site_id JOIN document_types dt ON dt.id = s.doc_type_id
        WHERE ${Prisma.join(c, ' AND ')}`);
    }

    // QC snag photos (snag_photos): the Quality module in the snag's region as well, like the download
    const noSnagFilter = docCode !== undefined || registerKey !== undefined;
    if (cfg.snag_photos && source !== 'documents' && !noSnagFilter && (only === undefined || only.kind === 'snag_photo')) {
      const quality = await this.access.regions('quality', 'view');
      const c: Prisma.Sql[] = [Prisma.sql`true`];
      if (regions !== null) c.push(Prisma.sql`sg.region_id = ANY(${regions}::int[])`);
      if (quality !== null) c.push(Prisma.sql`sg.region_id = ANY(${quality}::int[])`);
      if (cfg.image_only) c.push(Prisma.sql`p.mime_type LIKE 'image/%'`);
      c.push(status === 'withdrawn' ? Prisma.sql`(p.withdrawn_at IS NOT NULL OR p.rejected_at IS NOT NULL)`
        : status === 'pending_evidence' ? Prisma.sql`(p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND p.evidence_status = 'pending_evidence')`
        : Prisma.sql`(p.withdrawn_at IS NULL AND p.rejected_at IS NULL)`);
      if (site) c.push(Prisma.sql`sg.site_id = ${site}::uuid`);
      if (region !== undefined) c.push(Prisma.sql`sg.region_id = ${Number(region)}::int`);
      if (by) c.push(Prisma.sql`p.uploaded_by = ${by}::uuid`);
      if (from) c.push(Prisma.sql`p.uploaded_at >= ${from}::date`);
      if (to) c.push(Prisma.sql`p.uploaded_at < (${to}::date + 1)`);
      const snagType = oneParam(q, 'snag_type');
      if (snagType) c.push(Prisma.sql`st.code = ${snagType}`);
      if (text) c.push(Prisma.sql`(si.site_code ILIKE ${likePattern(text)} OR st.name_en ILIKE ${likePattern(text)} OR st.code ILIKE ${likePattern(text)} OR coalesce(p.shot_type, '') ILIKE ${likePattern(text)})`);
      if (only) c.push(Prisma.sql`p.id = ${only.id}::uuid`);
      out.push(Prisma.sql`
        SELECT 'snag_photo'::text AS kind, p.id::text AS id, p.uploaded_at, sg.site_id::text AS site_id, sg.region_id, si.site_code AS site_code, si.name AS site_name,
          st.code AS type_code, st.name_en AS type_name_en, st.name_ar AS type_name_ar, 'photo'::text AS doc_kind, p.mime_type, NULL::text AS name, p.size_bytes, p.uploaded_by::text AS uploaded_by,
          CASE WHEN p.withdrawn_at IS NOT NULL THEN 'withdrawn' WHEN p.rejected_at IS NOT NULL THEN 'rejected' WHEN p.evidence_status = 'pending_evidence' THEN 'pending_evidence' ELSE 'current' END AS state,
          NULL::int AS version, sg.status::text AS status, NULL::text AS register_key, NULL::text AS record_id, sg.task_id::text AS task_id, sg.id::text AS snag_id, p.shot_type, p.storage_key
        FROM snag_photos p JOIN snags sg ON sg.id = p.snag_id JOIN sites si ON si.id = sg.site_id JOIN snag_types st ON st.id = sg.snag_type_id
        WHERE ${Prisma.join(c, ' AND ')}`);
    }
    return out;
  }

  async config(): Promise<MediaCfg> {
    const s = await this.getSettings();
    return s;
  }

  private link(r: Row): Record<string, string | null> {
    if (r.kind === 'snag_photo') return { kind: 'snag', snag_id: r.snag_id, site_id: r.site_id };
    if (r.register_key) return { kind: 'register', register_key: r.register_key, record_id: r.record_id, site_id: r.site_id };
    if (r.task_id) return { kind: 'task', task_id: r.task_id, site_id: r.site_id };
    return { kind: 'site', site_id: r.site_id };
  }

  async list(q: Query) {
    const cfg = await this.config();
    if (!cfg.enabled) return { enabled: false, items: [], page: { limit: cfg.page_size, next_cursor: null } };
    const limit = q.limit === undefined ? cfg.page_size : parseLimit(q.limit);
    const cur = decodeTypedCursor(typeof q.cursor === 'string' ? q.cursor : undefined, ['ts', 'uuid']);
    const parts = await this.branches(cfg, q);
    if (parts.length === 0) return { enabled: true, items: [], page: { limit, next_cursor: null } };
    const keyset = cur ? Prisma.sql`WHERE (u.uploaded_at, u.id::uuid) < (${cur[0]}::timestamptz, ${cur[1]}::uuid)` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT u.*, to_char(u.uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cur_text FROM (${Prisma.join(parts, ' UNION ALL ')}) u
      ${keyset} ORDER BY u.uploaded_at DESC, u.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const thumbs = cfg.thumbnails.enabled && (await loadSharp()) !== null;
    return {
      enabled: true,
      items: page.map((r) => ({
        kind: r.kind, id: r.id, uploaded_at: r.uploaded_at, uploaded_by: r.uploaded_by, state: r.state, version: r.version, slot_status: r.kind === 'document_file' ? r.status : null, snag_status: r.kind === 'snag_photo' ? r.status : null,
        mime_type: r.mime_type, name: r.name, size_bytes: Number(r.size_bytes), shot_type: r.shot_type,
        type: { code: r.type_code, name_en: r.type_name_en, name_ar: r.type_name_ar, kind: r.doc_kind },
        site: r.site_id ? { id: r.site_id, code: r.site_code, name: r.site_name, region_id: r.region_id } : null,
        link: this.link(r),
        has_thumbnail: thumbs && isThumbSource(r.mime_type) && Number(r.size_bytes) <= cfg.thumbnails.max_source_mb * 1024 * 1024,
        download_url: `/files/${r.id}/download`,
      })),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.cur_text, last.id]) : null },
    };
  }

  /** Filter values the screen offers: the document types that have an image in the gallery's scope and the snag types. */
  async facets() {
    const cfg = await this.config();
    if (!cfg.enabled) return { document_types: [], snag_types: [], registers: [] };
    const regions = await this.access.requireRegions(SITE_DOCS, 'view');
    const c: Prisma.Sql[] = [Prisma.sql`dt.form_kind IS NULL`, Prisma.sql`dt.kind::text = ANY(${cfg.document_kinds}::text[])`, await this.docs.registerScopeSql(), Prisma.sql`(f.is_current AND f.withdrawn_at IS NULL)`];
    if (regions !== null) c.push(Prisma.sql`(s.region_id = ANY(${regions}::int[]) OR s.is_global)`);
    if (cfg.image_only) c.push(Prisma.sql`f.mime_type LIKE 'image/%'`);
    if (cfg.register_keys.length > 0) c.push(cfg.include_site_documents ? Prisma.sql`(s.register_key IS NULL OR s.register_key = ANY(${cfg.register_keys}::text[]))` : Prisma.sql`s.register_key = ANY(${cfg.register_keys}::text[])`);
    else if (!cfg.include_site_documents) c.push(Prisma.sql`s.register_key IS NOT NULL`);
    if (cfg.exclude_doc_codes.length > 0) c.push(Prisma.sql`NOT (dt.code = ANY(${cfg.exclude_doc_codes}::text[]))`);
    const types = cfg.document_kinds.length === 0 ? [] : await this.db.tx.$queryRaw<{ code: string; name_en: string; name_ar: string | null; register_key: string | null; n: number }[]>(Prisma.sql`
      SELECT dt.code, dt.name_en, dt.name_ar, s.register_key, count(*)::int AS n FROM document_files f JOIN document_slots s ON s.id = f.slot_id JOIN document_types dt ON dt.id = s.doc_type_id
      WHERE ${Prisma.join(c, ' AND ')} GROUP BY dt.code, dt.name_en, dt.name_ar, s.register_key ORDER BY dt.name_en`);
    const snags = !cfg.snag_photos ? [] : await this.db.tx.$queryRaw<{ code: string; name_en: string; name_ar: string | null }[]>(Prisma.sql`
      SELECT code, name_en, name_ar FROM snag_types WHERE is_active ORDER BY name_en`);
    const registers = [...new Set(types.map((t) => t.register_key).filter((k): k is string => k !== null))].sort();
    const byCode = new Map<string, { code: string; name_en: string; name_ar: string | null; count: number }>();
    for (const t of types) { const e = byCode.get(t.code); if (e) e.count += t.n; else byCode.set(t.code, { code: t.code, name_en: t.name_en, name_ar: t.name_ar, count: t.n }); }
    return { document_types: [...byCode.values()], snag_types: snags, registers };
  }

  // ------------------------------------------------------------------------------------------------------------------ thumbnail

  /** GET /media/items/{kind}/{id}/thumbnail?size=small|medium. Visible only when the item itself is visible (404 otherwise); made on first request and kept beside the original. */
  async thumbnail(auth: AuthContext, kind: string, id: string, sizeRaw: string | undefined): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    if (!['document_file', 'snag_photo'].includes(kind) || !uuidSchema.safeParse(id).success) throw problems.notFound();
    const size = sizeRaw === undefined ? 'small' : sizeRaw;
    if (size !== 'small' && size !== 'medium') throw problems.validation([{ path: '/size', code: 'invalid', message: 'size is small or medium.' }]);
    const cfg = await this.config();
    if (!cfg.enabled) throw problems.notFound();
    // the item must be in the gallery's scope for this caller (the same conditions as the list; status of any kind)
    const found: Row[] = [];
    for (const st of ['current', 'withdrawn', 'pending_evidence']) {
      if (st === 'withdrawn' && !cfg.show_withdrawn) continue;
      const parts = await this.branches(cfg, { status: st }, { kind: kind as 'document_file' | 'snag_photo', id });
      if (parts.length === 0) continue;
      found.push(...(await this.db.tx.$queryRaw<Row[]>(Prisma.sql`SELECT u.* FROM (${Prisma.join(parts, ' UNION ALL ')}) u LIMIT 1`)));
      if (found.length > 0) break;
    }
    const r = found[0];
    if (!r || !r.storage_key) throw problems.notFound();
    const th = cfg.thumbnails;
    if (!th.enabled) throw new ProblemException(503, 'thumbnails_unavailable', { detail: 'Thumbnails are switched off in Settings > Documents > Media.' });
    if (!isThumbSource(r.mime_type)) throw new ProblemException(415, 'thumbnail_unsupported', { detail: 'This file type has no thumbnail.' });
    if (Number(r.size_bytes) > th.max_source_mb * 1024 * 1024) throw new ProblemException(413, 'file_too_large', { detail: `A thumbnail is made from files of ${th.max_source_mb} MB at most.` });
    if ((await loadSharp()) === null) throw new ProblemException(503, 'thumbnails_unavailable', { detail: 'The thumbnail maker is not available on this server.' });
    const px = size === 'small' ? th.small_px : th.medium_px;
    const key = thumbKey(r.storage_key, size, px, th.format);
    if (!key) throw new ProblemException(415, 'thumbnail_unsupported', { detail: 'This file has no thumbnail.' });
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300' };
    const mime = thumbMime(th.format);
    try {
      return { file: new StreamableFile(await this.storage.store.get(key), { type: mime }), headers };
    } catch {
      /* not made yet */
    }
    // SEC-2: only the making of a thumbnail counts, per person and minute (Settings > Documents > Media); a kept thumbnail was served above
    const wait = this.limiter.hit(`media-thumb:${auth.user.id}`, th.rate_per_min);
    if (wait > 0) throw new ProblemException(429, 'rate_limited', { detail: `Too many thumbnails were made for you in the last minute (limit ${th.rate_per_min}). Try again in ${wait} s.`, headers: { 'Retry-After': String(wait) } });
    const src = await this.storage.store.get(r.storage_key);
    const chunks: Buffer[] = [];
    for await (const c of src) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    let made: Awaited<ReturnType<typeof makeThumb>>;
    try {
      made = await makeThumb(Buffer.concat(chunks), px, th.format, th.quality);
    } catch {
      throw new ProblemException(415, 'thumbnail_unsupported', { detail: 'The image could not be read.' });
    }
    if (!made) throw new ProblemException(503, 'thumbnails_unavailable', { detail: 'The thumbnail maker is not available on this server.' });
    try {
      await this.storage.store.putGenerated(key, made.data);
    } catch {
      /* two requests made it at once: the first one wins */
    }
    return { file: new StreamableFile(made.data, { type: mime, length: made.data.length }), headers };
  }
}
