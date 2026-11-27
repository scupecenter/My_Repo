import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Zip, ZipPassThrough } from 'fflate';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { pgInfo } from '../common/db-errors';
import { ProblemException } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { attachmentHeader } from '../documents/naming';
import { newObjectKey, StorageService } from '../documents/storage.service';
import { MasterExportService } from '../exports/master-export.service';
import { applyContext, type RequestContext } from '../logs/context';

type Json = Record<string, unknown>;
interface Sel { records: { id: string; entity_id: string; register_key: string }[]; files: { storage_key: string; name: string }[] }

/**
 * Contract 0.15.266 (migration 0371, Data entry proposal P2): the archive of a project data reset, made before the delete. A zip with the records of every register as an
 * .xlsx on the current template (so a restore is the template upload again, rows entering L1 then L2) and the stored files. The database doors decide who may make
 * and download it (System Admin, requester or approver, step-up) and write the security-log entry of each download; the API does what only it can: build and store the file.
 */
@Injectable()
export class DataResetArchiveService {
  private readonly log = new Logger('DataResetArchive');
  readonly running = new Set<Promise<void>>();

  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly storage: StorageService,
    private readonly master: MasterExportService,
  ) {}

  private async one(sql: Prisma.Sql): Promise<Json> {
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(sql);
    return rows[0]?.r ?? {};
  }

  /** Starts the archive of an approved request; the build runs after this request has committed and the dialog polls the request. */
  async make(auth: AuthContext, rawId: string): Promise<Json> {
    const id = parse(uuidSchema, rawId);
    await this.stepUp.require(auth);
    const sel = await this.one(Prisma.sql`SELECT admin_data_reset_archive_begin(${id}::uuid) AS r`) as unknown as Sel & { archive_id: string };
    const rc = this.db.requestContext;
    if (!rc?.userId) throw new Error('data reset archive: no request context');
    const job = this.build(sel.archive_id, sel, auth, rc).catch((e) => this.log.error(`archive ${sel.archive_id}: ${e instanceof Error ? e.message : 'failed'}`));
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
    return this.one(Prisma.sql`SELECT data_reset_request_get(${id}::uuid) AS r`);
  }

  private side<T>(rc: RequestContext, fn: () => Promise<T>, timeout = 60_000): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      await applyContext(tx, rc);
      return this.db.runIn(tx, fn, rc);
    }, { maxWait: 10_000, timeout });
  }

  private async build(archiveId: string, sel: Sel, auth: AuthContext, rc: RequestContext): Promise<void> {
    await new Promise((r) => setTimeout(r, 50)); // the archive row the door wrote commits first
    const xlsx = join(tmpdir(), `pmis-reset-archive-${archiveId}.xlsx`);
    const zipPath = join(tmpdir(), `pmis-reset-archive-${archiveId}.zip`);
    let key: string | null = null;
    try {
      const byRegister = new Map<string, Set<string>>();
      for (const r of sel.records) {
        if (!byRegister.has(r.register_key)) byRegister.set(r.register_key, new Set());
        byRegister.get(r.register_key)?.add(String(r.entity_id));
      }
      const counts = await this.side(rc, () => this.master.archiveRegisters(auth, xlsx, byRegister), 600_000);
      const out = createWriteStream(zipPath, { mode: 0o600 });
      const done = new Promise<void>((res, rej) => { out.on('finish', res); out.on('error', rej); });
      let zipError: Error | null = null;
      const zip = new Zip((err, chunk, final) => {
        if (err) { zipError = err; return; }
        out.write(Buffer.from(chunk));
        if (final) out.end();
      });
      const sheet = new ZipPassThrough('records.xlsx');
      zip.add(sheet);
      for await (const chunk of createReadStream(xlsx)) sheet.push(new Uint8Array(chunk as Buffer));
      sheet.push(new Uint8Array(0), true);
      const used = new Set<string>();
      const manifest = ['path,original_name,storage_key,state'];
      const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
      let bytesFiles = 0;
      for (const f of sel.files) {
        const base = (f.name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
        let path = `files/${base}`;
        for (let n = 2; used.has(path.toLowerCase()); n++) path = `files/${n}_${base}`;
        used.add(path.toLowerCase());
        try {
          const stream = await this.storage.store.get(f.storage_key);
          const entry = new ZipPassThrough(path);
          zip.add(entry);
          for await (const chunk of stream) { bytesFiles += (chunk as Buffer).length; entry.push(new Uint8Array(chunk as Buffer)); }
          entry.push(new Uint8Array(0), true);
          manifest.push([q(path), q(f.name), q(f.storage_key), 'included'].join(','));
        } catch (e) {
          manifest.push([q(''), q(f.name), q(f.storage_key), q(`missing: ${e instanceof Error ? e.message.slice(0, 80) : 'unreadable'}`)].join(','));
        }
      }
      const m = new ZipPassThrough('manifest.csv');
      zip.add(m);
      m.push(new Uint8Array(Buffer.from('\ufeff' + manifest.join('\r\n') + '\r\n', 'utf8')), true);
      zip.end();
      await done;
      if (zipError) throw zipError;
      const size = (await fs.stat(zipPath)).size;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(zipPath)) hash.update(chunk as Buffer);
      key = newObjectKey('exports');
      // generated from database values and the already scanned store: kept encrypted, not sent to the virus scanner again (as the other exports)
      await this.storage.store.putFile(key, zipPath, size);
      const entries = { registers: counts.map((c) => ({ register: c.sheet, rows: c.rows })), records: sel.records.length, files: sel.files.length, files_bytes: bytesFiles };
      await this.side(rc, () => this.one(Prisma.sql`SELECT admin_data_reset_archive_done(${archiveId}::uuid, ${key}::text, ${hash.digest('hex')}::text, ${size}::bigint, ${JSON.stringify(entries)}::jsonb, NULL) AS r`));
    } catch (e) {
      if (key) await this.storage.store.remove(key).catch(() => undefined);
      const msg = (pgInfo(e)?.message ?? (e instanceof Error ? e.message : 'unknown error')).replace(/\s+/g, ' ').slice(0, 500);
      await this.side(rc, () => this.one(Prisma.sql`SELECT admin_data_reset_archive_done(${archiveId}::uuid, NULL, NULL, NULL, NULL, ${msg}::text) AS r`))
        .catch((e2) => this.log.error(`archive ${archiveId}: the failure could not be recorded: ${e2 instanceof Error ? e2.message : 'unknown'}`));
    } finally {
      await fs.rm(xlsx, { force: true }).catch(() => undefined);
      await fs.rm(zipPath, { force: true }).catch(() => undefined);
    }
  }

  /** The download: System Admin with a step-up; the database writes the security-log entry, then the stored zip is streamed. */
  async download(auth: AuthContext, rawId: string): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    const id = parse(uuidSchema, rawId);
    await this.stepUp.require(auth);
    const r = await this.one(Prisma.sql`SELECT admin_data_reset_archive_download(${id}::uuid) AS r`);
    const key = String(r.storage_key ?? '');
    if (!key) throw new ProblemException(404, 'not_found', { detail: 'The archive is not stored.' });
    const name = `GSDN_DataReset_Archive_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
    return {
      file: new StreamableFile(await this.storage.store.get(key), { type: 'application/zip', disposition: attachmentHeader(name), length: Number(r.bytes) }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }

  /** Archives past their keep date: the stored object goes, then the row is marked purged. Lazy: runs when the reset page is read. */
  async purgeDue(): Promise<void> {
    const due = await this.one(Prisma.sql`SELECT admin_data_reset_archive_due() AS r`) as unknown as Json[] | Json;
    const list = Array.isArray(due) ? due : [];
    for (const d of list) {
      await this.storage.store.remove(String(d.storage_key)).catch(() => undefined);
      await this.db.tx.$executeRaw(Prisma.sql`SELECT admin_data_reset_archive_purged(${String(d.archive_id)}::uuid)`);
    }
  }
}
