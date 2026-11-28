import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { decryptSecret, encryptSecret, parseEncKey } from "../auth/totp";
import { parseIfMatch } from "../common/etag";
import { problems } from "../common/problem";
import { parse, uuidSchema } from "../common/zod";
import { APP_CONFIG, AppConfig } from "../config/config";
import { DbService } from "../db/db.service";
import { applyContext, jobContext } from "../logs/context";
import { JobRunsService } from "../logs/job-runs.service";
import { outboundArchiveSchema, outboundDestinationSchema, outboundEnabledPutSchema } from "./outbound.schema";

const EVERY_MS = 30_000;
const TIMEOUT_MS = 10_000;

/** True for an address a webhook must never reach: loopback, private, link-local, unspecified, multicast, carrier-grade NAT, unique-local. */
export function isBlockedAddress(addr: string): boolean {
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0)
    );
  }
  const l = addr.toLowerCase();
  return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb") || l.startsWith("ff");
}

/** The URL is https and every address its host resolves to is public. Returns an error text, or null when it may be called. */
export async function checkWebhookUrl(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "https only";
  if (u.username || u.password) return "no credentials in the URL";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isBlockedAddress(host) ? "address not allowed" : null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "address not allowed";
  try {
    const all = await lookup(host, { all: true });
    if (all.length === 0 || all.some((a) => isBlockedAddress(a.address))) return "address not allowed";
  } catch {
    return "host not found";
  }
  return null;
}

/** HMAC-SHA256 over `<timestamp>.<body>`, hex. The receiver recomputes it with the shared secret. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

interface OverviewJson {
  enabled: boolean;
  version: number;
  [k: string]: unknown;
}

/**
 * D8 (contract 0.15.475): outbound notifications to a webhook or an email address, off by default. The admin doors need admin.settings. The secret of a webhook is
 * encrypted with the existing key (AES-256-GCM, the destination id is the authenticated data) and is never returned. The worker posts the queued deliveries.
 */
@Injectable()
export class OutboundService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger("outbound");
  private timer: NodeJS.Timeout | undefined;
  private busy: Promise<unknown> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly runs: JobRunsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    this.timer = setInterval(() => void this.processQueue(), EVERY_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.busy) await this.busy.catch(() => undefined);
  }

  private key(): Buffer {
    const k = parseEncKey(this.config.totpEncKey);
    if (!k) throw problems.badRequest("The encryption key is not configured.");
    return k;
  }

  /** GET /settings/integrations/outbound */
  async overview(auth: AuthContext) {
    void auth;
    await this.access.requireAdmin("admin.settings", "view");
    const r = await this.db.tx.$queryRaw<{ j: OverviewJson }[]>`SELECT admin_outbound_overview() AS j`;
    return r[0]!.j;
  }

  /** PUT /settings/integrations/outbound/enabled */
  async setEnabled(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(outboundEnabledPutSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: OverviewJson }[]>(Prisma.sql`
      SELECT admin_save_outbound_enabled(${b.enabled}::boolean, ${b.reason}::text, ${version}::int) AS j`);
    return r[0]!.j;
  }

  /** POST (id undefined) and PUT /settings/integrations/outbound/destinations[/:id] */
  async saveDestination(_auth: AuthContext, id: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const b = parse(outboundDestinationSchema, raw);
    const did = id ? parse(uuidSchema, id) : randomUUID();
    if (b.kind === "webhook") {
      if (!b.target.startsWith("https://")) throw problems.validation([{ path: "/target", code: "invalid", message: "An https URL." }]);
      const bad = await checkWebhookUrl(b.target);
      if (bad) throw problems.validation([{ path: "/target", code: "invalid", message: bad }]);
    }
    const enc = b.kind === "webhook" && b.secret ? encryptSecret(this.key(), did, Buffer.from(b.secret, "utf8")) : null;
    const r = await this.db.tx.$queryRaw<{ j: OverviewJson }[]>(Prisma.sql`
      SELECT admin_save_outbound_destination(${did}::uuid, ${b.kind}::text, ${b.label}::text, ${b.target}::text, ${enc}::text,
        ${b.events}::text[], ${b.active}::boolean, ${b.reason}::text) AS j`);
    return r[0]!.j;
  }

  /** POST /settings/integrations/outbound/destinations/:id/archive */
  async archive(_auth: AuthContext, id: string, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const did = parse(uuidSchema, id);
    const b = parse(outboundArchiveSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: OverviewJson }[]>(Prisma.sql`
      SELECT admin_archive_outbound_destination(${did}::uuid, ${b.archived}::boolean, ${b.reason}::text) AS j`);
    return r[0]!.j;
  }

  /** GET /settings/integrations/outbound/deliveries */
  async deliveries(auth: AuthContext) {
    void auth;
    await this.access.requireAdmin("admin.settings", "view");
    const r = await this.db.tx.$queryRaw<{ j: unknown }[]>`SELECT admin_outbound_deliveries(100::int) AS j`;
    return { items: r[0]!.j };
  }

  // ------------------------------------------------------------------ the worker
  /** Posts what is due. One job_runs row (`outbound_send`) per run that had something to send. Never throws. */
  processQueue(): Promise<{ claimed: number; sent: number; failed: number }> {
    if (this.busy) return this.busy as Promise<{ claimed: number; sent: number; failed: number }>;
    const p = this.drain().finally(() => {
      this.busy = null;
    });
    this.busy = p;
    return p;
  }

  private async drain(): Promise<{ claimed: number; sent: number; failed: number }> {
    const out = { claimed: 0, sent: 0, failed: 0 };
    let claimed: { id: string; destination_id: string; url: string; secret_enc: string; payload: unknown }[];
    try {
      claimed = await this.db.client.$transaction(async (tx) => {
        await applyContext(tx, jobContext("outbound_send"));
        return tx.$queryRaw<typeof claimed>(Prisma.sql`SELECT id::text AS id, destination_id::text AS destination_id, url, secret_enc, payload FROM outbound_claim(10::int)`);
      });
    } catch (e) {
      this.log.warn(`outbound claim failed: ${e instanceof Error ? e.message.split("\n")[0] : "unknown"}`);
      return out;
    }
    if (claimed.length === 0) return out;
    out.claimed = claimed.length;
    const run = await this.runs.start("outbound_send");
    for (const d of claimed) {
      const r = await this.post(d);
      try {
        await this.db.client.$transaction(async (tx) => {
          await applyContext(tx, jobContext("outbound_send"));
          await tx.$queryRaw(Prisma.sql`SELECT outbound_mark(${d.id}::uuid, ${r.ok}::boolean, ${r.http}::int, ${r.error}::text)`);
        });
      } catch (e) {
        this.log.warn(`outbound mark failed: ${e instanceof Error ? e.message.split("\n")[0] : "unknown"}`);
      }
      if (r.ok) out.sent++;
      else out.failed++;
    }
    await this.runs.finish(run, out.failed > 0 && out.sent === 0 ? "failed" : "ok", out.claimed, out.failed > 0 ? `${out.failed} webhook(s) not delivered` : null, { sent: out.sent, failed: out.failed });
    return out;
  }

  /** One attempt. Never throws. The URL is checked again here (the DNS answer may have changed); redirects are not followed. */
  private async post(d: { destination_id: string; url: string; secret_enc: string; payload: unknown }): Promise<{ ok: boolean; http: number | null; error: string | null }> {
    try {
      const bad = await checkWebhookUrl(d.url);
      if (bad) return { ok: false, http: null, error: bad };
      const secret = decryptSecret(this.key(), d.destination_id, d.secret_enc).toString("utf8");
      const body = JSON.stringify(d.payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(d.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json", "x-gsdn-timestamp": ts, "x-gsdn-signature": `sha256=${signPayload(secret, ts, body)}` },
        body,
      });
      return res.status >= 200 && res.status < 300 ? { ok: true, http: res.status, error: null } : { ok: false, http: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, http: null, error: e instanceof Error ? e.name === "TimeoutError" ? "timeout" : "request failed" : "request failed" };
    }
  }
}
