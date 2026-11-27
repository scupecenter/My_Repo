import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import webpush from 'web-push';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { JobRunsService } from '../logs/job-runs.service';
import { RegistersService } from '../registers/registers.service';

export const PUSH_EVERY_MS = 30_000;
export const PUSH_BATCH = 50;
/** The whole message a browser receives. Nothing about a site, task or record: the inbox shows the detail after sign-in, with its own filters. */
export const PUSH_PAYLOAD = JSON.stringify({ type: 'notification', url: '/inbox' });

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048).refine((u) => u.startsWith('https://'), 'must be https'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }).strict(),
  user_agent: z.string().max(300).optional(),
}).strict();
const endpointSchema = z.object({ endpoint: z.string().url().max(2048) }).strict();

interface Due { sub_id: string; endpoint: string; p256dh: string; auth: string; newest: string; n: number }
export type PushSend = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<{ statusCode: number }>;

/**
 * Web Push for field engineers (item 13, contract 0.15.156). Off until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are set in the environment;
 * the keys are never created or stored by the app. A person manages only their own browsers (definer doors, own rows). The sender job runs only
 * when JOBS_ENABLED is on and push is configured: it finds browsers with new unread in-app notifications and sends the fixed payload above. The bell and
 * the e-mail are not touched.
 */
@Injectable()
export class PushService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Push');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Replaced in tests. */
  send: PushSend;

  constructor(
    private readonly db: DbService,
    private readonly runs: JobRunsService,
    private readonly registers: RegistersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.send = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'normal', vapidDetails: { subject: config.webPush.subject, publicKey: config.webPush.publicKey, privateKey: config.webPush.privateKey } });
  }

  get enabled(): boolean { return this.config.webPush.enabled; }

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled || !this.enabled) return;
    this.timer = setInterval(() => { void this.sendDue().catch((e: unknown) => this.log.warn(`web push failed: ${e instanceof Error ? e.message : 'error'}`)); }, PUSH_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What the browser needs to subscribe. The public key is public by design; the private key never leaves the server. */
  config_(): { enabled: boolean; public_key: string | null } {
    return { enabled: this.enabled, public_key: this.enabled ? this.config.webPush.publicKey : null };
  }

  async myStatus(auth: AuthContext, endpoint: string | undefined): Promise<Record<string, unknown>> {
    const r = await this.registers.call<{ count: number; this_browser: boolean }>(auth, Prisma.sql`SELECT push_my_status(${endpoint ?? null}::text) AS r`);
    return { ...this.config_(), ...r };
  }

  async subscribe(auth: AuthContext, raw: unknown): Promise<Record<string, unknown>> {
    if (!this.enabled) throw new ProblemException(409, 'invalid_transition', { detail: 'Web Push is not configured on this server.' });
    const b = parse(subscribeSchema, raw);
    return this.registers.call<Record<string, unknown>>(auth, Prisma.sql`SELECT push_subscribe(${b.endpoint}::text, ${b.keys.p256dh}::text, ${b.keys.auth}::text, ${b.user_agent ?? null}::text) AS r`);
  }

  async unsubscribe(auth: AuthContext, raw: unknown): Promise<Record<string, unknown>> {
    const b = parse(endpointSchema, raw);
    return this.registers.call<Record<string, unknown>>(auth, Prisma.sql`SELECT push_unsubscribe(${b.endpoint}::text) AS r`);
  }

  async adminStatus(auth: AuthContext): Promise<Record<string, unknown>> {
    const r = await this.registers.call<Record<string, unknown>>(auth, Prisma.sql`SELECT push_admin_status_json() AS r`);
    return { enabled: this.enabled, ...r };
  }

  /** One pass of the sender. Returns how many browsers were pushed and how many failed. */
  async sendDue(): Promise<{ sent: number; failed: number }> {
    if (!this.enabled || this.busy) return { sent: 0, failed: 0 };
    this.busy = true;
    try {
      const rows = await this.db.client.$queryRaw<Due[]>(Prisma.sql`SELECT sub_id, endpoint, p256dh, auth, newest::text AS newest, n FROM push_due(${PUSH_BATCH}::int)`);
      if (rows.length === 0) return { sent: 0, failed: 0 };
      const id = await this.runs.start('web_push');
      let sent = 0, failed = 0;
      for (const r of rows) {
        let outcome: 'ok' | 'gone' | 'failed' = 'ok';
        try {
          await this.send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, PUSH_PAYLOAD);
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          outcome = code === 404 || code === 410 ? 'gone' : 'failed';
        }
        await this.db.client.$executeRaw(Prisma.sql`SELECT push_mark(${r.sub_id}::uuid, ${r.newest}::timestamptz, ${outcome}::text)`);
        if (outcome === 'ok') sent++; else failed++;
      }
      await this.runs.finish(id, failed > 0 ? 'failed' : 'ok', sent, failed > 0 ? `${failed} push(es) failed` : null, { sent, failed });
      return { sent, failed };
    } finally {
      this.busy = false;
    }
  }
}
