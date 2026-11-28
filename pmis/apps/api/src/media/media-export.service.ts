import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Zip, ZipPassThrough } from 'fflate';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { SyslogService } from '../auth/syslog.service';
import { StepUpService } from '../auth/step-up.service';
import { IdempotencyService } from '../common/idempotency.service';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { attachmentHeader, safePart } from '../documents/naming';
import { StorageService, newObjectKey } from '../documents/storage.service';
import { applyContext } from '../logs/context';
import { MediaService, type MediaRow } from './media.service';

/** Largest selection of one export (the size cap in Settings > Documents > Media is the other limit). */
export const MEDIA_EXPORT_MAX_ITEMS = 1000;

const body = z.object({
  items: z.array(z.object({ kind: z.enum(['document_file', 'snag_photo']), id: z.guid() }).strict()).min(1).max(MEDIA_EXPORT_MAX_ITEMS),
}).strict();

interface JobRow {
  id: string; requested_by: string; scope: { kind: 'media_export'; items: { kind: 'document_file' | 'snag_photo'; id: string }[] };
  status: 'queued' | 'running' | 'done' | 'failed'; progress: string | number; file_count: number | null; size_bytes: bigint | null; storage_key: string | null;
  error: string | null; created_at: Date; finished_at: Date | null; expires_at: Date | null;
}

export interface MediaExportDto {
  id: string; kind: 'media_export'; status: 'queued' | 'running' | 'done' | 'failed'; progress: number;
  result?: { export_id: string; file_count: number | null; size_bytes: number | null; expires_at: Date | null; download_path: string };
  error?: { title: string; status: number; code: string; detail?: string };
  created_at: Date; finished_at: Date | null;
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet must not run a file name
  return `"${s.replace(/"/g, '""')}"`;
};
const MIME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/tiff': 'tif', 'application/pdf': 'pdf' };
const extOf = (r: MediaRow): string => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(r.name ?? '');
  return (m?.[1] ?? MIME_EXT[r.mime_type] ?? 'bin').toLowerCase();
};

/**
 * Export of a selection from the Media gallery (agreed design: zip with an index CSV, audited, step-up protected, size cap from a setting).
 * A background job on the existing job table (document_export_jobs, scope.kind = media_export; no new table): the request checks that every
 * chosen item is visible to the caller in the gallery, the step-up and the size cap (Settings > Documents > Media, `export_max_mb`) and returns a job;
 * the worker runs with the requester's own context and writes `SITE/NAME` entries plus `index.csv` to object storage; the download is audited and
 * lasts 7 days. Files that wait for the virus scan are left out and listed in the index, like the document zip. The audit rows reuse the document
 * zip actions (document_zip_start, document_zip_download) with entity media_export.
 */
@Injectable()
export class MediaExportService {
  private readonly log = new Logger('MediaExport');
  private readonly started = new Set<string>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly db: DbService,
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly idem: IdempotencyService,
    private readonly syslog: SyslogService,
    private readonly stepUp: StepUpService,
  ) {}

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private toDto(j: JobRow): MediaExportDto {
    const dto: MediaExportDto = { id: j.id, kind: 'media_export', status: j.status, progress: Number(j.progress), created_at: j.created_at, finished_at: j.finished_at };
    if (j.status === 'done') dto.result = { export_id: j.id, file_count: j.file_count, size_bytes: j.size_bytes === null ? null : Number(j.size_bytes), expires_at: j.expires_at, download_path: `/media/exports/${j.id}/download` };
    if (j.status === 'failed') dto.error = { title: 'The export failed', status: 500, code: 'internal_error', detail: j.error ?? undefined };
    return dto;
  }

  async start(auth: AuthContext, raw: unknown, idemKey: string | undefined, onStarted: (fn: () => void) => void): Promise<MediaExportDto> {
    const input = parse(body, raw);
    const cfg = await this.media.config();
    if (!cfg.enabled) throw problems.notFound();
    await this.stepUp.require(auth);
    const scope = { kind: 'media_export' as const, items: input.items };
    return this.idem.run(auth.user.id, 'startMediaExport', idemKey, scope, async () => {
      const rows = await this.media.resolve(input.items);
      const seen = new Set(rows.map((r) => `${r.kind}:${r.id}`));
      const missing = input.items.filter((i) => !seen.has(`${i.kind}:${i.id}`));
      if (missing.length > 0) throw problems.validation([{ path: '/items', code: 'not_visible', message: `${missing.length} chosen item(s) are not in your gallery. Reload and choose again.` }]);
      const total = rows.reduce((a, r) => a + Number(r.size_bytes), 0);
      if (total > cfg.export_max_mb * 1024 * 1024) {
        throw problems.validation([{ path: '/items', code: 'export_too_large', message: `The selection is larger than the export limit of ${cfg.export_max_mb} MB (Settings > Documents > Media). Choose fewer items.` }]);
      }
      const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT doc_job_create(${JSON.stringify(scope)}::jsonb)::text AS id`);
      const id = (r[0] as { id: string }).id;
      await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_audit('document_zip_start', 'media_export', ${id}::text, NULL, NULL, ${JSON.stringify({ kind: 'media_export', item_count: rows.length, size_bytes: total, limit_mb: cfg.export_max_mb })}::jsonb)`);
      onStarted(() => this.schedule(id, auth.user.id));
      return { id, kind: 'media_export', status: 'queued', progress: 0, created_at: new Date(), finished_at: null } as MediaExportDto;
    });
  }

  private schedule(jobId: string, userId: string): void {
    if (this.started.has(jobId)) return;
    this.started.add(jobId);
    const p = this.work(jobId, userId).catch((e) => this.log.warn(`media export ${jobId}: ${e instanceof Error ? e.message : String(e)}`)).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  private async inContext<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.client.$transaction(
      async (tx) => {
        await applyContext(tx, { ip: null, userAgent: null, requestId: null, userId });
        return this.db.runIn(tx, fn);
      },
      { maxWait: 10_000, timeout: 600_000 },
    );
  }

  private async work(jobId: string, userId: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 25)); // let the request transaction that created the job finish committing
    let key: string | null = null;
    let tmp: string | null = null;
    try {
      const job = await this.inContext(userId, async () => {
        const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT * FROM document_export_jobs WHERE id = ${jobId}::uuid`);
        if (rows[0]) await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'running', 0, NULL, NULL, NULL, NULL)`);
        return rows[0];
      });
      if (!job || job.scope?.kind !== 'media_export') throw new Error('job not found');
      tmp = join(tmpdir(), `pmis-media-${jobId}.zip`);
      await this.inContext(userId, async () => {
        const rows = (await this.media.resolve(job.scope.items)).sort((a, b) => (a.site_code ?? '').localeCompare(b.site_code ?? '') || a.uploaded_at.getTime() - b.uploaded_at.getTime() || a.id.localeCompare(b.id));
        if (rows.length === 0) throw new Error('no files');
        const states = this.storage.meta.scanStates ? await this.storage.meta.scanStates(rows.map((r) => r.storage_key ?? '')) : new Map<string, string>();
        const skipped = rows.filter((r) => { const st = states.get(r.storage_key ?? ''); return st !== undefined && st !== 'clean' && st !== 'legacy'; });
        const included = rows.filter((r) => !skipped.includes(r) && r.storage_key);
        const out = createWriteStream(tmp as string, { mode: 0o600 });
        const done = new Promise<void>((res, rej) => { out.on('finish', res); out.on('error', rej); });
        let zipError: Error | null = null;
        const zip = new Zip((err, chunk, final) => {
          if (err) { zipError = err; return; }
          out.write(Buffer.from(chunk));
          if (final) out.end();
        });
        const used = new Set<string>();
        const head = ['path', 'kind', 'site_code', 'type_code', 'state', 'uploaded_at', 'size_bytes', 'original_name', 'note'];
        const index = [head.map(csvCell).join(',')];
        let i = 0;
        for (const r of included) {
          const day = r.uploaded_at.toISOString().slice(0, 10).replace(/-/g, '');
          const folder = safePart(r.site_code ?? 'NO_SITE');
          const name = `${safePart(r.type_code)}_${day}_${r.id.slice(0, 8)}.${extOf(r)}`;
          let path = `${folder}/${name}`;
          for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${name.replace(/(\.[a-z0-9]+)$/, `_${n}$1`)}`;
          used.add(path.toLowerCase());
          const entry = new ZipPassThrough(path);
          zip.add(entry);
          const stream = await this.storage.store.get(r.storage_key as string);
          for await (const chunk of stream) entry.push(new Uint8Array(chunk as Buffer));
          entry.push(new Uint8Array(0), true);
          index.push([path, r.kind, r.site_code, r.type_code, r.state, r.uploaded_at.toISOString(), Number(r.size_bytes), r.name, ''].map(csvCell).join(','));
          i++;
          if (i % 20 === 0) await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'running', ${i / included.length}::numeric, NULL, NULL, NULL, NULL)`);
        }
        for (const r of skipped) index.push(['', r.kind, r.site_code, r.type_code, r.state, r.uploaded_at.toISOString(), Number(r.size_bytes), r.name, 'left out: waits for the virus scan'].map(csvCell).join(','));
        const m = new ZipPassThrough('index.csv');
        zip.add(m);
        m.push(new Uint8Array(Buffer.from('\uFEFF' + index.join('\r\n') + '\r\n', 'utf8')), true);
        zip.end();
        await done;
        if (zipError) throw zipError;
        const size = (await fs.stat(tmp as string)).size;
        key = newObjectKey('exports');
        await this.storage.store.putFile(key, tmp as string, size);
        await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'done', 1, ${included.length}::int, ${size}::bigint, ${key}::text, NULL)`);
        if (skipped.length > 0) {
          await this.db.tx.$executeRaw(Prisma.sql`SELECT log_audit_write('document_zip_skipped_unscanned', 'media_export', ${jobId}::text, NULL,
            ${JSON.stringify({ skipped_ids: skipped.map((r) => r.id) })}::jsonb, 'files that wait for the virus scan are left out of a media export')`);
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      if (key) await this.storage.store.remove(key).catch(() => undefined);
      await this.inContext(userId, async () => {
        await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'failed', NULL, NULL, NULL, NULL, ${msg.slice(0, 300)}::text)`);
      }).catch(() => undefined);
      await this.syslog.write('error', 'media export failed', { job_id: jobId, error: msg });
    } finally {
      if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async own(auth: AuthContext, rawId: string): Promise<JobRow> {
    if (!uuidSchema.safeParse(rawId).success) throw problems.notFound('The export does not exist.');
    const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT * FROM document_export_jobs WHERE id = ${rawId}::uuid`);
    const j = rows[0];
    if (!j || j.scope?.kind !== 'media_export' || j.requested_by !== auth.user.id) throw problems.notFound('The export does not exist.');
    return j;
  }

  async job(auth: AuthContext, rawId: string): Promise<MediaExportDto> {
    return this.toDto(await this.own(auth, rawId));
  }

  async download(auth: AuthContext, rawId: string): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    const j = await this.own(auth, rawId);
    if (j.status !== 'done' || !j.storage_key) throw new ProblemException(409, 'invalid_transition', { detail: `The export is ${j.status}.` });
    if (j.expires_at && j.expires_at.getTime() < Date.now()) throw new ProblemException(410, 'export_expired', { detail: 'The export has expired: start it again.' });
    const name = `GSDN_Media_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
    await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_audit('document_zip_download', 'media_export', ${j.id}::text, NULL, NULL,
      ${JSON.stringify({ export_id: j.id, download_name: name, file_count: j.file_count, size_bytes: j.size_bytes === null ? null : Number(j.size_bytes) })}::jsonb)`);
    return {
      file: new StreamableFile(await this.storage.store.get(j.storage_key), { type: 'application/zip', disposition: attachmentHeader(name), length: Number(j.size_bytes) }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }
}
