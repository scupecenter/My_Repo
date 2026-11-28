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
import { applyContext } from '../logs/context';
import { SyslogService } from '../auth/syslog.service';
import { DocumentsService, SITE_DOCS } from './documents.service';
import { archiveName, attachmentHeader, displayName, safePart } from './naming';
import { StorageService, newObjectKey } from './storage.service';

const body = z
  .object({
    site_id: z.guid().optional(),
    stage_code: z.string().trim().min(1).max(20).optional(),
    doc_code: z.string().trim().min(1).max(40).optional(),
    file_ids: z.array(z.guid()).min(1).max(5000).optional(),
    slot_status: z.enum(['uploaded', 'in_review', 'approved', 'rejected']).optional(),
    include_superseded: z.boolean().optional(),
    /** Library Archive zip: `DocType_SiteID_Number_vN.ext` in a folder per document type (set by the server route, never by the client). */
    naming: z.enum(['archive']).optional(),
    /** Field mode phase 4: the consolidated site acceptance pack. Needs `site_id`; carries only the approved current PAC, FAC and HOTO files, one folder per document type, with an index. */
    pack: z.enum(['acceptance']).optional(),
  })
  .strict();
type Scope = z.infer<typeof body>;

export interface JobDto {
  id: string;
  kind: 'zip_export' | 'audit_export' | 'security_export' | 'master_export';
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
  scope: Scope & { kind?: 'audit_export' | 'security_export' | 'master_export'; filters?: unknown };
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
        download_path: kind === 'master_export' ? `/exports/master/${j.id}/download` : `/${kind === 'audit_export' ? 'audit-log' : 'security-log'}/exports/${j.id}/download` };
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
    if (scope.pack === 'acceptance') {
      conds.push(Prisma.sql`dt.code ~ '(^|[_-])(PAC|FAC|HOTO)([_-]|$)'`);
      conds.push(Prisma.sql`s.status::text = 'approved'`);
    }
    conds.push(registerScope);
    return conds;
  }

  async start(auth: AuthContext, raw: unknown, idemKey: string | undefined, onStarted: (fn: () => void) => void): Promise<JobDto> {
    const regions = await this.docs.downloadRegions();
    const scope = parse(body, raw);
    if (scope.pack && (!scope.site_id || scope.file_ids || scope.include_superseded || scope.slot_status || scope.doc_code || scope.stage_code || scope.naming)) {
      throw problems.validation([{ path: '/pack', code: 'pack_scope', message: 'The acceptance pack is made for one site, with no other filter.' }]);
    }
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
        // The requester's rights are derived by the database (app_begin); `admin` is no longer sent.
        void admin;
        await applyContext(tx, { ip: null, userAgent: null, requestId: null, userId });
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
          site_code: string; task_code: string | null; doc_code: string; candidate_label: string | null; stage_code: string | null; slot_status: string; doc_number: string | null;
        }[]>(Prisma.sql`
          SELECT f.id::text AS id, f.original_name, f.storage_key, f.ext, f.version, f.is_current, f.sha256, f.size_bytes, f.uploaded_at, f.approved_date::text AS approved_date,
            coalesce(si.site_code, 'GLOBAL') AS site_code, coalesce(td.code, upper(s.register_key)) AS task_code, dt.code AS doc_code, s.candidate_label, st.code AS stage_code, s.status::text AS slot_status,
            (SELECT g.number FROM library_generated_docs g WHERE s.task_id IS NOT NULL AND g.task_id = s.task_id AND g.doc_type_id = s.doc_type_id AND g.status = 'generated' ORDER BY g.generated_at DESC LIMIT 1) AS doc_number
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
        // 0474: the signed and stamped markers (0555) of each file, as the last two columns of the index
        const marks = (await this.db.tx.$queryRaw<{ j: Record<string, { signed?: boolean; stamped?: boolean }> }[]>(Prisma.sql`SELECT doc_file_marks(${rows.map((r) => r.id)}::uuid[]) AS j`))[0]?.j ?? {};
        const mk = (id: string): string => `${csvCell(marks[id]?.signed === true ? 'yes' : 'no')},${csvCell(marks[id]?.stamped === true ? 'yes' : 'no')}`;
        const used = new Set<string>();
        const manifest = [['path', 'original_name', 'sha256', 'version', 'is_current', 'slot_status', 'approved_date', 'uploaded_at', 'signed', 'stamped'].map(csvCell).join(',')];
        let i = 0;
        for (const r of included) {
          const archive = job.scope.naming === 'archive';
          const name = archive ? archiveName({ doc_code: r.doc_code, site_code: r.site_code, doc_number: r.doc_number, version: r.version, ext: r.ext ?? 'bin' }) : displayName({ site_code: r.site_code, task_code: r.task_code, doc_code: r.doc_code, candidate_label: r.candidate_label, approved_date: r.approved_date, uploaded_at: r.uploaded_at, ext: r.ext ?? 'bin', version: r.version, is_current: r.is_current });
          const folder = archive || job.scope.pack ? safePart(r.doc_code) : `${safePart(r.site_code)}/${safePart(r.stage_code ?? 'NA')}`;
          let path = `${folder}/${name}`;
          for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${name.replace(/(\.[a-z0-9]+)$/, `_${n}$1`)}`;
          used.add(path.toLowerCase());
          const entry = new ZipPassThrough(path);
          zip.add(entry);
          const stream = await this.storage.store.get(r.storage_key);
          for await (const chunk of stream) entry.push(new Uint8Array(chunk as Buffer));
          entry.push(new Uint8Array(0), true);
          manifest.push([path, r.original_name, r.sha256, r.version, r.is_current, r.slot_status, r.approved_date, r.uploaded_at.toISOString()].map(csvCell).join(',') + ',' + mk(r.id));
          i++;
          if (i % 20 === 0) await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${jobId}::uuid, 'running', ${i / included.length}::numeric, NULL, NULL, NULL, NULL)`);
        }
        for (const r of skipped) {
          manifest.push(['', r.original_name, r.sha256, r.version, r.is_current, r.slot_status, r.approved_date, r.uploaded_at.toISOString()].map(csvCell).join(',') + ',' + mk(r.id) + ',' + csvCell('left out: waits for the virus scan'));
        }
        if (job.scope.pack === 'acceptance') {
          // the index of the pack, in English and Arabic: the site, the date, and the number of files per document type
          const per = new Map<string, number>();
          for (const r of included) per.set(r.doc_code, (per.get(r.doc_code) ?? 0) + 1);
          const day = new Date().toISOString().slice(0, 10);
          const lines = [
            `Site acceptance pack / حزمة قبول الموقع`, `Site / الموقع: ${included[0]!.site_code}`, `Date / التاريخ: ${day}`, `Files / الملفات: ${included.length}`, '',
            ...[...per.entries()].map(([code, n]) => `${code}: ${n}`), '',
            'Only approved, current files are included. The file list with checksums is in manifest.csv.',
            'تشمل الحزمة الملفات المعتمدة والحالية فقط. قائمة الملفات مع بصمة كل ملف في manifest.csv.',
          ];
          const ix = new ZipPassThrough('INDEX.txt');
          zip.add(ix);
          ix.push(new Uint8Array(Buffer.from('\ufeff' + lines.join('\r\n') + '\r\n', 'utf8')), true);
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
