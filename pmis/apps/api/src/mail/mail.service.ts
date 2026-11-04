import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { ProblemException, problems } from '../common/problem';
import { Query, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { APP_CONFIG, AppConfig, MailConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { applyContext, jobContext } from '../logs/context';
import { JobRunsService } from '../logs/job-runs.service';
import { SmtpError, smtpSend } from './smtp';

/** One mail. `kind` is a lower-case code (for example `identity.email_verify`); `security_alert` is reserved for the database. */
export interface MailMessage {
  kind: string;
  /** One line, at most 200 characters. */
  subject: string;
  /** Plain text, at most 20 000 characters. `{{app_url}}` is replaced by APP_BASE_URL when the mail is sent. */
  text: string;
  /** The body holds a secret (a verification link): the outbox list hides the subject and nothing of it reaches a log. */
  sensitive?: boolean;
  /** A mail with a key already queued is not queued again (the call answers null). */
  dedupKey?: string;
}

export const MAIL_EVERY_MS = 60_000;
const BATCH = 20;
const OUTCOMES = ['queued', 'retrying', 'sending', 'sent', 'dead', 'logged', 'suppressed'] as const;

const retryBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * The outbound mail service (owner answer Q167, migration 0055).
 *
 * Interface for the other modules (P8 identity uses it for the email-change verification and notices):
 *   - `sendToUser(userId, msg)`: queues a mail to an active user's registered address; null when the user has no valid address or the dedup key exists.
 *   - `sendToAddress(address, msg)`: queues a mail to any address (needs a signed-in actor; at most 20 such mails per actor and hour).
 * Both write into the caller's request transaction, so a change that rolls back sends nothing. Mails leave the server from the worker (every minute
 * when JOBS_ENABLED is on, `processQueue()` in tests), with retry and back-off (setting `mail.retry_minutes`), then `dead` and an in-app notice to the
 * System Admins. Security alerts are queued by the database itself (sec_alert_raise) to every active System Admin.
 * With no SMTP_HOST the worker marks each mail `logged`: the System Log records the kind, the masked address and the subject (never the body).
 */
@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Mail');
  private timer: NodeJS.Timeout | undefined;
  private busy: Promise<unknown> | null = null;
  private readonly cfg: MailConfig;

  constructor(private readonly db: DbService, @Inject(APP_CONFIG) private readonly config: AppConfig, private readonly runs: JobRunsService) {
    this.cfg = config.mail ?? { enabled: false, host: '', port: 587, tls: 'starttls', fromAddress: '', fromHeader: '', rejectUnauthorized: true, timeoutMs: 15_000, heloName: 'pmis.localdomain' };
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Identifies the settings a test mail was sent with (host, port, TLS mode, sender, whether it authenticates); never a secret. */
  fingerprint(): string {
    if (!this.cfg.enabled) return 'disabled';
    return createHash('sha256').update([this.cfg.host, this.cfg.port, this.cfg.tls, this.cfg.fromAddress, this.cfg.user ?? '', this.cfg.rejectUnauthorized].join('|')).digest('hex').slice(0, 32);
  }

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    this.timer = setInterval(() => void this.processQueue(), MAIL_EVERY_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.busy) await this.busy.catch(() => undefined);
  }

  // ------------------------------------------------------------------ the interface of the other modules
  async sendToUser(userId: string, msg: MailMessage): Promise<string | null> {
    const r = await this.db.tx.$queryRaw<{ id: string | null }[]>(Prisma.sql`
      SELECT mail_send_to_user(${msg.kind}::text, ${userId}::uuid, ${msg.subject}::text, ${msg.text}::text, ${msg.dedupKey ?? null}::text, ${msg.sensitive === true}::boolean)::text AS id`);
    return r[0]?.id ?? null;
  }

  async sendToAddress(address: string, msg: MailMessage): Promise<string | null> {
    const r = await this.db.tx.$queryRaw<{ id: string | null }[]>(Prisma.sql`
      SELECT mail_send_to_address(${msg.kind}::text, ${address}::text, ${msg.subject}::text, ${msg.text}::text, ${msg.dedupKey ?? null}::text, ${msg.sensitive === true}::boolean)::text AS id`);
    return r[0]?.id ?? null;
  }

  // ------------------------------------------------------------------ the worker
  /** Sends what is due. One job_runs row (`mail_send`) per run that had mail to send. Never throws. */
  processQueue(limit = BATCH): Promise<{ claimed: number; sent: number; failed: number; logged: number }> {
    if (this.busy) return this.busy as Promise<{ claimed: number; sent: number; failed: number; logged: number }>;
    const p = this.drain(limit).finally(() => {
      this.busy = null;
    });
    this.busy = p;
    return p;
  }

  private async drain(limit: number): Promise<{ claimed: number; sent: number; failed: number; logged: number }> {
    const out = { claimed: 0, sent: 0, failed: 0, logged: 0 };
    let claimed: { id: string; kind: string; to_address: string; subject: string; body_text: string; attempts: number }[];
    try {
      claimed = await this.db.client.$transaction(async (tx) => {
        await applyContext(tx, jobContext('mail_send'));
        return tx.$queryRaw<typeof claimed>(Prisma.sql`SELECT id::text AS id, kind, to_address, subject, body_text, attempts FROM mail_claim(${limit}::int, 300::int)`);
      });
    } catch (e) {
      this.log.warn(`mail claim failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
      return out;
    }
    if (claimed.length === 0) return out;
    out.claimed = claimed.length;
    const run = await this.runs.start('mail_send');
    for (const m of claimed) {
      const r = await this.deliver(m);
      try {
        await this.db.client.$transaction(async (tx) => {
          await applyContext(tx, jobContext('mail_send'));
          await tx.$queryRaw(Prisma.sql`SELECT mail_mark(${m.id}::uuid, ${r.outcome}::text, ${r.error}::text, ${r.messageId}::text)`);
        });
      } catch (e) {
        this.log.warn(`mail mark failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
      }
      if (r.outcome === 'sent') out.sent++;
      else if (r.outcome === 'logged') out.logged++;
      else out.failed++;
    }
    await this.runs.finish(run, out.failed > 0 && out.sent === 0 && out.logged === 0 ? 'failed' : 'ok', out.claimed, out.failed > 0 ? `${out.failed} mail(s) not delivered` : null,
      { sent: out.sent, failed: out.failed, logged: out.logged, smtp: this.cfg.enabled });
    return out;
  }

  /** One attempt. Never throws; the outcome goes to mail_mark. */
  private async deliver(m: { id: string; kind: string; to_address: string; subject: string; body_text: string }): Promise<{ outcome: 'sent' | 'logged' | 'failed' | 'rejected'; error: string | null; messageId: string | null }> {
    if (!this.cfg.enabled) {
      this.log.log(`mail not sent (SMTP not configured): ${m.kind} to ${maskAddress(m.to_address)}`);
      return { outcome: 'logged', error: null, messageId: null };
    }
    try {
      const text = m.body_text.split('{{app_url}}').join(this.config.appBaseUrl ?? '');
      const r = await smtpSend(this.cfg, { to: m.to_address, subject: m.subject, text, kind: m.kind, messageId: `${m.id}@${this.cfg.fromAddress.split('@')[1] ?? 'pmis'}` });
      return { outcome: 'sent', error: null, messageId: r.messageId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      return { outcome: e instanceof SmtpError && e.permanent ? 'rejected' : 'failed', error: this.scrub(msg), messageId: null };
    }
  }

  /** No secret in a stored error: the password and user name are blanked if a server ever echoed them. */
  private scrub(s: string): string {
    let out = s.slice(0, 300);
    for (const secret of [this.cfg.pass, this.cfg.user]) if (secret && secret.length >= 3) out = out.split(secret).join('***');
    return out;
  }

  // ------------------------------------------------------------------ the admin endpoints
  private async requireOps(): Promise<void> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT mail_can_read() AS ok`;
    if (!r[0]?.ok) throw new ProblemException(403, 'action_forbidden', { detail: 'A System Admin (or view on admin.system_log) is needed.' });
  }

  async status() {
    await this.requireOps();
    const s = (await this.db.tx.$queryRaw<{ j: Record<string, unknown> }[]>(Prisma.sql`SELECT mail_stats(${this.fingerprint()}::text) AS j`))[0]!.j;
    const n = (k: string): number => Number(s[k] ?? 0);
    const verifiedAt = (s.verified_at as string | null) ?? null;
    return {
      enabled: this.cfg.enabled,
      // the channel is described as working only after a test mail went out with these settings (owner answer Q167)
      state: !this.cfg.enabled ? 'disabled' : n('dead_24h') > 0 ? 'failing' : verifiedAt ? 'verified' : 'unverified',
      settings: this.cfg.enabled
        ? { host: this.cfg.host, port: this.cfg.port, tls: this.cfg.tls, from: this.cfg.fromHeader, auth: !!this.cfg.user, verify_certificate: this.cfg.rejectUnauthorized }
        : null,
      verified_at: verifiedAt,
      counts: { queued: n('queued'), retrying: n('retrying'), sending: n('sending'), dead: n('dead'), dead_24h: n('dead_24h'), sent_24h: n('sent_24h'),
        logged_24h: n('logged_24h'), suppressed_24h: n('suppressed_24h') },
      last_sent_at: (s.last_sent_at as string | null) ?? null,
      last_error: (s.last_error as string | null) ?? null,
    };
  }

  /** Sends a test mail to the caller now, inside the request, and answers the outcome (System Admin; audited). */
  async test(auth: AuthContext) {
    if (!auth.state.isAdmin) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin can send a test mail.' });
    if (!this.cfg.enabled) throw new ProblemException(422, 'mail_not_configured', { detail: 'SMTP is not configured on the server (SMTP_HOST and SMTP_FROM in the env file).' });
    const subject = '[PMIS] Test mail / رسالة اختبار';
    const text = `This is a test mail of GSDN PMIS, sent by ${auth.user.displayName}.\nهذه رسالة اختبار من نظام GSDN PMIS.\n\nServer: ${this.cfg.host}:${this.cfg.port} (${this.cfg.tls})\nTime: ${new Date().toISOString()}`;
    const id = (await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT mail_test_enqueue(${this.fingerprint()}::text, ${subject}::text, ${text}::text)::text AS id`))[0]!.id;
    const claimed = await this.db.tx.$queryRaw<{ id: string; kind: string; to_address: string; subject: string; body_text: string; attempts: number }[]>(Prisma.sql`
      SELECT id::text AS id, kind, to_address, subject, body_text, attempts FROM mail_claim(1, 60, ${id}::uuid)`);
    const m = claimed[0];
    if (!m) throw new ProblemException(409, 'invalid_transition', { detail: 'The test mail could not be taken from the queue.' });
    const r = await this.deliver(m);
    // a failed test is final (no retry): the admin sees the error now
    const st = (await this.db.tx.$queryRaw<{ s: string }[]>(Prisma.sql`SELECT mail_mark(${id}::uuid, ${r.outcome === 'failed' ? 'rejected' : r.outcome}::text, ${r.error}::text, ${r.messageId}::text) AS s`))[0]?.s;
    return { mail_id: id, outcome: st === 'sent' ? 'sent' : 'failed', error: r.error, to: maskAddress(m.to_address) };
  }

  async outbox(q: Query) {
    const limit = parseLimit(q.limit);
    const status = oneParam(q, 'status');
    if (status && !(OUTCOMES as readonly string[]).includes(status)) throw problems.validation([{ path: '/status', code: 'invalid', message: `status is one of ${OUTCOMES.join(', ')}.` }]);
    const kind = oneParam(q, 'kind');
    if (kind && !/^[a-z][a-z0-9_.]{1,59}$/.test(kind)) throw problems.validation([{ path: '/kind', code: 'invalid', message: 'kind is a lower-case code.' }]);
    const c = decodeCursor(oneParam(q, 'cursor'), 2);
    if (c && (!TS_RE.test(c[0] as string) || !uuidSchema.safeParse(c[1]).success)) throw problems.badRequest('The cursor is not valid.');
    const f = { ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...(c ? { cursor_at: c[0], cursor_id: c[1] } : {}) };
    const rows = await this.db.tx.$queryRaw<{ id: string; created_text: string; kind: string; to_address: string; to_user_id: string | null; subject: string; sensitive: boolean;
      status: string; attempts: number; next_attempt_at: Date; last_error: string | null; sent_at: Date | null }[]>(Prisma.sql`
      SELECT m.id::text AS id, log_ts_text(m.created_at) AS created_text, m.kind, m.to_address, m.to_user_id::text AS to_user_id, m.subject, m.sensitive, m.status, m.attempts,
             m.next_attempt_at, m.last_error, m.sent_at
      FROM mail_outbox_read(${JSON.stringify(f)}::jsonb, ${limit + 1}::int) m`);
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id, created_at: r.created_text, kind: r.kind, to: r.to_address, to_user_id: r.to_user_id, subject: r.subject, sensitive: r.sensitive,
      status: r.status === 'queued' && r.attempts > 0 ? 'retrying' : r.status, attempts: r.attempts,
      next_attempt_at: r.status === 'queued' ? r.next_attempt_at : null, last_error: r.last_error, sent_at: r.sent_at,
    }));
    const last = items[items.length - 1];
    return { items, page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null } };
  }

  async retry(id: string, raw: unknown) {
    const { reason } = parse(retryBody, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The mail does not exist.');
    await this.db.tx.$queryRaw(Prisma.sql`SELECT mail_retry(${id}::uuid, ${reason}::text)`);
    return { id, status: 'queued' };
  }

  /** For the health check: words only. */
  async healthWord(): Promise<'ok' | 'disabled' | 'unverified' | 'failing'> {
    if (!this.cfg.enabled) return 'disabled';
    const s = (await this.db.client.$queryRaw<{ j: Record<string, unknown> }[]>(Prisma.sql`SELECT mail_stats(${this.fingerprint()}::text) AS j`))[0]!.j;
    if (Number(s.dead_24h ?? 0) > 0) return 'failing';
    return s.verified_at || s.last_sent_at ? 'ok' : 'unverified';
  }
}

export function maskAddress(a: string): string {
  const i = a.indexOf('@');
  return i < 1 ? '***' : `${a[0]}***${a.slice(i)}`;
}
