import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { ProblemException, problems } from '../common/problem';
import { Query, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, Tx } from '../db/db.service';
import { nextRunAt } from '../jobs/jobs.service';
import { applyContext, jobContext } from './context';

export type LogName = 'audit' | 'security';
/** Positions checked per step (one transaction each), so a large chain never holds one long transaction. */
export const STEP_ROWS = 20_000;
/** The nightly check runs at 03:00 project time (after the daily job at 02:00). */
export const INTEGRITY_HOUR = 3;

interface RunRow {
  id: string; job_run_id: string | null; log: LogName; trigger: 'nightly' | 'manual'; requested_by: string | null; started_text: string; finished_text: string | null;
  status: 'running' | 'ok' | 'broken' | 'failed'; from_seq: bigint; to_seq: bigint; checked_through: bigint; row_count: bigint; break_count: number; breaks: unknown[];
  head_hash: string | null; anchor_check: Record<string, unknown> | null; anchor_ref: string | null; error: string | null;
}

const COLS = Prisma.sql`r.id::text AS id, r.job_run_id::text AS job_run_id, r.log, r.trigger, r.requested_by::text AS requested_by, log_ts_text(r.started_at) AS started_text,
  log_ts_text(r.finished_at) AS finished_text, r.status, r.from_seq, r.to_seq, r.checked_through, r.row_count, r.break_count, r.breaks, r.head_hash, r.anchor_check, r.anchor_ref, r.error`;

const startBody = z.object({ log: z.enum(['audit', 'security']) }).strict();

export function runDto(r: RunRow) {
  const from = Number(r.from_seq), to = Number(r.to_seq), done = Number(r.checked_through);
  return {
    id: r.id, log: r.log, trigger: r.trigger, status: r.status, started_at: r.started_text, finished_at: r.finished_text, requested_by: r.requested_by,
    from_seq: from, to_seq: to, checked_through: done, row_count: Number(r.row_count),
    progress: to < from ? 100 : Math.min(100, Math.floor((100 * (done - from + 1)) / (to - from + 1))),
    break_count: r.break_count, breaks: r.breaks, head_hash: r.head_hash?.trim() ?? null, anchor_check: r.anchor_check, anchor_ref: r.anchor_ref, error: r.error,
    job_run_id: r.job_run_id,
  };
}

/**
 * Q171 (migration 0055): the integrity check of the Audit Log and the security log as a monitored job. Nightly at 03:00 Africa/Tripoli (JOBS_ENABLED)
 * for both chains, or on demand by a System Admin (`POST /admin/log-integrity/runs`). Each run is a job_runs row `audit_integrity_check` whose detail
 * carries the progress; the database checks the chain in steps of STEP_ROWS positions, stores the result (range, head, breaks) and raises the mandatory
 * alert `audit_integrity_failure` on a break. The head of every finished run is appended to an anchor file outside the database (LOG_ANCHOR_DIR, one
 * JSON line per run, each line carrying the hash of the line before it); the next run checks that the chain still holds the last anchored hash, which a
 * rewrite of the whole chain with database superuser rights cannot keep unless the file was changed too (keep a copy off the server).
 */
@Injectable()
export class IntegrityService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Integrity');
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly db: DbService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get anchorDir(): string {
    return resolve(this.config.anchorDir ?? join(this.config.storage.localDir, '..', 'log-anchors'));
  }

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]).catch(() => undefined);
  }

  private schedule(): void {
    if (this.stopped) return;
    const at = nextRunAt(new Date(), 'Africa/Tripoli', INTEGRITY_HOUR);
    this.timer = setTimeout(() => {
      void this.nightly().finally(() => this.schedule());
    }, Math.max(1_000, at.getTime() - Date.now()));
    this.timer.unref();
  }

  /** Both chains, one after the other. Never throws; answers the finished runs. */
  async nightly(): Promise<ReturnType<typeof runDto>[]> {
    const out: ReturnType<typeof runDto>[] = [];
    for (const l of ['audit', 'security'] as const) {
      try {
        const run = await this.inJob((tx) => this.startRow(tx, l, 'nightly'));
        out.push(await this.drive(run.id, (fn) => this.inJob(fn)));
      } catch (e) {
        this.log.warn(`nightly integrity check of the ${l} log failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
      }
    }
    return out;
  }

  private inJob<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      await applyContext(tx, jobContext('audit_integrity_check'));
      return fn(tx);
    }, { maxWait: 10_000, timeout: 300_000 });
  }

  private inAdmin<T>(userId: string, sessionId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true), set_config('app.region_ids', '*', true)`;
      await tx.$queryRaw`SELECT set_config('app.session_id', ${sessionId}, true), set_config('app.via', 'job', true), set_config('app.job_name', 'audit_integrity_check', true)`;
      return fn(tx);
    }, { maxWait: 10_000, timeout: 300_000 });
  }

  private async startRow(tx: Tx, l: LogName, trigger: 'nightly' | 'manual'): Promise<RunRow> {
    return (await tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${COLS} FROM log_integrity_start(${l}::text, ${trigger}::text) r`))[0]!;
  }

  /** Steps the run to its end, finishes it with the previous anchor and appends the new one. Each call of `inTx` is one transaction. */
  private async drive(id: string, inTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>): Promise<ReturnType<typeof runDto>> {
    try {
      let r: RunRow;
      do {
        r = await inTx(async (tx) => (await tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${COLS} FROM log_integrity_step(${id}::uuid, ${STEP_ROWS}::int) r`))[0]!);
      } while (r.status === 'running' && r.checked_through < r.to_seq);
      const prev = await this.lastAnchor(r.log);
      r = await inTx(async (tx) => (await tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${COLS} FROM log_integrity_finish(${id}::uuid, ${prev ? JSON.stringify(prev) : null}::jsonb) r`))[0]!);
      if (r.status !== 'failed' && r.head_hash && Number(r.to_seq) > 0) {
        try {
          const ref = await this.appendAnchor(r);
          await inTx((tx) => tx.$executeRaw(Prisma.sql`SELECT log_integrity_set_anchor(${id}::uuid, ${ref}::text)`));
          r.anchor_ref = ref;
        } catch (e) {
          this.log.warn(`anchor not written: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
        }
      }
      return runDto(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      await inTx((tx) => tx.$executeRaw(Prisma.sql`SELECT log_integrity_fail(${id}::uuid, ${msg.slice(0, 300)}::text)`)).catch(() => undefined);
      throw e;
    }
  }

  private file(l: LogName): string {
    return join(this.anchorDir, `anchor-${l}.jsonl`);
  }

  /** The last line of the anchor file of the log: { seq, hash, ref }, or null when there is none. */
  async lastAnchor(l: LogName): Promise<{ seq: number; hash: string; ref: string } | null> {
    let text: string;
    try {
      text = await readFile(this.file(l), 'utf8');
    } catch {
      return null;
    }
    const lines = text.split('\n').filter((x) => x.trim() !== '');
    const last = lines[lines.length - 1];
    if (!last) return null;
    try {
      const j = JSON.parse(last) as { seq?: unknown; hash?: unknown };
      if (typeof j.seq !== 'number' || typeof j.hash !== 'string') return null;
      return { seq: j.seq, hash: j.hash, ref: `anchor-${l}.jsonl#${lines.length}:${sha(last).slice(0, 16)}` };
    } catch {
      return null;
    }
  }

  private async appendAnchor(r: RunRow): Promise<string> {
    await mkdir(this.anchorDir, { recursive: true, mode: 0o750 });
    let text = '';
    try {
      text = await readFile(this.file(r.log), 'utf8');
    } catch {
      /* first line */
    }
    const lines = text.split('\n').filter((x) => x.trim() !== '');
    const line = JSON.stringify({ log: r.log, seq: Number(r.to_seq), hash: r.head_hash?.trim(), run_id: r.id, status: r.status, at: new Date().toISOString(),
      prev_line_sha256: lines.length ? sha(lines[lines.length - 1] as string) : null });
    await appendFile(this.file(r.log), `${line}\n`, { encoding: 'utf8', mode: 0o640 });
    return `anchor-${r.log}.jsonl#${lines.length + 1}:${sha(line).slice(0, 16)}`;
  }

  // ------------------------------------------------------------------ endpoints
  /** POST /admin/log-integrity/runs: starts a check (System Admin); the steps run after the response is sent. */
  async startManual(auth: AuthContext, raw: unknown, onSent: (go: () => void) => void) {
    if (!auth.state.isAdmin) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin can check the log integrity.' });
    const { log } = parse(startBody, raw);
    const r = await this.startRow(this.db.tx, log, 'manual');
    const user = auth.user.id, session = auth.session.id;
    onSent(() => {
      const p = this.drive(r.id, (fn) => this.inAdmin(user, session, fn))
        .catch((e) => this.log.warn(`integrity check ${r.id}: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`))
        .finally(() => this.running.delete(p));
      this.running.add(p);
    });
    return runDto(r);
  }

  async list(q: Query) {
    const limit = parseLimit(q.limit);
    const l = oneParam(q, 'log');
    if (l && l !== 'audit' && l !== 'security') throw problems.validation([{ path: '/log', code: 'invalid', message: 'log is audit or security.' }]);
    const c = decodeCursor(oneParam(q, 'cursor'), 2);
    if (c && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(c[0] as string) || !uuidSchema.safeParse(c[1]).success)) throw problems.badRequest('The cursor is not valid.');
    const f = { ...(l ? { log: l } : {}), ...(c ? { cursor_at: c[0], cursor_id: c[1] } : {}) };
    const rows = await this.db.tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${COLS} FROM log_integrity_runs_read(${JSON.stringify(f)}::jsonb, ${limit + 1}::int) r`);
    const items = rows.slice(0, limit).map(runDto);
    const last = items[items.length - 1];
    return { items, page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.started_at, last.id]) : null } };
  }

  async get(id: string) {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The integrity check does not exist.');
    const rows = await this.db.tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${COLS} FROM log_integrity_runs_read(${JSON.stringify({ id })}::jsonb, 1) r`);
    if (!rows[0]) throw problems.notFound('The integrity check does not exist.');
    return runDto(rows[0]);
  }
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
