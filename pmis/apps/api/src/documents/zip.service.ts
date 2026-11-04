import { Injectable, Logger, OnApplicationBootstrap, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Zip, ZipPassThrough } from 'fflate';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { IdempotencyService } from '../common/idempotency.service';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { SyslogService } from '../auth/syslog.service';
import { DocumentsService, SITE_DOCS } from './documents.service';
import { attachmentHeader, displayName, safePart } from './naming';
import { StorageService, newObjectKey } from './storage.service';

const body = z
  .object({
    site_id: z.string().uuid().optional(),
    stage_code: z.string().trim().min(1).max(20).optional(),
    doc_code: z.string().trim().min(1).max(40).optional(),
    file_ids: z.array(z.string().uuid()).min(1).max(5000).optional(),
    slot_status: z.enum(['uploaded', 'in_review', 'approved', 'rejected']).optional(),
    include_superseded: z.boolean().optional(),
  })
  .strict();
type Scope = z.infer<typeof body>;

export interface JobDto {
  id: string;
  kind: 'zip_export' | 'audit_export' | 'security_export';
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  result?: Record<string, unknown>;
  error?: { title: string; status: number; code: string; detail?: string };
  created_at: Date;
  finished_at: Date | null;
}

interface JobRow {
  id: string;
  requested_by: string;
  scope: Scope & { kind?: 'audit_export' | 'security_export'; filters?: unknown };
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string | number;
  file_count: number | null;
  size_bytes: bigint | null;
  storage_key: string | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet must not run a file name
  return `"${s.replace(/"/g, '""')}"`;
};

/**
 * Bulk zip (ADR 0008 section 6): per site, per stage, per document type across sites, or an explicit list. A background job: the request returns a job at
 * once; the worker runs in this process with the requester's own verified context (so row-level security limits the content to their regions), writes the zip
 * to object storage, and the requester downloads it (audited) for 7 days. Layout SITE/STAGE/NAME plus manifest.csv.
 */
@Injectable()
export class ZipService implements OnApplicationBootstrap {
  private readonly log = new Logger('ZipExport');
  private readonly started = new Set<string>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly docs: DocumentsService,
    private readonly storage: StorageService,
    private readonly idem: IdempotencyService,
    private readonly syslog: SyslogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.db.client.$queryRaw`SELECT doc_job_fail_stale()`;
    } catch {
      /* the migration role runs this; the application role may not: stale jobs then simply stay failed by timeout in the UI */
    }
  }

  /** Waits for the jobs started by this process (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private toDto(j: JobRow): JobDto {
    // migration 0045: the log exports (audit_export, security_export) use the same job table and object storage
    const kind = j.scope?.kind ?? 'zip_export';
    const dto: JobDto = { id: j.id, kind, status: j.status, progress: Number(j.progress), created_at: j.created_at, finished_at: j.finished_at };
    if (j.status === 'done' && kind !== 'zip_export') {
      dto.result = { export_id: j.id, row_count: j.file_count, size_bytes: j.size_bytes === null ? null : Number(j.size_bytes), expires_at: j.expires_at,
        download_path: `/${kind === 'audit_export' ? 'audit-log' : 'security-log'}/exports/${j.id}/download` };
    } else if (j.status === 'done') dto.result = { export_id: j.id, file_count: j.file_count, size_bytes: j.size_bytes === null ? null : Number(j.size_bytes), expires_at: j.expires_at };
    if (j.status === 'failed') dto.error = { title: 'The export failed', status: 500, code: 'internal_error', detail: j.error ?? undefined };
    return dto;
  }

  private matchFilter(scope: Scope, regions: number[] | null, registerScope: Prisma.Sql): Prisma.Sql[] {
    const q: Record<string, unknown> = {};
    if (scope.site_id) q.site_id = scope.site_id;
    if (scope.stage_code) q.stage_code = scope.stage_code;
    if (scope.doc_code) q.doc_code = scope.doc_code;
    if (scope.slot_status) q.slot_status = scope.slot_status;
    if (scope.include_superseded) q.include_superseded = 'true';
    const conds = this.docs.filterSql(q, regions);
    conds.push(Prisma.sql`s.status::text <> 'not_required'`);
    if (scope.file_ids) conds.push(Prisma.sql`f.id = ANY(${scope.file_ids}::uuid[])`);
    conds.push(registerScope);
    return conds;
  }

  async start(auth: AuthContext, raw: unknown, idemKey: string | undefined, onStarted: (fn: () => void) => void): Promise<JobDto> {
    const regions = await this.docs.downloadRegions();
    const scope = parse(body, raw);
    if (!scope.site_id && !scope.stage_code && !scope.doc_code && !scope.file_ids) {
      throw problems.validation([{ path: '/', code: 'scope_required', message: 'Choose a site, a stage, a document type or a list of files.' }]);
    }
    return this.idem.run(auth.user.id, 'startZipExport', idemKey, scope, async () => {
      const found = await this.db.tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n ${DocumentsService.LIST_FROM} WHERE ${Prisma.join(this.matchFilter(scope, regions, await this.docs.registerScopeSql()), ' AND ')}`);
      const n = found[0]?.n ?? 0;
      if (n === 0) throw problems.validation([{ path: '/', code: 'no_files', message: 'No file matches this scope in your regions.' }]);
      const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT doc_job_create(${JSON.stringify(scope)}::jsonb)::text AS id`);
      const id = (r[0] as { id: string }).id;
      await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_audit('document_zip_start', 'document_zip_export', ${id}::text, NULL, NULL, ${JSON.stringify({ scope, file_count: n })}::jsonb)`);
      const admin = auth.state.isAdmin;
      onStarted(() => this.schedule(id, auth.user.id, admin));
      return { id, kind: 'zip_export', status: 'queued', progress: 0, created_at: new Date(), finished_at: null } as JobDto;
    });
  }

  private schedule(jobId: string, userId: string, admin: boolean): void {
    if (this.started.has(jobId)) return;
    this.started.add(jobId);
    const p = this.work(jobId, userId, admin).catch((e) => this.log.warn(`zip job ${jobId}: ${e instanceof Error ? e.message : String(e)}`)).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  /** Runs inside a transaction that carries the requester's context, exactly like a request. */
  private async inContext<T>(userId: string, admin: boolean, fn: () => Promise<T>): Promise<T> {
    return this.db.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
        await tx.$queryRaw`SELECT set_config('app.region_ids', CASE WHEN ${admin}::boolean THEN '*' ELSE app_resolve_region_ids(${userId}::uuid) END, true)`;
        return this.db.runIn(tx, fn);
      },
      { maxWait: 10_000, timeout: 600_000 },
    );
  }

  private async work(jobId: string, userId: string, admin: boolean): Promise<void> {
    await new Promise((r) => setTimeout(r, 25)); // let the request transaction that created the job finish committing
    let key: string | null = null;
    let tmp: string | null = null;
    try {
      const job = await this.inContext(userId, admin, async () => {
        const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT * FROM document_export_jobs WHERE id = ${jobId}::uuid`);
        if (rows[0]) await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'running', 0, NULL, NULL, NULL, NULL)`);
        return rows[0];
      });
      if (!job) throw new Error('job not found');
      tmp = join(tmpdir(), `pmis-zip-${jobId}.zip`);
      const result = await this.inContext(userId, admin, async () => {
        const regions = admin ? null : await this.access.regions(SITE_DOCS, 'download_documents');
        const rows = await this.db.tx.$queryRaw<{
          id: string; original_name: string; storage_key: string; ext: string | null; version: number; is_current: boolean; sha256: string; size_bytes: bigint; uploaded_at: Date; approved_date: string | null;
          site_code: string; task_code: string | null; doc_code: string; candidate_label: string | null; stage_code: string | null; slot_status: string;
        }[]>(Prisma.sql`
          SELECT f.id::text AS id, f.original_name, f.storage_key, f.ext, f.version, f.is_current, f.sha256, f.size_bytes, f.uploaded_at, f.approved_date::text AS approved_date,
            coalesce(si.site_code, 'GLOBAL') AS site_code, coalesce(td.code, upper(s.register_key)) AS task_code, dt.code AS doc_code, s.candidate_label, st.code AS stage_code, s.status::text AS slot_status
          ${DocumentsService.LIST_FROM}
          WHERE ${Prisma.join(this.matchFilter(job.scope, regions, await this.docs.registerScopeSql(admin)), ' AND ')} ORDER BY si.site_code, st.code, td.code, dt.code, f.uploaded_at, f.id`);
        if (rows.length === 0) throw new Error('no files');
        // Q195: a zip carries only uploaded files that passed the virus scan; a file in quarantine (pending_rescan or infected) is left out and listed
        const states = this.storage.meta.scanStates ? await this.storage.meta.scanStates(rows.map((r) => r.storage_key)) : new Map<string, string>();
        const skipped = rows.filter((r) => { const st = states.get(r.storage_key); return st !== undefined && st !== 'clean' && st !== 'legacy'; });
        const included = rows.filter((r) => !skipped.includes(r));
        const out = createWriteStream(tmp as string, { mode: 0o600 });
        const done = new Promise<void>((res, rej) => {
          out.on('finish', res);
          out.on('error', rej);
        });
        let zipError: Error | null = null;
        const zip = new Zip((err, chunk, final) => {
          if (err) {
            zipError = err;
            return;
          }
          out.write(Buffer.from(chunk));
          if (final) out.end();
        });
        const used = new Set<string>();
        const manifest = [['path', 'original_name', 'sha256', 'version', 'is_current', 'slot_status', 'approved_date', 'uploaded_at'].map(csvCell).join(',')];
        let i = 0;
        for (const r of included) {
          const name = displayName({ site_code: r.site_code, task_code: r.task_code, doc_code: r.doc_code, candidate_label: r.candidate_label, approved_date: r.approved_date, uploaded_at: r.uploaded_at, ext: r.ext ?? 'bin', version: r.version, is_current: r.is_current });
          let path = `${safePart(r.site_code)}/${safePart(r.stage_code ?? 'NA')}/${name}`;
          for (let n = 2; used.has(path.toLowerCase()); n++) path = `${safePart(r.site_code)}/${safePart(r.stage_code ?? 'NA')}/${name.replace(/(\.[a-z0-9]+)$/, `_${n}$1`)}`;
          used.add(path.toLowerCase());
          const entry = new ZipPassThrough(path);
          zip.add(entry);
          const stream = await this.storage.store.get(r.storage_key);
          for await (const chunk of stream) entry.push(new Uint8Array(chunk as Buffer));
          entry.push(new Uint8Array(0), true);
          manifest.push([path, r.original_name, r.sha256, r.version, r.is_current, r.slot_status, r.approved_date, r.uploaded_at.toISOString()].map(csvCell).join(','));
          i++;
          if (i % 20 === 0) await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'running', ${i / included.length}::numeric, NULL, NULL, NULL, NULL)`);
        }
        for (const r of skipped) {
          manifest.push(['', r.original_name, r.sha256, r.version, r.is_current, r.slot_status, r.approved_date, r.uploaded_at.toISOString()].map(csvCell).join(',') + ',' + csvCell('left out: waits for the virus scan'));
        }
        const m = new ZipPassThrough('manifest.csv');
        zip.add(m);
        m.push(new Uint8Array(Buffer.from('﻿' + manifest.join('\r\n') + '\r\n', 'utf8')), true);
        zip.end();
        await done;
        if (zipError) throw zipError;
        const size = (await fs.stat(tmp as string)).size;
        key = newObjectKey('exports');
        await this.storage.store.putFile(key, tmp as string, size);
        await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'done', 1, ${included.length}::int, ${size}::bigint, ${key}::text, NULL)`);
        if (skipped.length > 0) {
          await this.db.tx.$executeRaw(Prisma.sql`SELECT log_audit_write('document_zip_skipped_unscanned', 'document_zip_export', ${jobId}::text, NULL,
            ${JSON.stringify({ skipped_file_ids: skipped.map((r) => r.id) })}::jsonb, 'Q195: files that wait for the virus scan are left out of a zip')`);
        }
        return included.length;
      });
      void result;
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      if (key) await this.storage.store.remove(key).catch(() => undefined);
      await this.inContext(userId, admin, async () => {
        await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'failed', NULL, NULL, NULL, NULL, ${msg.slice(0, 300)}::text)`);
      }).catch(() => undefined);
      await this.syslog.write('error', 'zip export failed', { job_id: jobId, error: msg });
    } finally {
      if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async job(rawId: string): Promise<JobDto> {
    if (!uuidSchema.safeParse(rawId).success) throw problems.notFound('The job does not exist.');
    const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT * FROM document_export_jobs WHERE id = ${rawId}::uuid`);
    if (!rows[0]) throw problems.notFound('The job does not exist.');
    return this.toDto(rows[0]);
  }

  async download(auth: AuthContext, rawId: string): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    await this.docs.downloadRegions();
    if (!uuidSchema.safeParse(rawId).success) throw problems.notFound('The export does not exist.');
    const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT * FROM document_export_jobs WHERE id = ${rawId}::uuid`);
    const j = rows[0];
    if (!j || j.scope?.kind) throw problems.notFound('The export does not exist.');
    if (j.status !== 'done' || !j.storage_key) throw new ProblemException(409, 'invalid_transition', { detail: `The export is ${j.status}.` });
    if (j.expires_at && j.expires_at.getTime() < Date.now()) throw new ProblemException(410, 'export_expired', { detail: 'The export has expired: start it again.' });
    const name = `GSDN_Documents_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
    await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_audit('document_zip_download', 'document_zip_export', ${j.id}::text, NULL, NULL,
      ${JSON.stringify({ export_id: j.id, download_name: name, file_count: j.file_count, size_bytes: j.size_bytes === null ? null : Number(j.size_bytes) })}::jsonb)`);
    void auth;
    return {
      file: new StreamableFile(await this.storage.store.get(j.storage_key), { type: 'application/zip', disposition: attachmentHeader(name), length: Number(j.size_bytes) }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }
}
