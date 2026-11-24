import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { pgInfo } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { applyContext, type RequestContext } from '../logs/context';
import { makeQuarantine, quarantineFiles } from './data-reset-files';
import { MaintenanceService } from './maintenance.service';

type Json = Record<string, unknown>;

const confirm = z.string().max(200);
const requestBody = z.object({ reason: z.string().max(2000), confirm_text: confirm }).strict();
const reasonBody = z.object({ reason: z.string().max(2000) }).strict();
const runBody = z.object({ confirm_text: confirm }).strict();
const settingsBody = z.object({ reason: z.string().max(2000), request_expiry_minutes: z.unknown(), backup_max_age_hours: z.unknown() }).passthrough();

/** How long the database part of a run may take (one transaction). */
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The project data reset in Settings (owner decisions 2026-11-24, migration 0146, contract 0.15.62). Every rule is decided by the database doors
 * (`admin_data_reset_*`): a System Admin acting without delegation, step-up, reason, the typed phrase, four eyes, the expiry, the backup precondition.
 * The API adds what only it can do: the document store (local disk only; the quarantine directory is made before the start), the run in a transaction of
 * its own (after the start has committed, as the runner in the runner's session), the maintenance mode, and the file move after the
 * commit, recorded on the request.
 */
@Injectable()
export class DataResetService {
  private readonly log = new Logger('DataReset');
  /** One file move at a time in this process (a retry never runs beside the first move). */
  private moving: Promise<void> = Promise.resolve();
  /** Background runs of this process (the tests wait for them). */
  readonly running = new Set<Promise<void>>();

  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly maintenance: MaintenanceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async one(sql: Prisma.Sql): Promise<Json> {
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(sql);
    return rows[0]?.r ?? {};
  }

  private storage(): { driver: 'local' | 's3'; supported: boolean } {
    const driver = this.config.storage.driver === 's3' ? 's3' : 'local';
    return { driver, supported: driver === 'local' };
  }

  /** If-Match with a real version: `*` is not accepted on these doors (a decision is about the request as it was read). */
  private version(ifMatch: string | undefined): number {
    const v = parseIfMatch(ifMatch);
    if (v === null) throw new ProblemException(428, 'precondition_required', { detail: 'Send the ETag of the request you read in If-Match (not *).' });
    return v;
  }

  async state(): Promise<Json> {
    const r = await this.one(Prisma.sql`SELECT data_reset_state_json() AS r`);
    return { ...r, storage: this.storage() };
  }

  get(rawId: string): Promise<Json> {
    const id = parse(uuidSchema, rawId);
    return this.one(Prisma.sql`SELECT data_reset_request_get(${id}::uuid) AS r`);
  }

  async request(auth: AuthContext, raw: unknown): Promise<Json> {
    const b = parse(requestBody, raw);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_data_reset_request(${b.reason}::text, ${b.confirm_text}::text) AS r`);
  }

  async approve(auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const id = parse(uuidSchema, rawId);
    const b = parse(reasonBody, raw);
    const v = this.version(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_data_reset_approve(${id}::uuid, ${b.reason}::text, ${v}::int) AS r`);
  }

  async cancel(auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const id = parse(uuidSchema, rawId);
    const b = parse(reasonBody, raw);
    const v = this.version(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_data_reset_cancel(${id}::uuid, ${b.reason}::text, ${v}::int) AS r`);
  }

  async setSettings(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(settingsBody, raw);
    const v = this.version(ifMatch);
    await this.stepUp.require(auth);
    const { reason, ...body } = b;
    return this.one(Prisma.sql`SELECT admin_set_data_reset_settings(${JSON.stringify(body)}::jsonb, ${reason}::text, ${v}::int) AS r`);
  }

  /**
   * Start: the checks of the database door (who, step-up, phrase, approved, not expired, backup, no reset running, the plan), the store (local disk, the
   * quarantine directory made now so a store that cannot take it refuses before anything changes). The run starts once this request has committed.
   */
  async run(auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const id = parse(uuidSchema, rawId);
    const b = parse(runBody, raw);
    const v = this.version(ifMatch);
    await this.stepUp.require(auth);
    if (!this.storage().supported) {
      throw new ProblemException(409, 'storage_not_supported', {
        detail: 'The documents are in S3/MinIO: the reset moves files on local disk only. Use the operator procedure in docs/ops/data-reset.md (Open: MinIO).',
      });
    }
    let qdir: string;
    try {
      qdir = await makeQuarantine(this.config.storage.localDir);
    } catch (e) {
      throw new ProblemException(409, 'quarantine_unavailable', {
        detail: `The quarantine directory cannot be made inside the document store: ${e instanceof Error ? e.message : 'unknown error'}. Nothing was changed.`,
      });
    }
    let r: Json;
    try {
      r = await this.one(Prisma.sql`SELECT admin_data_reset_start(${id}::uuid, ${b.confirm_text}::text, ${v}::int, ${qdir}::text) AS r`);
    } catch (e) {
      await fs.rmdir(qdir).catch(() => undefined); // the empty directory made a moment ago; nothing was moved into it
      throw e;
    }
    const rc = this.db.requestContext;
    if (!rc?.userId) throw new Error('data reset: no request context');
    const job = this.background(id, { ...rc, via: 'manual' }, qdir).catch((e) => this.log.error(`data reset ${id}: ${e instanceof Error ? e.message : 'failed'}`));
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
    return r;
  }

  /** Retry of the file move only (the database part never runs again): a System Admin, reason, step-up; the move runs once this request has committed. */
  async retryFiles(auth: AuthContext, rawId: string, raw: unknown): Promise<Json> {
    const id = parse(uuidSchema, rawId);
    const b = parse(reasonBody, raw);
    await this.stepUp.require(auth);
    if (!this.storage().supported) throw new ProblemException(409, 'storage_not_supported', { detail: 'The documents are in S3/MinIO.' });
    const claim = await this.one(Prisma.sql`SELECT admin_data_reset_files_claim(${id}::uuid, true, ${b.reason}::text) AS r`);
    const rc = this.db.requestContext;
    if (!rc?.userId) throw new Error('data reset: no request context');
    const job = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      await this.moveFiles(id, rc, claim);
    })().catch((e) => this.log.error(`data reset ${id} files: ${e instanceof Error ? e.message : 'failed'}`));
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
    return this.one(Prisma.sql`SELECT data_reset_request_get(${id}::uuid) AS r`);
  }

  /** A transaction of its own with the verified context of the request (the same user and session), as the dashboard's side reads do. */
  private side<T>(rc: RequestContext, fn: () => Promise<T>, opts: { timeout?: number } = {}): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      await applyContext(tx, rc);
      return this.db.runIn(tx, fn, rc);
    }, { maxWait: 10_000, timeout: opts.timeout ?? 30_000 });
  }

  private async background(id: string, rc: RequestContext, qdir: string): Promise<void> {
    // the start must be committed first: the run locks the request row the start wrote
    const until = Date.now() + 15_000;
    for (;;) {
      const r = await this.db.client.$queryRaw<{ m: boolean }[]>`SELECT data_reset_maintenance() AS m`;
      if (r[0]?.m) break;
      if (Date.now() > until) {
        this.log.warn(`data reset ${id}: the start did not commit`);
        await fs.rmdir(qdir).catch(() => undefined);
        return;
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    this.maintenance.begin();
    let committed = false;
    try {
      await this.maintenance.drain(15_000);
      try {
        await this.side(rc, () => this.one(Prisma.sql`SELECT admin_data_reset_execute(${id}::uuid) AS r`),
          { timeout: RUN_TIMEOUT_MS });
        committed = true;
      } catch (e) {
        const msg = (pgInfo(e)?.message ?? (e instanceof Error ? e.message : 'unknown error')).replace(/\s+/g, ' ').slice(0, 1500);
        this.log.error(`data reset ${id} rolled back: ${msg}`);
        await this.side(rc, () => this.one(Prisma.sql`SELECT admin_data_reset_fail(${id}::uuid, ${msg}::text) AS r`))
          .catch((e2) => this.log.error(`data reset ${id}: the failure could not be recorded: ${e2 instanceof Error ? e2.message : 'unknown'}`));
        await fs.rmdir(qdir).catch(() => undefined); // nothing was reset: the empty quarantine directory goes (rmdir never removes a directory with a file)
      }
    } finally {
      this.maintenance.end();
    }
    if (!committed) return;
    const claim = await this.side(rc, () => this.one(Prisma.sql`SELECT admin_data_reset_files_claim(${id}::uuid, false, NULL) AS r`)).catch(() => null);
    if (claim) await this.moveFiles(id, rc, claim);
  }

  /** Moves the pending keys into the quarantine directory and records each outcome (the request becomes completed when none is pending). */
  private moveFiles(id: string, rc: RequestContext, claim: Json): Promise<void> {
    const next = this.moving.then(async () => {
      const keys = Array.isArray(claim.keys) ? (claim.keys as string[]) : [];
      const qdir = typeof claim.quarantine_dir === 'string' ? claim.quarantine_dir : '';
      if (keys.length === 0 || !qdir) return;
      const results = await quarantineFiles(this.config.storage.localDir, qdir, keys);
      for (let i = 0; i < results.length; i += 500) {
        const chunk = results.slice(i, i + 500);
        await this.side(rc, () => this.one(Prisma.sql`SELECT admin_data_reset_files_record(${id}::uuid, ${JSON.stringify(chunk)}::jsonb) AS r`));
      }
    });
    this.moving = next.catch(() => undefined);
    return next;
  }
}
