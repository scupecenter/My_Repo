import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/auth.types';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { JobRunsService } from '../logs/job-runs.service';
import { RegistersService } from '../registers/registers.service';
import { extractText } from './text-extract';
import { StorageService } from './storage.service';

export const TEXT_INDEX_EVERY_MS = 5 * 60 * 1000;
export const TEXT_INDEX_BATCH = 20;

interface Pending { file_id: string; storage_key: string; original_name: string; mime_type: string; size_bytes: bigint | number }

/**
 * Indexing of document contents for global search (item 12, contract 0.15.104). It runs off the request path, so an upload is never slower:
 * a timer takes the current, clean-scan files that have no text yet (new uploads and the backfill of old files are the same query), reads their bytes
 * (read only) and writes the text through the definer door document_text_put. Nothing else is written; files are never changed.
 * Runs only when JOBS_ENABLED is on. Each run is a job_runs row.
 */
@Injectable()
export class DocumentTextService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('DocumentText');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly storage: StorageService,
    private readonly db: DbService,
    private readonly runs: JobRunsService,
    private readonly registers: RegistersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    this.timer = setInterval(() => { void this.indexBatch().catch((e: unknown) => this.log.warn(`document_text failed: ${e instanceof Error ? e.message : 'error'}`)); }, TEXT_INDEX_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One batch. Returns how many files were indexed and how many ended in a failure status. Skips quietly when nothing is pending. */
  async indexBatch(limit = TEXT_INDEX_BATCH): Promise<{ done: number; failed: number }> {
    if (this.busy) return { done: 0, failed: 0 };
    this.busy = true;
    try {
      const rows = await this.db.client.$queryRaw<Pending[]>(Prisma.sql`SELECT * FROM document_text_pending(${limit}::int)`);
      if (rows.length === 0) return { done: 0, failed: 0 };
      const id = await this.runs.start('document_text_index');
      let done = 0, failed = 0;
      for (const r of rows) {
        let res: { status: string; text: string };
        try {
          const bytes = await this.storage.store.readPlain(r.storage_key);
          res = await extractText(bytes, r.original_name, r.mime_type);
        } catch {
          res = { status: 'failed', text: '' };
        }
        await this.db.client.$executeRaw(Prisma.sql`SELECT document_text_put(${r.file_id}::uuid, ${res.status}::text, ${res.text}::text)`);
        if (res.status === 'failed') failed++; else done++;
      }
      await this.runs.finish(id, failed > 0 ? 'failed' : 'ok', done, failed > 0 ? `${failed} file(s) could not be read for indexing` : null, { indexed: done, failed });
      return { done, failed };
    } finally {
      this.busy = false;
    }
  }

  /** Settings > Documents > Search index (System Admin only; the SQL door checks). */
  status(auth: AuthContext): Promise<Record<string, unknown>> {
    return this.registers.call<Record<string, unknown>>(auth, Prisma.sql`SELECT document_text_status_json() AS r`);
  }
}
