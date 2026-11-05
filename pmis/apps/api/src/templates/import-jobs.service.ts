import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { DocumentsService } from '../documents/documents.service';
import { applyContext, jobContext } from '../logs/context';
import { JobRunsService } from '../logs/job-runs.service';

/**
 * Rows per chunk of a New sites batch: each chunk is one transaction, about 2 s for 25 New Build sites (migration 0074), far below the 30 s request limit.
 * Since 0075 the database chooses the size by the kind of batch when the API passes none (imp_async_chunk_size: New sites 25, register rows 50, stream rows 25).
 */
export const IMPORT_CHUNK_ROWS = 25;
/** The limit of one chunk transaction (a chunk normally takes a few seconds). */
export const IMPORT_CHUNK_TIMEOUT_MS = 120_000;
/** How often the resume job looks for batches left in `processing` (an API restart, a lost process). */
export const IMPORT_RESUME_EVERY_MS = 2 * 60_000;
/** A run is resumed by the job when nothing happened for this long (a run of this process is never taken twice). */
export const IMPORT_RESUME_IDLE_S = 60;
/** Consecutive chunk failures (not row failures, which are recorded on the row) after which the run is stopped. */
export const IMPORT_MAX_CHUNK_FAILURES = 3;

export interface PendingJob {
  job_id: string;
  batch_id: string;
  actor_id: string;
  actor_active: boolean;
  stepup_until: Date | null;
  session_id: string | null;
  auth_method: string | null;
  mfa: boolean | null;
  request_id: string | null;
}

export interface JobProgress {
  job_id?: string;
  state: 'running' | 'done' | 'failed' | 'busy';
  rows_total?: number;
  rows_done?: number;
}

/**
 * The background run of a big batch: New sites (migration 0074), register and stream batches (0075; technical decisions of 2026-11-05).
 *
 * The request (POST submit / decisions) checks everything and records the run in the request transaction (imp_async_start), then answers 202. This service
 * does the rows: chunk after chunk, each in its own transaction (never the request transaction, which Prisma ends after 30 s), under a newly signed
 * context of the same person (app_begin: the database checks again that the person is active and derives their regions and rights from its data). The
 * step-up is the one the database verified and stored at the request; the API only repeats its expiry in the context, for the audit rows.
 * After a restart, the resume job (every 2 minutes and once at start-up, when JOBS_ENABLED is on; recorded in job_runs as `import_batch_resume`) takes
 * the runs left in `processing`.
 */
@Injectable()
export class ImportJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('ImportJobs');
  private readonly inflight = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  /** Tests switch it off to simulate a process that stops after the request (the resume job then finishes the run). */
  autoStart = true;

  constructor(
    private readonly db: DbService,
    private readonly runs: JobRunsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly documents: DocumentsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    const t = setInterval(() => void this.resumeAll(IMPORT_RESUME_IDLE_S), IMPORT_RESUME_EVERY_MS);
    t.unref();
    this.timers.push(t);
    // after a restart: the runs this process was doing are idle now
    const s = setTimeout(() => void this.resumeAll(0), 10_000);
    s.unref();
    this.timers.push(s);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Called after the request that asked for the run: starts it once the request transaction is committed (the run is visible). */
  kick(jobId: string): void {
    if (!this.autoStart || this.stopped) return;
    const t = setTimeout(() => void this.runWhenVisible(jobId, 0), 50);
    t.unref();
  }

  /**
   * 0075: several runs asked by one request (the batches of a Master import apply) are done one after the other, never at the same time, so that two chunks
   * never update the same sites concurrently.
   */
  kickInOrder(jobIds: string[]): void {
    if (!this.autoStart || this.stopped || jobIds.length === 0) return;
    const run = async (): Promise<void> => {
      for (const id of jobIds) {
        if (this.stopped) return;
        await this.runWhenVisibleAwait(id);
      }
    };
    const t = setTimeout(() => void run(), 50);
    t.unref();
  }

  /** As runWhenVisible, but resolves when the run ended (or never became visible). */
  private async runWhenVisibleAwait(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 40 && !this.stopped; attempt++) {
      const job = (await this.pending(0)).find((j) => j.job_id === jobId);
      if (job) {
        await this.process(job);
        return;
      }
      await new Promise((r) => setTimeout(r, 250).unref());
    }
  }

  /** Resolves when no run of this process is active (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()]);
  }

  private async runWhenVisible(jobId: string, attempt: number): Promise<void> {
    const job = (await this.pending(0)).find((j) => j.job_id === jobId);
    if (!job) {
      // the request transaction may not be committed yet; a run that never appears was refused or rolled back
      if (attempt < 40 && !this.stopped) {
        const t = setTimeout(() => void this.runWhenVisible(jobId, attempt + 1), 250);
        t.unref();
      }
      return;
    }
    await this.process(job);
  }

  /** The runs left in processing for at least `idleSeconds` (0: every running one). Read without a person (job context). */
  async pending(idleSeconds: number): Promise<PendingJob[]> {
    try {
      return await this.db.client.$transaction(async (tx) => {
        await applyContext(tx, jobContext('import_batch_resume'));
        return tx.$queryRaw<PendingJob[]>(Prisma.sql`
          SELECT job_id::text AS job_id, batch_id::text AS batch_id, actor_id::text AS actor_id, actor_active, stepup_until, session_id::text AS session_id, auth_method, mfa, request_id
          FROM imp_async_pending(${idleSeconds}::int)`);
      });
    } catch (e) {
      this.log.warn(`reading the pending runs failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
      return [];
    }
  }

  /** The resume job: every run left in processing that this process is not doing. Returns how many runs it took. */
  async resumeAll(idleSeconds: number = IMPORT_RESUME_IDLE_S): Promise<number> {
    const jobs = (await this.pending(idleSeconds)).filter((j) => !this.inflight.has(j.job_id));
    if (jobs.length === 0) return 0;
    const runId = await this.runs.start('import_batch_resume');
    let failed = 0;
    for (const j of jobs) {
      try {
        await this.process(j);
      } catch {
        failed += 1;
      }
    }
    await this.runs.finish(runId, failed ? 'failed' : 'ok', jobs.length, failed ? `${failed} run(s) could not be resumed` : null, { jobs: jobs.map((j) => j.job_id) });
    return jobs.length;
  }

  /** Does the run to its end (or until another process holds it). One run at a time per job in this process. */
  process(job: PendingJob): Promise<void> {
    const cur = this.inflight.get(job.job_id);
    if (cur) return cur;
    const p = this.loop(job).finally(() => this.inflight.delete(job.job_id));
    this.inflight.set(job.job_id, p);
    return p;
  }

  /**
   * One chunk, in its own transaction under the person's signed context. Exposed for the tests (a run interrupted after one chunk). `chunk` overrides the size
   * the database chooses for the kind of batch. For a stream send, the document slots of the chunk's tasks are synchronised first, in the same transaction
   * (the conditional documents that apply now are slots before the engine counts the missing ones, as the synchronous send does for all its tasks).
   */
  async step(job: PendingJob, chunk?: number): Promise<JobProgress> {
    const size = chunk ?? null;
    const ctx = this.contextOf(job);
    return this.db.client.$transaction(async (tx) => {
      await applyContext(tx, ctx);
      const tasks = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT t::text AS id FROM imp_async_chunk_tasks(${job.job_id}::uuid, ${size}::int) AS t`);
      if (tasks.length > 0) {
        await this.db.runIn(tx, async () => {
          for (const t of tasks) await this.documents.syncTaskById(t.id);
        }, ctx);
      }
      const r = await tx.$queryRaw<{ r: JobProgress }[]>(Prisma.sql`SELECT imp_async_step(${job.job_id}::uuid, ${size}::int) AS r`);
      return r[0]?.r ?? { state: 'failed' };
    }, { maxWait: 10_000, timeout: IMPORT_CHUNK_TIMEOUT_MS });
  }

  private contextOf(job: PendingJob) {
    const until = job.stepup_until ? new Date(job.stepup_until) : null;
    return {
      ...jobContext('import_batch'),
      userId: job.actor_id,
      sessionId: job.session_id,
      authMethod: (job.auth_method === 'local' || job.auth_method === 'oidc' || job.auth_method === 'break_glass' ? job.auth_method : null) as 'local' | 'oidc' | 'break_glass' | null,
      mfa: job.mfa,
      requestId: job.request_id,
      // the database decides the step-up of the run from what it stored at the request; this only labels the audit rows while it is still valid
      stepupUntil: until && until.getTime() > Date.now() ? until : null,
    };
  }

  private async loop(job: PendingJob): Promise<void> {
    if (!job.actor_active) {
      await this.abandon(job, 'The person who asked for the run can no longer act (deactivated or deleted).', false);
      return;
    }
    let failures = 0;
    while (!this.stopped) {
      try {
        const p = await this.step(job);
        failures = 0;
        if (p.state !== 'running') return;   // done, failed, or another process holds it (busy)
      } catch (e) {
        failures += 1;
        const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
        this.log.warn(`import run ${job.job_id}: chunk failed (${failures}): ${msg}`);
        if (failures >= IMPORT_MAX_CHUNK_FAILURES) {
          await this.abandon(job, `A chunk failed ${failures} times: ${msg}`.slice(0, 500), true);
          return;
        }
        await new Promise((r) => setTimeout(r, 500 * failures).unref());
      }
    }
  }

  private async abandon(job: PendingJob, reason: string, asPerson: boolean): Promise<void> {
    try {
      await this.db.client.$transaction(async (tx) => {
        await applyContext(tx, asPerson ? this.contextOf(job) : jobContext('import_batch_resume'));
        await tx.$queryRaw(Prisma.sql`SELECT imp_async_abandon(${job.job_id}::uuid, ${reason}::text) AS r`);
      });
    } catch (e) {
      this.log.warn(`import run ${job.job_id}: could not be stopped: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
    }
  }
}
